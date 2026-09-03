/**
 * Tier 2: a bank (or non-bank wallet provider) that distributes e₹.
 *
 * The bank onboards customers, holds custodial wallet keys for this sandbox,
 * enforces KYC-tiered limits, loads and unloads e₹ against the customer's
 * account, routes P2P and P2M payments through the core, disburses
 * purpose-bound scheme money, and settles offline vouchers.
 *
 * Every state change is written to an audit trail with actor, request id,
 * before and after balances, and the outcome.
 */
import { generateKeyPair, signCanonical, type KeyPair } from "./crypto.js";
import type { CoreClient } from "./core-client.js";
import { LedgerError, signingPayload, type Output, type Token, type TransferRequest, type WalletKind, type WalletRecord } from "./ledger.js";
import { assertPaise, rupees, sum } from "./money.js";
import type { TokenRules } from "./rules.js";
import { parseUpiQr } from "./upi.js";
import { verifyVoucher, voucherHash, type Voucher } from "./offline.js";

export type KycTier = "min" | "full";

/** Sandbox limits. Real limits are set by the RBI and the bank. */
export const KYC_LIMITS: Record<KycTier, { balanceCap: number; dailyOutCap: number }> = {
  min: { balanceCap: rupees(10_000), dailyOutCap: rupees(5_000) },
  full: { balanceCap: rupees(200_000), dailyOutCap: rupees(100_000) },
};

export interface Wallet {
  id: string;
  bankId: string;
  name: string;
  kind: WalletKind;
  kyc: KycTier;
  publicKey: string;
  vpa?: string;
  mcc?: string;
  frozen: boolean;
  frozenReason?: string;
  /** Simulated core-banking account balance in paise, the source and sink for load/unload. */
  accountBalance: number;
  createdAt: string;
}

export interface BalanceView {
  available: number;
  byPurpose: Record<string, number>;
  offline: number;
  total: number;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  walletId: string;
  requestId: string;
  outcome: "ok" | "rejected";
  detail: Record<string, unknown>;
}

export type BankErrorCode =
  | "UNKNOWN_WALLET"
  | "WRONG_BANK"
  | "FROZEN"
  | "KYC_BALANCE_CAP"
  | "KYC_DAILY_CAP"
  | "INSUFFICIENT_ACCOUNT"
  | "INSUFFICIENT_FUNDS"
  | "INSUFFICIENT_OFFLINE"
  | "NOT_MERCHANT"
  | "NOT_SCHEME"
  | "NOT_PAYABLE"
  | "AMOUNT_MISMATCH"
  | "AMOUNT_REQUIRED"
  | "BAD_VOUCHER"
  | "DOUBLE_SPEND"
  | "OVERSPEND"
  | "DUPLICATE_VOUCHER";

export class BankError extends Error {
  constructor(
    readonly code: BankErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BankError";
  }
}

export interface CreateWalletInput {
  id?: string;
  name: string;
  kind?: Exclude<WalletKind, "pool" | "escrow">;
  kyc?: KycTier;
  vpa?: string;
  mcc?: string;
  accountBalance?: number;
}

export interface VoucherResult {
  voucherId: string;
  ok: boolean;
  code?: BankErrorCode;
  message?: string;
  txId?: string;
}

export interface BankOptions {
  clock?: () => Date;
  openingReserve?: number;
}

export class BankTier {
  private readonly wallets = new Map<string, Wallet>();
  private readonly keys = new Map<string, KeyPair>();
  private readonly audit: AuditEntry[] = [];
  private readonly dailyOut = new Map<string, { day: string; total: number }>();
  private readonly offlineEscrow = new Map<string, number>();
  private readonly acceptedVouchers = new Map<string, { hash: string; voucherId: string }>();
  private readonly seenVoucherIds = new Set<string>();
  private readonly clock: () => Date;

  private constructor(
    readonly bankId: string,
    readonly core: CoreClient,
    private readonly pool: KeyPair,
    private readonly escrow: KeyPair,
    clock: () => Date,
  ) {
    this.clock = clock;
  }

