/**
 * Offline e₹: the device side.
 *
 * A wallet pre-funds an offline balance while online (the bank parks those
 * tokens in an escrow wallet). Offline, the payer's device issues signed
 * vouchers with a strictly increasing counter and a hash link to the previous
 * voucher. The payee's device verifies the signature locally and keeps the
 * voucher until it can sync. The bank settles vouchers on sync and detects
 * double-spends there (see BankTier.syncVouchers).
 *
 * Honest limitation: a software wallet can be cloned, so this design detects
 * and sanctions double-spending after the fact. Real deployments put the
 * counter and key in a secure element to prevent it. `clone()` exists so the
 * tests can play the attacker.
 */
import { canonicalJson, newId, sha256, signCanonical, verifyCanonical, ZERO_HASH, type KeyPair } from "./crypto.js";
import { assertPaise } from "./money.js";

export interface Voucher {
  id: string;
  from: string;
  /** Payer's public key, so the payee can verify without connectivity. */
  fromKey: string;
  to: string;
  amount: number;
  /** Strictly increasing per payer device. Two vouchers with one counter is a double-spend. */
  counter: number;
  prevHash: string;
  issuedAt: string;
  signature: string;
}

export type OfflineErrorCode = "INSUFFICIENT_OFFLINE_BALANCE" | "BAD_VOUCHER" | "UNKNOWN_SENDER" | "KEY_MISMATCH";

export class OfflineError extends Error {
  constructor(
    readonly code: OfflineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfflineError";
  }
}

export function voucherPayload(v: Voucher | Omit<Voucher, "signature">): Omit<Voucher, "signature"> {
  const { id, from, fromKey, to, amount, counter, prevHash, issuedAt } = v;
  return { id, from, fromKey, to, amount, counter, prevHash, issuedAt };
}

export function voucherHash(v: Voucher | Omit<Voucher, "signature">): string {
  return sha256(canonicalJson(voucherPayload(v)));
}

export function verifyVoucher(v: Voucher): boolean {
  return verifyCanonical(v.fromKey, voucherPayload(v), v.signature);
}

export class OfflineWallet {
  balance = 0;
  counter = 0;
  lastHash = ZERO_HASH;
  private readonly inbox: Voucher[] = [];

  constructor(
    readonly walletId: string,
    private readonly keys: KeyPair,
    /** Directory snapshot cached at the last sync: walletId -> public key. */
    private readonly resolveKey: (walletId: string) => string | undefined,
  ) {}

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /** Called after the bank confirms a prefund. */
  fund(amount: number): void {
    assertPaise(amount);
    this.balance += amount;
  }

  createVoucher(to: string, amount: number, at: Date = new Date()): Voucher {
    assertPaise(amount);
    if (amount > this.balance) {
      throw new OfflineError("INSUFFICIENT_OFFLINE_BALANCE", `offline balance ${this.balance} < ${amount}`);
    }
    const draft: Omit<Voucher, "signature"> = {
      id: newId("vch"),
      from: this.walletId,
      fromKey: this.publicKey,
      to,
      amount,
      counter: this.counter + 1,
      prevHash: this.lastHash,
      issuedAt: at.toISOString(),
    };
    const voucher: Voucher = { ...draft, signature: signCanonical(this.keys.privateKey, draft) };
    this.counter += 1;
    this.balance -= amount;
    this.lastHash = voucherHash(voucher);
    return voucher;
  }

  /** Verify a voucher offline and hold it until sync. Received value is not re-spendable offline. */
  receiveVoucher(v: Voucher): void {
    if (v.to !== this.walletId) throw new OfflineError("BAD_VOUCHER", `voucher is addressed to ${v.to}`);
    const known = this.resolveKey(v.from);
    if (!known) throw new OfflineError("UNKNOWN_SENDER", `no cached key for ${v.from}; sync before accepting`);
    if (known !== v.fromKey) throw new OfflineError("KEY_MISMATCH", `voucher key does not match the directory for ${v.from}`);
    if (!verifyVoucher(v)) throw new OfflineError("BAD_VOUCHER", "signature does not verify");
    this.inbox.push(v);
  }

  pendingVouchers(): Voucher[] {
    return [...this.inbox];
  }

  markSynced(ids: Iterable<string>): void {
    const done = new Set(ids);
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (done.has(this.inbox[i]!.id)) this.inbox.splice(i, 1);
    }
  }

  /** The attacker's move: a byte-for-byte copy of the device state, counter included. */
  clone(): OfflineWallet {
    const copy = new OfflineWallet(this.walletId, this.keys, this.resolveKey);
    copy.balance = this.balance;
    copy.counter = this.counter;
    copy.lastHash = this.lastHash;
    return copy;
  }
}
