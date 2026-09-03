/**
 * Persistence: the ledger is a projection of its journal. Rebuilding from the
 * journal must give the same tokens, balances, directory, entries and hashes,
 * and the rebuilt ledger must keep working and stay idempotent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreLedger } from "../src/ledger.js";
import { MemoryJournal, PostgresJournal, SqliteJournal, type Journal } from "../src/journal.js";
import { rupees } from "../src/money.js";
import { buildUpiQr } from "../src/upi.js";
import { makeWorld, rejects } from "./helpers.js";

/** Drive a realistic mix of operations and return everything a replay must reproduce. */
async function exercise(journal: Journal) {
  const w = await makeWorld(rupees(100_000), journal);
  const asha = await w.bankA.createWallet({ name: "Asha", kyc: "full", accountBalance: rupees(20_000) });
  const ravi = await w.bankB.createWallet({ name: "Ravi", kyc: "full", accountBalance: rupees(20_000) });
  const shop = await w.bankB.createWallet({ name: "Shop", kind: "merchant", vpa: "shop@bank-b", mcc: "5411" });
  const scheme = await w.bankA.createWallet({ name: "Scheme", kind: "scheme", accountBalance: rupees(50_000) });
  await w.bankA.load(asha.id, rupees(5_000), "l1");
  await w.bankB.load(ravi.id, rupees(5_000), "l2");
  await w.bankA.load(scheme.id, rupees(10_000), "l3");
  await w.bankA.payP2P({ from: asha.id, to: ravi.id, amount: rupees(700), requestId: "p1" });
  await w.bankB.payQr({ from: ravi.id, qr: buildUpiQr({ vpa: "shop@bank-b", amount: rupees(120), mcc: "5411" }), requestId: "q1" });
  await w.bankA.disburse({
    schemeWalletId: scheme.id,
    to: asha.id,
    amount: rupees(1_000),
    rules: { purpose: "TEST", expiresAt: new Date(w.clock.now.getTime() + 86_400_000).toISOString() },
    requestId: "d1",
  });
  await rejects(() => w.bankA.load(asha.id, 75, "bad-amount")); // rejected: must not be journaled
  await w.bankB.freeze(ravi.id, "test freeze");
  w.clock.advanceDays(2);
  await w.ledger.sweepExpired();
  await w.bankA.redeem(rupees(1_000), "r1");
  return w;
}

function snapshot(ledger: CoreLedger, owners: string[]) {
  return {
    invariants: ledger.invariants(),
    entries: ledger.entriesList(),
    balances: owners.map((o) => ledger.unspentOf(o)),
    reserves: ["bank-a", "bank-b"].map((b) => ledger.reserveOf(b)),
    wallets: ["bank-a:asha", "bank-b:ravi", "bank-b:shop", "bank-a:scheme", "bank-a:pool"].map((id) => ledger.lookupWallet(id)),
    events: ledger.journaledEvents,
  };
}

async function roundTrip(journal: Journal, reopen: () => Promise<Journal>) {
  const w = await exercise(journal);
  const owners = [w.bankA.poolPublicKey, w.bankB.poolPublicKey, w.bankA.publicKeyOf("bank-a:asha")!, w.bankB.publicKeyOf("bank-b:ravi")!, w.bankA.publicKeyOf("bank-a:scheme")!];
  const before = snapshot(w.ledger, owners);
  expect(before.invariants.ok).toBe(true);
  expect(before.entries.length).toBeGreaterThanOrEqual(9);
  await journal.close();

  const second = await reopen();
  try {
    const reopened = await CoreLedger.open(w.rbi.publicKey, second, { clock: () => w.clock.now });
    const after = snapshot(reopened, owners);
    expect(after).toEqual(before);
    expect(reopened.lookupWallet("bank-b:ravi")?.frozen).toBe(true);

    // The rebuilt ledger keeps working and stays idempotent for requests it already saw.
    const again = await reopened.mint(w.sign("mint", { amount: rupees(200_000), idempotencyKey: "mint-0", signature: "" }));
    expect(again.txId).toBe(before.entries[0]!.txId);
    expect(reopened.entriesList()).toHaveLength(before.entries.length);
    const fresh = await reopened.mint(w.sign("mint", { amount: rupees(10), idempotencyKey: "mint-after-reopen", signature: "" }));
    expect(fresh.tokens).toHaveLength(1);
    expect(reopened.invariants().ok).toBe(true);
    expect(reopened.journaledEvents).toBe(before.events + 1);
  } finally {
    await second.close();
  }
}

describe("memory journal", () => {
  it("records only accepted operations, in order", async () => {
    const journal = new MemoryJournal();
    await exercise(journal);
    const types = journal.events.map((e) => e.type);
    expect(journal.events.map((e) => e.seq)).toEqual(journal.events.map((_, i) => i + 1));
    expect(types.filter((t) => t === "bank.register")).toHaveLength(2);
    expect(types).toContain("sweep");
    expect(types).toContain("wallet.frozen");
    expect(types).toContain("redeem");
    // the rejected 75-paise load never reached the journal
    expect(journal.events.filter((e) => e.type === "transfer" && (e.payload as { idempotencyKey: string }).idempotencyKey === "bad-amount")).toHaveLength(0);
  });

  it("replays into an identical ledger", async () => {
    const journal = new MemoryJournal();
    await roundTrip(journal, async () => journal);
  });
});

describe("SQLite journal", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rupee-journal-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a process restart: close the file, reopen it, same ledger", async () => {
    const file = path.join(dir, "ledger.sqlite");
    await roundTrip(new SqliteJournal(file), async () => new SqliteJournal(file));
  });

  it("refuses a gap or duplicate in the sequence", async () => {
    const j = new SqliteJournal(path.join(dir, "gap.sqlite"));
    await j.append({ seq: 1, at: "2026-01-01T00:00:00.000Z", type: "sweep", payload: { at: "x" } });
    await expect(j.append({ seq: 1, at: "2026-01-01T00:00:00.000Z", type: "sweep", payload: { at: "y" } })).rejects.toThrow(/append seq 1 failed/);
    await j.close();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
describe.skipIf(!DATABASE_URL)("PostgreSQL journal", () => {
  it("round-trips through a real database", async () => {
    const table = `ledger_journal_test_${Date.now()}`;
    const first = await PostgresJournal.connect(DATABASE_URL!, table);
    await first.truncate();
    await roundTrip(first, () => PostgresJournal.connect(DATABASE_URL!, table));
  });
});