  /** Registers the bank, its pool wallet and its offline escrow wallet with the core. */
  static async create(bankId: string, core: CoreClient, opts: BankOptions = {}): Promise<BankTier> {
    const pool = generateKeyPair();
    const escrow = generateKeyPair();
    await core.registerBank(bankId, pool.publicKey, opts.openingReserve ?? rupees(1_000_000));
    await core.registerWallet({
      walletId: `${bankId}:offline-escrow`,
      bankId,
      publicKey: escrow.publicKey,
      kind: "escrow",
      name: `${bankId} offline escrow`,
      frozen: false,
    });
    return new BankTier(bankId, core, pool, escrow, opts.clock ?? (() => new Date()));
  }

  get poolPublicKey(): string {
    return this.pool.publicKey;
  }

  /** Sign an issue request for the RBI to approve; the bank asks, the central bank signs. */
  issueRequestFor(amount: number, idempotencyKey: string): { bankId: string; amount: number; idempotencyKey: string } {
    assertPaise(amount);
    return { bankId: this.bankId, amount, idempotencyKey };
  }

  async redeem(amount: number, requestId: string): Promise<{ txId: string; amount: number }> {
    const tokens = await this.core.unspentOf(this.pool.publicKey);
    const inputs = pickInputs(tokens, amount, (t) => !t.rules);
    // Redeem whole tokens only; put change back through a transfer to keep inputs exact.
    const total = sum(inputs.map((t) => t.amount));
    let redeemable = inputs;
    if (total !== amount) {
      // Split first so the redeem inputs add up exactly. Outputs are created in
      // order, so the leading tokens of the split are the `amount` output.
      const split = await this.core.transfer(
        this.signedTransfer(this.pool, inputs, [
          { owner: this.pool.publicKey, amount },
          { owner: this.pool.publicKey, amount: total - amount },
        ], `${requestId}:split`),
      );
      redeemable = [];
      let acc = 0;
      for (const t of split.outputs) {
        if (acc >= amount) break;
        redeemable.push(t);
        acc += t.amount;
      }
    }
    const unsigned = { bankId: this.bankId, inputs: redeemable.map((t) => t.id), idempotencyKey: requestId, signature: "" };
    const signature = signCanonical(this.pool.privateKey, signingPayload("redeem", unsigned));
    return this.core.redeem({ ...unsigned, signature });
  }

  // ------------------------------------------------------------------ wallets

  async createWallet(input: CreateWalletInput): Promise<Wallet> {
    const kind = input.kind ?? "person";
    if (kind === "merchant" && !input.mcc) throw new BankError("NOT_MERCHANT", "merchant wallets need an MCC");
    const id = input.id ? `${this.bankId}:${input.id}` : `${this.bankId}:${slug(input.name)}`;
    if (this.wallets.has(id)) throw new BankError("UNKNOWN_WALLET", `wallet ${id} already exists`);
    const keys = generateKeyPair();
    const record: WalletRecord = {
      walletId: id,
      bankId: this.bankId,
      publicKey: keys.publicKey,
      kind,
      name: input.name,
      frozen: false,
      ...(input.vpa ? { vpa: input.vpa } : {}),
      ...(input.mcc ? { mcc: input.mcc } : {}),
    };
    await this.core.registerWallet(record);
    const wallet: Wallet = {
      id,
      bankId: this.bankId,
      name: input.name,
      kind,
      kyc: kind === "person" ? (input.kyc ?? "min") : "full",
      publicKey: keys.publicKey,
      frozen: false,
      accountBalance: input.accountBalance ?? 0,
      createdAt: this.clock().toISOString(),
      ...(input.vpa ? { vpa: input.vpa } : {}),
      ...(input.mcc ? { mcc: input.mcc } : {}),
    };
    this.wallets.set(id, wallet);
    this.keys.set(id, keys);
    this.record("bank", "wallet.create", id, id, "ok", { kind, kyc: wallet.kyc });
    return { ...wallet };
  }

  wallet(id: string): Wallet {
    const w = this.wallets.get(id);
    if (!w) throw new BankError("UNKNOWN_WALLET", `unknown wallet ${id} at ${this.bankId}`);
    return { ...w };
  }

  listWallets(): Wallet[] {
    return [...this.wallets.values()].map((w) => ({ ...w }));
  }

  publicKeyOf(id: string): string | undefined {
    return this.wallets.get(id)?.publicKey;
  }

  /** Sandbox only: the bank is custodial, so a device "enrols" by borrowing the wallet key. */
  exportKeys(id: string): KeyPair {
    const keys = this.keys.get(id);
    if (!keys) throw new BankError("UNKNOWN_WALLET", `unknown wallet ${id} at ${this.bankId}`);
    return keys;
  }

