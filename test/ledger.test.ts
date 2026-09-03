import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/crypto.js";
import { CoreLedger } from "../src/ledger.js";
import { DENOMINATIONS_PAISE, rupees, sum } from "../src/money.js";
import { expectInvariant, makeClock, rbiSigner, rejects, signedTransfer } from "./helpers.js";

async function setup() {
  const clock = makeClock();
  const rbi = generateKeyPair();
  const ledger = new CoreLedger(rbi.publicKey, { clock: () => clock.now });
  const sign = rbiSigner(rbi);
  const pool = generateKeyPair();
  await ledger.registerBank("bank-a", pool.publicKey, rupees(100_000));
  return { clock, rbi, ledger, sign, pool };
}

describe("mint and issue", () => {
  it("mints only with the RBI signature and in standard denominations", async () => {
    const { ledger, sign } = await setup();
    const res = await ledger.mint(sign("mint", { amount: rupees(1_234.5), idempotencyKey: "m1", signature: "" }));
    expect(sum(res.tokens.map((t) => t.amount))).toBe(rupees(1_234.5));
    for (const t of res.tokens) expect(DENOMINATIONS_PAISE).toContain(t.amount);
    expect(ledger.balanceOf(ledger.rbiPublicKey)).toBe(rupees(1_234.5));
    expectInvariant(ledger);

    const impostor = rbiSigner(generateKeyPair());
    const err = await rejects(() => ledger.mint(impostor("mint", { amount: rupees(10), idempotencyKey: "m2", signature: "" })));
    expect(err.code).toBe("BAD_SIGNATURE");
  });

  it("rejects amounts that are not payable in denominations", async () => {
    const { ledger, sign } = await setup();
    await expect(ledger.mint(sign("mint", { amount: 75, idempotencyKey: "m1", signature: "" }))).rejects.toThrow(/multiple of 50/);
    await expect(ledger.mint(sign("mint", { amount: -100, idempotencyKey: "m2", signature: "" }))).rejects.toThrow(/positive/);
  });

  it("issues to a bank against its reserve and refuses beyond it", async () => {
    const { ledger, sign, pool } = await setup();
    await ledger.mint(sign("mint", { amount: rupees(500_000), idempotencyKey: "m1", signature: "" }));
    await ledger.issue(sign("issue", { bankId: "bank-a", amount: rupees(60_000), idempotencyKey: "i1", signature: "" }));
    expect(ledger.reserveOf("bank-a")).toBe(rupees(40_000));
    expect(ledger.balanceOf(pool.publicKey)).toBe(rupees(60_000));
    expect(ledger.balanceOf(ledger.rbiPublicKey)).toBe(rupees(440_000));
    const err = await rejects(() => ledger.issue(sign("issue", { bankId: "bank-a", amount: rupees(50_000), idempotencyKey: "i2", signature: "" })));
    expect(err.code).toBe("INSUFFICIENT_RESERVE");
    expectInvariant(ledger);
  });

  it("burns RBI-held tokens and keeps conservation", async () => {
    const { ledger, sign } = await setup();
    const minted = await ledger.mint(sign("mint", { amount: rupees(1_000), idempotencyKey: "m1", signature: "" }));
    const inputs = minted.tokens.slice(0, 2).map((t) => t.id);
    const burned = await ledger.burn(sign("burn", { inputs, idempotencyKey: "b1", signature: "" }));
    expect(burned.amount).toBe(sum(minted.tokens.slice(0, 2).map((t) => t.amount)));
    const inv = ledger.invariants();
    expect(inv.ok).toBe(true);
    expect(inv.unspentTotal).toBe(inv.minted - inv.burned);
  });
});

