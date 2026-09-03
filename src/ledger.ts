/**
 * Tier 1: the central-bank core ledger.
 *
 * - Tokens are UTXOs in standard denominations. A transfer spends inputs and
 *   creates outputs; inputs and outputs always balance.
 * - Only the RBI key can mint and burn. Banks receive tokens through `issue`
 *   against their reserve account at the central bank, and hand them back
 *   through `redeem`.
 * - Every accepted operation is appended to a hash-chained, tamper-evident
 *   log. This is a single-operator log, not a blockchain network, and says so.
 * - Every request carries an idempotency key. A replay returns the original
 *   result; the same key with a different payload is rejected.
 * - Conservation of money is an invariant, checked on demand and in tests:
 *   sum(unspent tokens) == minted - burned.
 *
 * Persistence is event-sourced. Each mutation is planned (validated, no state
 * touched), written to the journal, then applied. Transaction and token ids
 * are derived from the request, so replaying the journal rebuilds the exact
 * same state, entry hashes included. Mutations run one at a time through a
 * serialised commit path, so two concurrent transfers can never both pass
 * validation against the same token.
 */
import { canonicalJson, sha256, verifyCanonical, ZERO_HASH } from "./crypto.js";
import { MemoryJournal, type Journal, type JournalEvent, type JournalEventType } from "./journal.js";
import { assertPaise, denominate, sum } from "./money.js";
import { evaluateRules, isExpired, sameRules, type SpendContext, type TokenRules } from "./rules.js";

export interface Token {
  id: string;
  amount: number;
  /** Public key (hex) of the current owner. */
  owner: string;
  rules?: TokenRules;
  createdBy: string;
  spentBy?: string;
}

export interface Output {
  owner: string;
  amount: number;
  rules?: TokenRules;
}

export type WalletKind = "person" | "merchant" | "scheme" | "pool" | "escrow";

export interface WalletRecord {
  walletId: string;
  bankId: string;
  publicKey: string;
  kind: WalletKind;
  name: string;
  vpa?: string;
  mcc?: string;
  frozen: boolean;
}

export interface MintRequest {
  amount: number;
  idempotencyKey: string;
  signature: string;
}
export interface BurnRequest {
  inputs: string[];
  idempotencyKey: string;
  signature: string;
}
export interface IssueRequest {
  bankId: string;
  amount: number;
  idempotencyKey: string;
  signature: string;
}
export interface RedeemRequest {
  bankId: string;
  inputs: string[];
  idempotencyKey: string;
  signature: string;
}
export interface TransferRequest {
  inputs: string[];
  outputs: Output[];
  memo?: string;
  context?: SpendContext;
  idempotencyKey: string;
  signature: string;
}

export type EntryType = "mint" | "issue" | "redeem" | "transfer" | "burn" | "sweep";

export interface LedgerEntry {
  seq: number;
  type: EntryType;
  txId: string;
  at: string;
  prevHash: string;
  hash: string;
  summary: Record<string, unknown>;
}

export interface Invariants {
  ok: boolean;
  unspentTotal: number;
  minted: number;
  burned: number;
  entries: number;
  chainOk: boolean;
  problems: string[];
}

export type LedgerErrorCode =
  | "BAD_SIGNATURE"
  | "UNKNOWN_TOKEN"
  | "ALREADY_SPENT"
  | "MIXED_OWNERS"
  | "MIXED_RULES"
  | "UNBALANCED"
  | "INVALID_OUTPUT"
  | "RULE_VIOLATION"
  | "RULES_NOT_ALLOWED"
  | "INVALID_RULES"
  | "FROZEN"
  | "IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_RESERVE"
  | "INSUFFICIENT_FUNDS"
  | "UNKNOWN_BANK"
  | "UNKNOWN_WALLET"
  | "DUPLICATE_WALLET"
  | "NOT_OWNER"
  | "REPLAY_MISMATCH";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The payload a signer commits to; the signature field itself is excluded. */
export function signingPayload<T extends { signature: string }>(type: string, req: T): Record<string, unknown> {
  const { signature: _signature, ...rest } = req;
  return { type, ...rest };
}

export interface LedgerOptions {
  clock?: () => Date;
  journal?: Journal;
}

interface Plan<R> {
  apply: (at: string) => R;
}