  async balance(id: string): Promise<BalanceView> {
    const w = this.wallet(id);
    const tokens = await this.core.unspentOf(w.publicKey);
    const byPurpose: Record<string, number> = {};
    let available = 0;
    for (const t of tokens) {
      if (t.rules) byPurpose[t.rules.purpose] = (byPurpose[t.rules.purpose] ?? 0) + t.amount;
      else available += t.amount;
    }
    const offline = this.offlineEscrow.get(id) ?? 0;
    return { available, byPurpose, offline, total: available + sum(Object.values(byPurpose)) + offline };
  }

  async freeze(id: string, reason: string): Promise<void> {
    const w = this.mutableWallet(id);
    w.frozen = true;
    w.frozenReason = reason;
    await this.core.setFrozen(id, true);
    this.record("bank", "wallet.freeze", id, `freeze:${id}:${this.clock().getTime()}`, "ok", { reason });
  }

  async unfreeze(id: string, requestId: string): Promise<void> {
    const w = this.mutableWallet(id);
    w.frozen = false;
    delete w.frozenReason;
    await this.core.setFrozen(id, false);
    this.record("bank", "wallet.unfreeze", id, requestId, "ok", {});
  }

  // ------------------------------------------------------------- load/unload

  /** Move value from the customer's bank account into e₹ (tokens from the bank pool). */
  async load(id: string, amount: number, requestId: string): Promise<{ txId: string }> {
    assertPaise(amount);
    const w = this.mutableWallet(id);
    return this.guarded("wallet.load", id, requestId, { amount }, async () => {
      this.requireActive(w);
      await this.requireBalanceCap(w, amount);
      if (w.accountBalance < amount) {
        throw new BankError("INSUFFICIENT_ACCOUNT", `account balance ${w.accountBalance} < ${amount}`);
      }
      const poolTokens = await this.core.unspentOf(this.pool.publicKey);
      const inputs = pickInputs(poolTokens, amount, (t) => !t.rules);
      const res = await this.core.transfer(
        this.signedTransfer(this.pool, inputs, outputsFor(this.pool.publicKey, w.publicKey, inputs, amount), requestId, `load ${id}`),
      );
      w.accountBalance -= amount;
      return { txId: res.txId };
    });
  }

  /** Move e₹ back into the customer's bank account. */
  async unload(id: string, amount: number, requestId: string): Promise<{ txId: string }> {
    assertPaise(amount);
    const w = this.mutableWallet(id);
    return this.guarded("wallet.unload", id, requestId, { amount }, async () => {
      this.requireActive(w);
      const keys = this.keys.get(id)!;
      const tokens = await this.core.unspentOf(w.publicKey);
      const inputs = pickInputs(tokens, amount, (t) => !t.rules);
      const res = await this.core.transfer(
        this.signedTransfer(keys, inputs, outputsFor(w.publicKey, this.pool.publicKey, inputs, amount), requestId, `unload ${id}`),
      );
      w.accountBalance += amount;
      return { txId: res.txId };
    });
  }

  // ---------------------------------------------------------------- payments

  /** Person to person, same bank or cross-bank. Cross-bank recipients are resolved through the core directory. */
  async payP2P(input: { from: string; to: string; amount: number; note?: string; requestId: string }): Promise<{ txId: string }> {
    assertPaise(input.amount);
    const w = this.mutableWallet(input.from);
    return this.guarded("pay.p2p", input.from, input.requestId, { to: input.to, amount: input.amount }, async () => {
      this.requireActive(w);
      const recipient = await this.core.lookupWallet(input.to);
      if (!recipient) throw new BankError("UNKNOWN_WALLET", `unknown recipient ${input.to}`);
      if (recipient.kind !== "person" && recipient.kind !== "merchant") {
        throw new BankError("NOT_PAYABLE", `${input.to} does not accept P2P payments`);
      }
      this.requireDailyCap(w, input.amount);
      if (recipient.bankId === this.bankId) await this.requireBalanceCap(this.mutableWallet(recipient.walletId), input.amount);
      const keys = this.keys.get(input.from)!;
      const tokens = await this.core.unspentOf(w.publicKey);
      const inputs = pickInputs(tokens, input.amount, (t) => !t.rules);
      const res = await this.core.transfer(
        this.signedTransfer(keys, inputs, outputsFor(w.publicKey, recipient.publicKey, inputs, input.amount), input.requestId, input.note),
      );
      this.addDailyOut(w.id, input.amount);
      return { txId: res.txId };
    });
  }

