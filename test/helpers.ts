import { BankTier } from "../src/bank.js";
import { InProcessCoreClient } from "../src/core-client.js";
import { generateKeyPair, signCanonical, type KeyPair } from "../src/crypto.js";
import type { Journal } from "../src/journal.js";
import { CoreLedger, signingPayload, type Output, type Token, type TransferRequest } from "../src/ledger.js";
import { rupees } from "../src/money.js";

export interface Clock {
  now: Date;
  advanceDays(d: number): void;
}

export function makeClock(start = "2026-09-03T09:00:00.000Z"): Clock {
  const clock: Clock = {
    now: new Date(start),
    advanceDays(d) {
      clock.now = new Date(clock.now.getTime() + d * 86_400_000);
    },
  };
  return clock;
}

export function rbiSigner(rbi: KeyPair) {
  return <T extends { signature: string }>(type: string, req: T): T => ({
    ...req,
    signature: signCanonical(rbi.privateKey, signingPayload(type, req)),
  });
}

export function signedTransfer(
  signer: KeyPair,
  inputs: Token[],
  outputs: Output[],
  idempotencyKey: string,
  extra: Partial<Pick<TransferRequest, "memo" | "context">> = {},
): TransferRequest {
  const unsigned: TransferRequest = { inputs: inputs.map((t) => t.id), outputs, idempotencyKey, signature: "", ...extra };
  return { ...unsigned, signature: signCanonical(signer.privateKey, signingPayload("transfer", unsigned)) };
}

export interface World {
  rbi: KeyPair;
  ledger: CoreLedger;
  core: InProcessCoreClient;
  bankA: BankTier;
  bankB: BankTier;
  clock: Clock;
  sign: ReturnType<typeof rbiSigner>;
}

/** Central bank plus two banks, each holding `float` of e₹ against reserves. */
export async function makeWorld(float = rupees(1_000_000), journal?: Journal): Promise<World> {
  const clock = makeClock();
  const rbi = generateKeyPair();
  const ledger = new CoreLedger(rbi.publicKey, { clock: () => clock.now, ...(journal ? { journal } : {}) });
  const core = new InProcessCoreClient(ledger);
  const sign = rbiSigner(rbi);
  const bankA = await BankTier.create("bank-a", core, { clock: () => clock.now, openingReserve: float * 10 });
  const bankB = await BankTier.create("bank-b", core, { clock: () => clock.now, openingReserve: float * 10 });
  await ledger.mint(sign("mint", { amount: float * 2, idempotencyKey: "mint-0", signature: "" }));
  await ledger.issue(sign("issue", { bankId: "bank-a", amount: float, idempotencyKey: "issue-a", signature: "" }));
  await ledger.issue(sign("issue", { bankId: "bank-b", amount: float, idempotencyKey: "issue-b", signature: "" }));
  return { rbi, ledger, core, bankA, bankB, clock, sign };
}

export function expectInvariant(ledger: CoreLedger): void {
  const inv = ledger.invariants();
  if (!inv.ok) throw new Error(`invariant broken: ${inv.problems.join("; ")}`);
}

export async function rejects(run: () => Promise<unknown> | unknown): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (err) {
    const e = err as { code?: string; message: string; details?: Record<string, unknown> };
    if (!e.code) throw err;
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error("expected a rejection");
}