export class CoreLedger {
  private readonly tokens = new Map<string, Token>();
  private readonly unspentByOwner = new Map<string, Set<string>>();
  private readonly idempotency = new Map<string, { requestHash: string; result: unknown }>();
  private readonly entries: LedgerEntry[] = [];
  private readonly reserves = new Map<string, number>();
  private readonly poolKeys = new Map<string, string>();
  private readonly directory = new Map<string, WalletRecord>();
  private readonly byPublicKey = new Map<string, string>();
  private readonly byVpa = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly journal: Journal;
  private journalSeq = 0;
  private replaying = false;
  private chain: Promise<unknown> = Promise.resolve();
  private minted = 0;
  private burned = 0;

  constructor(
    readonly rbiPublicKey: string,
    opts: LedgerOptions = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.journal = opts.journal ?? new MemoryJournal();
  }

  /** Rebuild a ledger from its journal, then keep appending to it. */
  static async open(rbiPublicKey: string, journal: Journal, opts: Omit<LedgerOptions, "journal"> = {}): Promise<CoreLedger> {
    const ledger = new CoreLedger(rbiPublicKey, { ...opts, journal });
    await ledger.replay(await journal.readAll());
    return ledger;
  }

  get journaledEvents(): number {
    return this.journalSeq;
  }

  // ---------------------------------------------------------------- directory

  /** A bank joins the system with a pool wallet key and an opening reserve balance at the central bank. */
  registerBank(bankId: string, poolPublicKey: string, openingReserve: number): Promise<void> {
    return this.serialize(async () => {
      this.planRegisterBank(bankId, poolPublicKey);
      await this.record("bank.register", { bankId, poolPublicKey, openingReserve });
      this.applyRegisterBank(bankId, poolPublicKey, openingReserve);
    });
  }

  reserveOf(bankId: string): number {
    const r = this.reserves.get(bankId);
    if (r === undefined) throw new LedgerError("UNKNOWN_BANK", `unknown bank ${bankId}`);
    return r;
  }

  registerWallet(record: WalletRecord): Promise<WalletRecord> {
    return this.serialize(async () => {
      this.planRegisterWallet(record);
      await this.record("wallet.register", { ...record });
      return this.applyRegisterWallet(record);
    });
  }

  lookupWallet(walletId: string): WalletRecord | undefined {
    const rec = this.directory.get(walletId);
    return rec ? { ...rec } : undefined;
  }

  lookupByPublicKey(publicKey: string): WalletRecord | undefined {
    const id = this.byPublicKey.get(publicKey);
    return id ? this.lookupWallet(id) : undefined;
  }

  lookupVpa(vpa: string): WalletRecord | undefined {
    const id = this.byVpa.get(vpa);
    return id ? this.lookupWallet(id) : undefined;
  }

  setFrozen(walletId: string, frozen: boolean): Promise<WalletRecord> {
    return this.serialize(async () => {
      if (!this.directory.has(walletId)) throw new LedgerError("UNKNOWN_WALLET", `unknown wallet ${walletId}`);
      await this.record("wallet.frozen", { walletId, frozen });
      return this.applyFrozen(walletId, frozen);
    });
  }

  // ------------------------------------------------------------- RBI actions

  mint(req: MintRequest): Promise<{ txId: string; tokens: Token[] }> {
    return this.commit("mint", req, () => this.planMint(req));
  }

  burn(req: BurnRequest): Promise<{ txId: string; amount: number }> {
    return this.commit("burn", req, () => this.planBurn(req));
  }

  /** Move tokens from the RBI to a bank's pool wallet, debiting the bank's reserve account. */
  issue(req: IssueRequest): Promise<{ txId: string; tokens: Token[] }> {
    return this.commit("issue", req, () => this.planIssue(req));
  }

  /** Return tokens from a bank's pool to the RBI, crediting the bank's reserve account. */
  redeem(req: RedeemRequest): Promise<{ txId: string; amount: number }> {
    return this.commit("redeem", req, () => this.planRedeem(req));
  }

  // ---------------------------------------------------------------- transfers

  transfer(req: TransferRequest): Promise<{ txId: string; outputs: Token[] }> {
    return this.commit("transfer", req, (at) => this.planTransfer(req, at));
  }