  /**
   * Pay a merchant by scanning a standard UPI QR. With `purpose` set, the payment
   * is made from purpose-bound scheme tokens and the core enforces their rules.
   */
  async payQr(input: {
    from: string;
    qr: string;
    amount?: number;
    purpose?: string;
    location?: { lat: number; lng: number };
    requestId: string;
  }): Promise<{ txId: string; vpa: string; amount: number }> {
    const w = this.mutableWallet(input.from);
    return this.guarded("pay.qr", input.from, input.requestId, { qr: input.qr, purpose: input.purpose ?? null }, async () => {
      this.requireActive(w);
      const intent = parseUpiQr(input.qr);
      if (intent.amount !== undefined && input.amount !== undefined && intent.amount !== input.amount) {
        throw new BankError("AMOUNT_MISMATCH", `QR fixes the amount at ${intent.amount}`);
      }
      const amount = input.amount ?? intent.amount;
      if (amount === undefined) throw new BankError("AMOUNT_REQUIRED", "QR has no amount; pass one");
      assertPaise(amount);
      const merchant = await this.core.lookupVpa(intent.vpa);
      if (!merchant) throw new BankError("UNKNOWN_WALLET", `no wallet behind ${intent.vpa}`);
      if (merchant.kind !== "merchant") throw new BankError("NOT_MERCHANT", `${intent.vpa} is not a merchant`);
      this.requireDailyCap(w, amount);
      const keys = this.keys.get(input.from)!;
      const tokens = await this.core.unspentOf(w.publicKey);
      const purpose = input.purpose;
      const inputs = purpose
        ? pickInputs(tokens, amount, (t) => t.rules?.purpose === purpose)
        : pickInputs(tokens, amount, (t) => !t.rules);
      const req = this.signedTransfer(
        keys,
        inputs,
        outputsFor(w.publicKey, merchant.publicKey, inputs, amount),
        input.requestId,
        intent.note ?? `pay ${intent.vpa}`,
        { at: this.clock().toISOString(), ...(input.location ? { location: input.location } : {}) },
      );
      const res = await this.core.transfer(req);
      this.addDailyOut(w.id, amount);
      return { txId: res.txId, vpa: intent.vpa, amount };
    });
  }

  /** A scheme wallet hands out purpose-bound tokens (direct benefit transfer). */
  async disburse(input: {
    schemeWalletId: string;
    to: string;
    amount: number;
    rules: Omit<TokenRules, "returnTo">;
    requestId: string;
  }): Promise<{ txId: string }> {
    assertPaise(input.amount);
    const scheme = this.mutableWallet(input.schemeWalletId);
    return this.guarded("scheme.disburse", input.schemeWalletId, input.requestId, { to: input.to, amount: input.amount, purpose: input.rules.purpose }, async () => {
      if (scheme.kind !== "scheme") throw new BankError("NOT_SCHEME", `${scheme.id} is not a scheme wallet`);
      this.requireActive(scheme);
      const beneficiary = await this.core.lookupWallet(input.to);
      if (!beneficiary) throw new BankError("UNKNOWN_WALLET", `unknown beneficiary ${input.to}`);
      const keys = this.keys.get(scheme.id)!;
      const tokens = await this.core.unspentOf(scheme.publicKey);
      const inputs = pickInputs(tokens, input.amount, (t) => !t.rules);
      const rules: TokenRules = { ...input.rules, returnTo: scheme.publicKey };
      const change = sum(inputs.map((t) => t.amount)) - input.amount;
      const outputs: Output[] = [{ owner: beneficiary.publicKey, amount: input.amount, rules }];
      if (change > 0) outputs.push({ owner: scheme.publicKey, amount: change });
      const res = await this.core.transfer(this.signedTransfer(keys, inputs, outputs, input.requestId, `disburse ${rules.purpose}`));
      return { txId: res.txId };
    });
  }

  // ----------------------------------------------------------------- offline