describe("transfers", () => {
  async function funded() {
    const w = await setup();
    await w.ledger.mint(w.sign("mint", { amount: rupees(100_000), idempotencyKey: "m1", signature: "" }));
    await w.ledger.issue(w.sign("issue", { bankId: "bank-a", amount: rupees(50_000), idempotencyKey: "i1", signature: "" }));
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await w.ledger.registerWallet({ walletId: "bank-a:alice", bankId: "bank-a", publicKey: alice.publicKey, kind: "person", name: "Alice", frozen: false });
    await w.ledger.registerWallet({ walletId: "bank-a:bob", bankId: "bank-a", publicKey: bob.publicKey, kind: "person", name: "Bob", frozen: false });
    return { ...w, alice, bob };
  }

  it("spends inputs, re-denominates outputs and returns change", async () => {
    const { ledger, pool, alice } = await funded();
    const inputs = ledger.selectInputs(pool.publicKey, rupees(1_250));
    const total = sum(inputs.map((t) => t.amount));
    const res = await ledger.transfer(
      signedTransfer(pool, inputs, [
        { owner: alice.publicKey, amount: rupees(1_250) },
        { owner: pool.publicKey, amount: total - rupees(1_250) },
      ], "t1"),
    );
    expect(ledger.balanceOf(alice.publicKey)).toBe(rupees(1_250));
    for (const t of inputs) expect(ledger.getToken(t.id)?.spentBy).toBe(res.txId);
    expect(res.outputs.every((t) => DENOMINATIONS_PAISE.includes(t.amount))).toBe(true);
    expectInvariant(ledger);
  });

  it("rejects unbalanced, unsigned, foreign-signed and double-spent transfers", async () => {
    const { ledger, pool, alice, bob } = await funded();
    const inputs = ledger.selectInputs(pool.publicKey, rupees(100));
    const total = sum(inputs.map((t) => t.amount));

    expect((await rejects(() => ledger.transfer(signedTransfer(pool, inputs, [{ owner: alice.publicKey, amount: total + 50 }], "u1")))).code).toBe("UNBALANCED");
    expect((await rejects(() => ledger.transfer(signedTransfer(bob, inputs, [{ owner: alice.publicKey, amount: total }], "u2")))).code).toBe("BAD_SIGNATURE");
    expect((await rejects(() => ledger.transfer({ ...signedTransfer(pool, inputs, [{ owner: alice.publicKey, amount: total }], "u3"), signature: "" }))).code).toBe("BAD_SIGNATURE");

    await ledger.transfer(signedTransfer(pool, inputs, [{ owner: alice.publicKey, amount: total }], "ok"));
    expect((await rejects(() => ledger.transfer(signedTransfer(pool, inputs, [{ owner: bob.publicKey, amount: total }], "replay")))).code).toBe("ALREADY_SPENT");
    expectInvariant(ledger);
  });

  it("rejects inputs from different owners and outputs to frozen wallets", async () => {
    const { ledger, pool, alice, bob } = await funded();
    const a = ledger.selectInputs(pool.publicKey, rupees(100));
    await ledger.transfer(signedTransfer(pool, a, [{ owner: alice.publicKey, amount: sum(a.map((t) => t.amount)) }], "fund-alice"));
    const mixed = [...ledger.selectInputs(pool.publicKey, 50), ...ledger.selectInputs(alice.publicKey, 50)];
    const err = await rejects(() => ledger.transfer(signedTransfer(pool, mixed, [{ owner: bob.publicKey, amount: sum(mixed.map((t) => t.amount)) }], "mixed")));
    expect(err.code).toBe("MIXED_OWNERS");

    await ledger.setFrozen("bank-a:bob", true);
    const aliceIn = ledger.selectInputs(alice.publicKey, 50);
    const frozen = await rejects(() => ledger.transfer(signedTransfer(alice, aliceIn, [{ owner: bob.publicKey, amount: sum(aliceIn.map((t) => t.amount)) }], "to-frozen")));
    expect(frozen.code).toBe("FROZEN");
  });

  it("is idempotent per key and rejects a reused key with a different payload", async () => {
    const { ledger, pool, alice } = await funded();
    const inputs = ledger.selectInputs(pool.publicKey, rupees(100));
    const total = sum(inputs.map((t) => t.amount));
    const req = signedTransfer(pool, inputs, [{ owner: alice.publicKey, amount: total }], "same-key");
    const first = await ledger.transfer(req);
    const second = await ledger.transfer(req);
    expect(second.txId).toBe(first.txId);
    expect(second).toEqual(first);
    expect(ledger.balanceOf(alice.publicKey)).toBe(total);
    expect(ledger.entriesList().filter((e) => e.type === "transfer")).toHaveLength(1);

    const other = signedTransfer(alice, ledger.selectInputs(alice.publicKey, 50), [{ owner: pool.publicKey, amount: 50 }], "same-key");
    expect((await rejects(() => ledger.transfer(other))).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("serialises concurrent transfers so a token is never spent twice", async () => {
    const { ledger, pool, alice, bob } = await funded();
    const inputs = ledger.selectInputs(pool.publicKey, rupees(100));
    const total = sum(inputs.map((t) => t.amount));
    const toAlice = signedTransfer(pool, inputs, [{ owner: alice.publicKey, amount: total }], "race-a");
    const toBob = signedTransfer(pool, inputs, [{ owner: bob.publicKey, amount: total }], "race-b");
    const results = await Promise.allSettled([ledger.transfer(toAlice), ledger.transfer(toBob)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code: string }).code).toBe("ALREADY_SPENT");
    expect(ledger.balanceOf(alice.publicKey) + ledger.balanceOf(bob.publicKey)).toBe(total);
    expectInvariant(ledger);
  });
});

describe("hash chain", () => {
  it("links every entry to the previous one and verifies", async () => {
    const { ledger, sign } = await setup();
    await ledger.mint(sign("mint", { amount: rupees(10), idempotencyKey: "m1", signature: "" }));
    await ledger.mint(sign("mint", { amount: rupees(20), idempotencyKey: "m2", signature: "" }));
    const entries = ledger.entriesList();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.prevHash).toBe("0".repeat(64));
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(ledger.verifyChain()).toBe(true);
    expect(ledger.invariants().chainOk).toBe(true);
  });

  it("derives transaction and token ids from the request, not from randomness", async () => {
    const a = await setup();
    const b = await setup();
    const req = { amount: rupees(300), idempotencyKey: "same", signature: "" };
    const ra = await a.ledger.mint(a.sign("mint", req));
    const rb = await b.ledger.mint(b.sign("mint", req));
    // Different RBI keys give different signatures and therefore different ids...
    expect(ra.txId).not.toBe(rb.txId);
    // ...but the same signed request on two ledgers gives the same ids.
    const c = new CoreLedger(a.rbi.publicKey);
    const rc = await c.mint(a.sign("mint", req));
    expect(rc.txId).toBe(ra.txId);
    expect(rc.tokens.map((t) => t.id)).toEqual(ra.tokens.map((t) => t.id));
  });
});