  /** Return expired purpose-bound tokens to their scheme wallet. Operated by the core, not signed by users. */
  sweepExpired(at: Date = this.clock()): Promise<{ txId: string | null; swept: Token[] }> {
    return this.serialize(async () => {
      const atIso = at.toISOString();
      const plan = this.planSweep(atIso);
      if (!plan) return { txId: null, swept: [] };
      await this.record("sweep", { at: atIso });
      return plan.apply(atIso);
    });
  }

  // ------------------------------------------------------------------ queries

  getToken(id: string): Token | undefined {
    const t = this.tokens.get(id);
    return t ? copyToken(t) : undefined;
  }

  unspentOf(owner: string): Token[] {
    const ids = this.unspentByOwner.get(owner);
    if (!ids) return [];
    return [...ids].map((id) => copyToken(this.tokens.get(id)!));
  }

  balanceOf(owner: string): number {
    return sum(this.unspentOf(owner).map((t) => t.amount));
  }

  /** Pick unspent tokens of one owner covering `amount`, largest first. Throws if the owner cannot cover it. */
  selectInputs(owner: string, amount: number, filter: (t: Token) => boolean = () => true): Token[] {
    const candidates = this.unspentOf(owner)
      .filter(filter)
      .sort((a, b) => b.amount - a.amount);
    const chosen: Token[] = [];
    let total = 0;
    for (const t of candidates) {
      if (total >= amount) break;
      chosen.push(t);
      total += t.amount;
    }
    if (total < amount) {
      throw new LedgerError("INSUFFICIENT_FUNDS", `owner holds ${total}, needs ${amount}`, { available: total, needed: amount });
    }
    return chosen.map((t) => this.tokens.get(t.id)!);
  }

  entriesList(): LedgerEntry[] {
    return this.entries.map((e) => ({ ...e, summary: structuredClone(e.summary) }));
  }

  verifyChain(): boolean {
    let prev = ZERO_HASH;
    for (const [i, e] of this.entries.entries()) {
      if (e.seq !== i + 1 || e.prevHash !== prev) return false;
      if (e.hash !== entryHash(e)) return false;
      prev = e.hash;
    }
    return true;
  }

  invariants(): Invariants {
    const problems: string[] = [];
    let unspentTotal = 0;
    for (const t of this.tokens.values()) {
      if (!t.spentBy) unspentTotal += t.amount;
    }
    for (const [owner, ids] of this.unspentByOwner) {
      for (const id of ids) {
        const t = this.tokens.get(id);
        if (!t || t.spentBy || t.owner !== owner) problems.push(`index drift on ${id}`);
      }
    }
    if (unspentTotal !== this.minted - this.burned) {
      problems.push(`unspent ${unspentTotal} != minted ${this.minted} - burned ${this.burned}`);
    }
    const chainOk = this.verifyChain();
    if (!chainOk) problems.push("hash chain broken");
    return {
      ok: problems.length === 0,
      unspentTotal,
      minted: this.minted,
      burned: this.burned,
      entries: this.entries.length,
      chainOk,
      problems,
    };
  }

  // ------------------------------------------------------------- commit path