  /** Park tokens in escrow so the device can spend that much offline. */
  async prefundOffline(id: string, amount: number, requestId: string): Promise<{ txId: string; offline: number }> {
    assertPaise(amount);
    const w = this.mutableWallet(id);
    return this.guarded("offline.prefund", id, requestId, { amount }, async () => {
      this.requireActive(w);
      const keys = this.keys.get(id)!;
      const tokens = await this.core.unspentOf(w.publicKey);
      const inputs = pickInputs(tokens, amount, (t) => !t.rules);
      const res = await this.core.transfer(
        this.signedTransfer(keys, inputs, outputsFor(w.publicKey, this.escrow.publicKey, inputs, amount), requestId, `offline prefund ${id}`),
      );
      const offline = (this.offlineEscrow.get(id) ?? 0) + amount;
      this.offlineEscrow.set(id, offline);
      return { txId: res.txId, offline };
    });
  }

  /**
   * Settle vouchers issued by this bank's customers. Detection rules:
   * - same payer and counter with a different voucher hash: DOUBLE_SPEND, payer frozen
   * - vouchers beyond the payer's escrow: OVERSPEND, payer frozen
   * - a voucher seen before: DUPLICATE_VOUCHER, no effect (sync is idempotent)
   */
  async syncVouchers(vouchers: Voucher[], requestId: string): Promise<VoucherResult[]> {
    const results: VoucherResult[] = [];
    for (const [i, v] of vouchers.entries()) {
      const rid = `${requestId}:${i}`;
      try {
        results.push(await this.settleVoucher(v, rid));
      } catch (err) {
        const code = err instanceof BankError ? err.code : "BAD_VOUCHER";
        const message = err instanceof Error ? err.message : String(err);
        this.record("bank", "offline.sync", v.from, rid, "rejected", { voucherId: v.id, code, message });
        results.push({ voucherId: v.id, ok: false, code, message });
      }
    }
    return results;
  }

  private async settleVoucher(v: Voucher, requestId: string): Promise<VoucherResult> {
    const payer = this.wallets.get(v.from);
    if (!payer) throw new BankError("WRONG_BANK", `voucher payer ${v.from} is not a customer of ${this.bankId}`);
    if (v.fromKey !== payer.publicKey || !verifyVoucher(v)) throw new BankError("BAD_VOUCHER", `voucher ${v.id} fails verification`);
    if (this.seenVoucherIds.has(v.id)) throw new BankError("DUPLICATE_VOUCHER", `voucher ${v.id} already settled`);

    const key = `${v.from}#${v.counter}`;
    const hash = voucherHash(v);
    const prior = this.acceptedVouchers.get(key);
    if (prior && prior.hash !== hash) {
      await this.freeze(v.from, `double-spend: counter ${v.counter} reused (${prior.voucherId} vs ${v.id})`);
      throw new BankError("DOUBLE_SPEND", `voucher ${v.id} reuses counter ${v.counter} of ${prior.voucherId}`, { counter: v.counter });
    }
    const escrow = this.offlineEscrow.get(v.from) ?? 0;
    if (v.amount > escrow) {
      await this.freeze(v.from, `overspend: voucher ${v.id} for ${v.amount} exceeds escrow ${escrow}`);
      throw new BankError("OVERSPEND", `voucher ${v.id} exceeds escrow ${escrow}`, { escrow, amount: v.amount });
    }
    if (payer.frozen) throw new BankError("FROZEN", `payer ${v.from} is frozen: ${payer.frozenReason ?? ""}`);

    const payee = await this.core.lookupWallet(v.to);
    if (!payee) throw new BankError("UNKNOWN_WALLET", `unknown payee ${v.to}`);
    const escrowTokens = await this.core.unspentOf(this.escrow.publicKey);
    const inputs = pickInputs(escrowTokens, v.amount, (t) => !t.rules);
    const res = await this.core.transfer(
      this.signedTransfer(this.escrow, inputs, outputsFor(this.escrow.publicKey, payee.publicKey, inputs, v.amount), `voucher:${v.id}`, `offline voucher ${v.id}`),
    );
    this.offlineEscrow.set(v.from, escrow - v.amount);
    this.acceptedVouchers.set(key, { hash, voucherId: v.id });
    this.seenVoucherIds.add(v.id);
    this.record("bank", "offline.sync", v.from, requestId, "ok", { voucherId: v.id, to: v.to, amount: v.amount, counter: v.counter, txId: res.txId });
    return { voucherId: v.id, ok: true, txId: res.txId };
  }

  // ------------------------------------------------------------------- audit

  auditLog(): AuditEntry[] {
    return this.audit.map((e) => ({ ...e, detail: { ...e.detail } }));
  }

  // --------------------------------------------------------------- internals