  /** Validate, journal, apply: one operation at a time. */
  private commit<R>(type: JournalEventType, req: { idempotencyKey: string }, plan: (at: string) => Plan<R>): Promise<R> {
    return this.serialize(async () => {
      const requestHash = this.checkIdempotency(req);
      const cached = this.idempotency.get(req.idempotencyKey);
      if (cached) return structuredClone(cached.result) as R;
      const at = this.clock().toISOString();
      const p = plan(at);
      await this.record(type, { ...req });
      const result = p.apply(at);
      this.idempotency.set(req.idempotencyKey, { requestHash, result: structuredClone(result) });
      return result;
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private checkIdempotency(req: { idempotencyKey: string }): string {
    if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0) {
      throw new LedgerError("INVALID_OUTPUT", "idempotencyKey is required");
    }
    const requestHash = sha256(canonicalJson(req));
    const seen = this.idempotency.get(req.idempotencyKey);
    if (seen && seen.requestHash !== requestHash) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", `key ${req.idempotencyKey} was used with a different payload`);
    }
    return requestHash;
  }

  private async record(type: JournalEventType, payload: Record<string, unknown>): Promise<void> {
    if (this.replaying) return;
    const event: JournalEvent = { seq: this.journalSeq + 1, at: this.clock().toISOString(), type, payload };
    await this.journal.append(event);
    this.journalSeq = event.seq;
  }

  private async replay(events: JournalEvent[]): Promise<void> {
    this.replaying = true;
    try {
      for (const e of events) {
        if (e.seq !== this.journalSeq + 1) throw new LedgerError("REPLAY_MISMATCH", `journal gap: expected ${this.journalSeq + 1}, got ${e.seq}`);
        this.applyRecorded(e);
        this.journalSeq = e.seq;
      }
    } finally {
      this.replaying = false;
    }
  }

  private applyRecorded(e: JournalEvent): void {
    switch (e.type) {
      case "bank.register": {
        const p = e.payload as { bankId: string; poolPublicKey: string; openingReserve: number };
        this.planRegisterBank(p.bankId, p.poolPublicKey);
        this.applyRegisterBank(p.bankId, p.poolPublicKey, p.openingReserve);
        return;
      }
      case "wallet.register": {
        const record = e.payload as unknown as WalletRecord;
        this.planRegisterWallet(record);
        this.applyRegisterWallet(record);
        return;
      }
      case "wallet.frozen": {
        const p = e.payload as { walletId: string; frozen: boolean };
        this.applyFrozen(p.walletId, p.frozen);
        return;
      }
      case "sweep": {
        const p = e.payload as { at: string };
        const plan = this.planSweep(p.at);
        if (plan) plan.apply(p.at);
        return;
      }
      case "mint":
      case "burn":
      case "issue":
      case "redeem":
      case "transfer": {
        const req = e.payload as unknown as { idempotencyKey: string };
        const requestHash = this.checkIdempotency(req);
        if (this.idempotency.has(req.idempotencyKey)) return;
        const plan =
          e.type === "mint" ? this.planMint(req as MintRequest)
          : e.type === "burn" ? this.planBurn(req as BurnRequest)
          : e.type === "issue" ? this.planIssue(req as IssueRequest)
          : e.type === "redeem" ? this.planRedeem(req as RedeemRequest)
          : this.planTransfer(req as TransferRequest, e.at);
        const result = (plan as Plan<unknown>).apply(e.at);
        this.idempotency.set(req.idempotencyKey, { requestHash, result: structuredClone(result) });
        return;
      }
    }
  }

  // --------------------------------------------------------------- planning

  private planRegisterBank(bankId: string, poolPublicKey: string): void {
    if (this.poolKeys.has(bankId)) throw new LedgerError("DUPLICATE_WALLET", `bank ${bankId} already registered`);
    this.planRegisterWallet({ walletId: `${bankId}:pool`, bankId, publicKey: poolPublicKey, kind: "pool", name: `${bankId} e₹ pool`, frozen: false });
  }

  private applyRegisterBank(bankId: string, poolPublicKey: string, openingReserve: number): void {
    this.poolKeys.set(bankId, poolPublicKey);
    this.reserves.set(bankId, openingReserve);
    this.applyRegisterWallet({ walletId: `${bankId}:pool`, bankId, publicKey: poolPublicKey, kind: "pool", name: `${bankId} e₹ pool`, frozen: false });
  }

  private planRegisterWallet(record: WalletRecord): void {
    if (this.directory.has(record.walletId)) {
      throw new LedgerError("DUPLICATE_WALLET", `wallet ${record.walletId} already registered`);
    }
    if (this.byPublicKey.has(record.publicKey)) {
      throw new LedgerError("DUPLICATE_WALLET", `public key already bound to ${this.byPublicKey.get(record.publicKey)}`);
    }
    if (record.vpa && this.byVpa.has(record.vpa)) throw new LedgerError("DUPLICATE_WALLET", `VPA ${record.vpa} already taken`);
  }

  private applyRegisterWallet(record: WalletRecord): WalletRecord {
    const stored = { ...record };
    this.directory.set(record.walletId, stored);
    this.byPublicKey.set(record.publicKey, record.walletId);
    if (record.vpa) this.byVpa.set(record.vpa, record.walletId);
    return { ...stored };
  }

  private applyFrozen(walletId: string, frozen: boolean): WalletRecord {
    const rec = this.directory.get(walletId);
    if (!rec) throw new LedgerError("UNKNOWN_WALLET", `unknown wallet ${walletId}`);
    rec.frozen = frozen;
    return { ...rec };
  }

  private planMint(req: MintRequest): Plan<{ txId: string; tokens: Token[] }> {
    assertPaise(req.amount);
    this.requireSignature(this.rbiPublicKey, signingPayload("mint", req), req.signature);
    const txId = this.txIdFor("mint", req);
    return {
      apply: (at) => {
        const tokens = this.createTokens(this.rbiPublicKey, req.amount, undefined, txId);
        this.minted += req.amount;
        this.append("mint", txId, { amount: req.amount, tokens: tokens.length }, at);
        return { txId, tokens: tokens.map(copyToken) };
      },
    };
  }

  private planBurn(req: BurnRequest): Plan<{ txId: string; amount: number }> {
    this.requireSignature(this.rbiPublicKey, signingPayload("burn", req), req.signature);
    const inputs = this.loadInputs(req.inputs, this.rbiPublicKey);
    const txId = this.txIdFor("burn", req);
    return {
      apply: (at) => {
        const amount = sum(inputs.map((t) => t.amount));
        for (const t of inputs) this.spend(t, txId);
        this.burned += amount;
        this.append("burn", txId, { amount, inputs: inputs.map((t) => t.id) }, at);
        return { txId, amount };
      },
    };
  }

  private planIssue(req: IssueRequest): Plan<{ txId: string; tokens: Token[] }> {
    assertPaise(req.amount);
    this.requireSignature(this.rbiPublicKey, signingPayload("issue", req), req.signature);
    const poolKey = this.poolKeys.get(req.bankId);
    if (!poolKey) throw new LedgerError("UNKNOWN_BANK", `unknown bank ${req.bankId}`);
    const reserve = this.reserveOf(req.bankId);
    if (reserve < req.amount) {
      throw new LedgerError("INSUFFICIENT_RESERVE", `${req.bankId} reserve ${reserve} < ${req.amount}`);
    }
    const inputs = this.selectInputs(this.rbiPublicKey, req.amount, (t) => !t.rules);
    const txId = this.txIdFor("issue", req);
    return {
      apply: (at) => {
        const change = sum(inputs.map((t) => t.amount)) - req.amount;
        for (const t of inputs) this.spend(t, txId);
        const tokens = this.createTokens(poolKey, req.amount, undefined, txId);
        if (change > 0) this.createTokens(this.rbiPublicKey, change, undefined, txId);
        this.reserves.set(req.bankId, reserve - req.amount);
        this.append("issue", txId, { bankId: req.bankId, amount: req.amount }, at);
        return { txId, tokens: tokens.map(copyToken) };
      },
    };
  }

  private planRedeem(req: RedeemRequest): Plan<{ txId: string; amount: number }> {
    const poolKey = this.poolKeys.get(req.bankId);
    if (!poolKey) throw new LedgerError("UNKNOWN_BANK", `unknown bank ${req.bankId}`);
    this.requireSignature(poolKey, signingPayload("redeem", req), req.signature);
    const inputs = this.loadInputs(req.inputs, poolKey);
    if (inputs.some((t) => t.rules)) throw new LedgerError("RULES_NOT_ALLOWED", "cannot redeem purpose-bound tokens");
    const txId = this.txIdFor("redeem", req);
    return {
      apply: (at) => {
        const amount = sum(inputs.map((t) => t.amount));
        for (const t of inputs) this.spend(t, txId);
        this.createTokens(this.rbiPublicKey, amount, undefined, txId);
        this.reserves.set(req.bankId, this.reserveOf(req.bankId) + amount);
        this.append("redeem", txId, { bankId: req.bankId, amount }, at);
        return { txId, amount };
      },
    };
  }

  private planTransfer(req: TransferRequest, at: string): Plan<{ txId: string; outputs: Token[] }> {
    if (req.inputs.length === 0) throw new LedgerError("INVALID_OUTPUT", "transfer needs at least one input");
    if (req.outputs.length === 0) throw new LedgerError("INVALID_OUTPUT", "transfer needs at least one output");
    const inputs = this.loadInputs(req.inputs);
    const from = inputs[0]!.owner;
    if (inputs.some((t) => t.owner !== from)) throw new LedgerError("MIXED_OWNERS", "all inputs must share one owner");
    this.requireSignature(from, signingPayload("transfer", req), req.signature);

    const sender = this.lookupByPublicKey(from);
    if (sender?.frozen) throw new LedgerError("FROZEN", `wallet ${sender.walletId} is frozen`);

    for (const o of req.outputs) {
      assertPaise(o.amount);
      if (typeof o.owner !== "string" || o.owner.length !== 64) {
        throw new LedgerError("INVALID_OUTPUT", "output owner must be a public key");
      }
      const recipient = this.lookupByPublicKey(o.owner);
      if (recipient?.frozen) throw new LedgerError("FROZEN", `wallet ${recipient.walletId} is frozen`);
    }
    const inTotal = sum(inputs.map((t) => t.amount));
    const outTotal = sum(req.outputs.map((o) => o.amount));
    if (inTotal !== outTotal) {
      throw new LedgerError("UNBALANCED", `inputs ${inTotal} != outputs ${outTotal}`);
    }

    const inputRules = inputs[0]!.rules;
    if (inputs.some((t) => !sameRules(t.rules, inputRules))) {
      throw new LedgerError("MIXED_RULES", "inputs must all carry the same rules (or none)");
    }

    const spendAt = req.context?.at ?? at;
    const finalOutputs: Output[] = [];
    for (const o of req.outputs) {
      if (inputRules) {
        if (o.rules) throw new LedgerError("RULES_NOT_ALLOWED", "purpose-bound tokens cannot be re-bound");
        if (o.owner === from) {
          // Change keeps the restriction.
          finalOutputs.push({ owner: o.owner, amount: o.amount, rules: inputRules });
          continue;
        }
        const recipient = this.lookupByPublicKey(o.owner);
        const ctx: SpendContext = {
          at: spendAt,
          ...(recipient?.mcc ? { recipientMcc: recipient.mcc } : {}),
          ...(req.context?.location ? { location: req.context.location } : {}),
        };
        const violation = evaluateRules(inputRules, ctx);
        if (violation) {
          throw new LedgerError("RULE_VIOLATION", violation.message, { violation: violation.code, purpose: inputRules.purpose });
        }
        // A qualifying spend releases the restriction: the merchant receives ordinary e₹.
        finalOutputs.push({ owner: o.owner, amount: o.amount });
      } else {
        if (o.rules) this.validateRules(o.rules);
        finalOutputs.push(o.rules ? { owner: o.owner, amount: o.amount, rules: o.rules } : { owner: o.owner, amount: o.amount });
      }
    }

    const txId = this.txIdFor("transfer", req);
    return {
      apply: (appliedAt) => {
        for (const t of inputs) this.spend(t, txId);
        const created: Token[] = [];
        for (const o of finalOutputs) created.push(...this.createTokens(o.owner, o.amount, o.rules, txId));
        this.append(
          "transfer",
          txId,
          {
            from,
            inputs: inputs.map((t) => t.id),
            outputs: finalOutputs.map((o) => ({ owner: o.owner, amount: o.amount, purpose: o.rules?.purpose ?? null })),
            ...(inputRules ? { purpose: inputRules.purpose } : {}),
            ...(req.memo ? { memo: req.memo } : {}),
          },
          appliedAt,
        );
        return { txId, outputs: created.map(copyToken) };
      },
    };
  }

  private planSweep(atIso: string): Plan<{ txId: string | null; swept: Token[] }> | null {
    const at = new Date(atIso);
    const expired: Token[] = [];
    for (const t of this.tokens.values()) {
      if (!t.spentBy && isExpired(t.rules, at)) expired.push(t);
    }
    if (expired.length === 0) return null;
    const txId = "tx_" + sha256(`sweep|${atIso}|${this.entries.length + 1}`).slice(0, 16);
    return {
      apply: (appliedAt) => {
        const byScheme = new Map<string, number>();
        for (const t of expired) {
          this.spend(t, txId);
          byScheme.set(t.rules!.returnTo, (byScheme.get(t.rules!.returnTo) ?? 0) + t.amount);
        }
        for (const [returnTo, amount] of byScheme) this.createTokens(returnTo, amount, undefined, txId);
        this.append(
          "sweep",
          txId,
          { at: atIso, swept: expired.map((t) => ({ id: t.id, amount: t.amount, purpose: t.rules!.purpose })) },
          appliedAt,
        );
        return { txId, swept: expired.map(copyToken) };
      },
    };
  }

  // ---------------------------------------------------------------- internals

  private txIdFor(type: string, req: { idempotencyKey: string }): string {
    return "tx_" + sha256(`${type}|${req.idempotencyKey}|${sha256(canonicalJson(req))}`).slice(0, 16);
  }

  private requireSignature(publicKey: string, payload: unknown, signature: string): void {
    if (!verifyCanonical(publicKey, payload, signature)) {
      throw new LedgerError("BAD_SIGNATURE", "signature does not verify against the required key");
    }
  }

  private loadInputs(ids: string[], requiredOwner?: string): Token[] {
    const unique = new Set(ids);
    if (unique.size !== ids.length) throw new LedgerError("ALREADY_SPENT", "duplicate input in transfer");
    return ids.map((id) => {
      const t = this.tokens.get(id);
      if (!t) throw new LedgerError("UNKNOWN_TOKEN", `unknown token ${id}`);
      if (t.spentBy) throw new LedgerError("ALREADY_SPENT", `token ${id} already spent in ${t.spentBy}`);
      if (requiredOwner && t.owner !== requiredOwner) throw new LedgerError("NOT_OWNER", `token ${id} is not owned by the signer`);
      return t;
    });
  }

  private validateRules(rules: TokenRules): void {
    if (typeof rules.purpose !== "string" || rules.purpose.length === 0) {
      throw new LedgerError("INVALID_RULES", "rules.purpose is required");
    }
    if (typeof rules.returnTo !== "string" || rules.returnTo.length !== 64) {
      throw new LedgerError("INVALID_RULES", "rules.returnTo must be the scheme wallet public key");
    }
    if (rules.expiresAt && Number.isNaN(new Date(rules.expiresAt).getTime())) {
      throw new LedgerError("INVALID_RULES", "rules.expiresAt must be an ISO timestamp");
    }
    if (rules.mccAllowlist && rules.mccAllowlist.length === 0) {
      throw new LedgerError("INVALID_RULES", "rules.mccAllowlist cannot be empty");
    }
    if (rules.geofence && !(rules.geofence.radiusM > 0)) {
      throw new LedgerError("INVALID_RULES", "rules.geofence.radiusM must be positive");
    }
  }

  private createTokens(owner: string, amount: number, rules: TokenRules | undefined, txId: string): Token[] {
    const created: Token[] = [];
    let index = 0;
    for (const denomination of denominate(amount)) {
      // Token ids derive from the transaction and position, so a replay creates the same ids.
      let id: string;
      do {
        id = "tok_" + sha256(`${txId}|${index}`).slice(0, 16);
        index += 1;
      } while (this.tokens.has(id));
      const token: Token = rules
        ? { id, amount: denomination, owner, rules: structuredClone(rules), createdBy: txId }
        : { id, amount: denomination, owner, createdBy: txId };
      this.tokens.set(token.id, token);
      let set = this.unspentByOwner.get(owner);
      if (!set) {
        set = new Set();
        this.unspentByOwner.set(owner, set);
      }
      set.add(token.id);
      created.push(token);
    }
    return created;
  }

  private spend(token: Token, txId: string): void {
    if (token.spentBy) throw new LedgerError("ALREADY_SPENT", `token ${token.id} already spent`);
    token.spentBy = txId;
    this.unspentByOwner.get(token.owner)?.delete(token.id);
  }

  private append(type: EntryType, txId: string, summary: Record<string, unknown>, at: string): LedgerEntry {
    const prevHash = this.entries.at(-1)?.hash ?? ZERO_HASH;
    const draft = { seq: this.entries.length + 1, type, txId, at, prevHash, summary };
    const entry: LedgerEntry = { ...draft, hash: entryHash(draft) };
    this.entries.push(entry);
    return entry;
  }
}

function entryHash(e: Omit<LedgerEntry, "hash">): string {
  return sha256(e.prevHash + canonicalJson({ seq: e.seq, type: e.type, txId: e.txId, at: e.at, summary: e.summary }));
}

function copyToken(t: Token): Token {
  return structuredClone(t);
}