  private mutableWallet(id: string): Wallet {
    const w = this.wallets.get(id);
    if (!w) throw new BankError("UNKNOWN_WALLET", `unknown wallet ${id} at ${this.bankId}`);
    return w;
  }

  private requireActive(w: Wallet): void {
    if (w.frozen) throw new BankError("FROZEN", `wallet ${w.id} is frozen: ${w.frozenReason ?? ""}`);
  }

  private async requireBalanceCap(w: Wallet, incoming: number): Promise<void> {
    if (w.kind !== "person") return;
    const cap = KYC_LIMITS[w.kyc].balanceCap;
    const b = await this.balance(w.id);
    if (b.total + incoming > cap) {
      throw new BankError("KYC_BALANCE_CAP", `${w.id} (${w.kyc} KYC) would exceed balance cap ${cap}`, { cap, current: b.total, incoming });
    }
  }

  private requireDailyCap(w: Wallet, outgoing: number): void {
    if (w.kind !== "person") return;
    const cap = KYC_LIMITS[w.kyc].dailyOutCap;
    const today = this.today();
    const used = this.dailyOut.get(w.id);
    const spent = used && used.day === today ? used.total : 0;
    if (spent + outgoing > cap) {
      throw new BankError("KYC_DAILY_CAP", `${w.id} (${w.kyc} KYC) would exceed daily cap ${cap}`, { cap, spent, outgoing });
    }
  }

  private addDailyOut(id: string, amount: number): void {
    const today = this.today();
    const used = this.dailyOut.get(id);
    this.dailyOut.set(id, { day: today, total: (used && used.day === today ? used.total : 0) + amount });
  }

  private today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private signedTransfer(
    signer: KeyPair,
    inputs: Token[],
    outputs: Output[],
    idempotencyKey: string,
    memo?: string,
    context?: TransferRequest["context"],
  ): TransferRequest {
    const unsigned: TransferRequest = {
      inputs: inputs.map((t) => t.id),
      outputs,
      idempotencyKey,
      signature: "",
      ...(memo ? { memo } : {}),
      ...(context ? { context } : {}),
    };
    return { ...unsigned, signature: signCanonical(signer.privateKey, signingPayload("transfer", unsigned)) };
  }

  private async guarded<R extends Record<string, unknown>>(
    action: string,
    walletId: string,
    requestId: string,
    detail: Record<string, unknown>,
    run: () => Promise<R>,
  ): Promise<R> {
    const before = await this.safeBalance(walletId);
    try {
      const result = await run();
      const after = await this.safeBalance(walletId);
      this.record("customer", action, walletId, requestId, "ok", { ...detail, before, after, ...result });
      return result;
    } catch (err) {
      const code = err instanceof BankError || err instanceof LedgerError ? err.code : "ERROR";
      const message = err instanceof Error ? err.message : String(err);
      this.record("customer", action, walletId, requestId, "rejected", { ...detail, before, code, message });
      throw err;
    }
  }

  private async safeBalance(walletId: string): Promise<BalanceView | null> {
    try {
      return await this.balance(walletId);
    } catch {
      return null;
    }
  }

  private record(actor: string, action: string, walletId: string, requestId: string, outcome: "ok" | "rejected", detail: Record<string, unknown>): void {
    this.audit.push({ seq: this.audit.length + 1, at: this.clock().toISOString(), actor, action, walletId, requestId, outcome, detail });
  }
}

/** Largest-first selection over an owner's unspent tokens. */
export function pickInputs(tokens: Token[], amount: number, filter: (t: Token) => boolean): Token[] {
  const candidates = tokens.filter(filter).sort((a, b) => b.amount - a.amount);
  const chosen: Token[] = [];
  let total = 0;
  for (const t of candidates) {
    if (total >= amount) break;
    chosen.push(t);
    total += t.amount;
  }
  if (total < amount) throw new BankError("INSUFFICIENT_FUNDS", `available ${total} < ${amount}`, { available: total, needed: amount });
  return chosen;
}

/** Recipient gets `amount`; whatever the inputs over-cover goes back to the sender as change. */
export function outputsFor(sender: string, recipient: string, inputs: Token[], amount: number): Output[] {
  const change = sum(inputs.map((t) => t.amount)) - amount;
  const outputs: Output[] = [{ owner: recipient, amount }];
  if (change > 0) outputs.push({ owner: sender, amount: change });
  return outputs;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
