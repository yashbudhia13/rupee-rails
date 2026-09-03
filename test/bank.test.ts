import { describe, expect, it } from "vitest";
import { KYC_LIMITS } from "../src/bank.js";
import { rupees } from "../src/money.js";
import { buildUpiQr, parseUpiQr } from "../src/upi.js";
import { expectInvariant, makeWorld, rejects } from "./helpers.js";

describe("wallets, load and unload", () => {
  it("registers wallets in the core directory and loads e₹ against the bank account", async () => {
    const { bankA, ledger } = await makeWorld();
    const w = await bankA.createWallet({ name: "Asha Patil", kyc: "min", accountBalance: rupees(5_000) });
    expect(w.id).toBe("bank-a:asha-patil");
    expect(ledger.lookupWallet(w.id)?.publicKey).toBe(w.publicKey);

    await bankA.load(w.id, rupees(1_200), "l1");
    expect((await bankA.balance(w.id)).available).toBe(rupees(1_200));
    expect(bankA.wallet(w.id).accountBalance).toBe(rupees(3_800));

    await bankA.unload(w.id, rupees(200), "u1");
    expect((await bankA.balance(w.id)).available).toBe(rupees(1_000));
    expect(bankA.wallet(w.id).accountBalance).toBe(rupees(4_000));
    expectInvariant(ledger);
  });

  it("enforces the KYC balance cap and the account balance", async () => {
    const { bankA } = await makeWorld();
    const w = await bankA.createWallet({ name: "Min", kyc: "min", accountBalance: rupees(50_000) });
    const cap = await rejects(() => bankA.load(w.id, KYC_LIMITS.min.balanceCap + 50, "cap"));
    expect(cap.code).toBe("KYC_BALANCE_CAP");
    await bankA.load(w.id, KYC_LIMITS.min.balanceCap, "exact");
    const poor = await bankA.createWallet({ name: "Poor", kyc: "full", accountBalance: rupees(10) });
    expect((await rejects(() => bankA.load(poor.id, rupees(100), "poor"))).code).toBe("INSUFFICIENT_ACCOUNT");
  });

  it("enforces the daily outgoing cap per wallet and resets the next day", async () => {
    const { bankA, clock } = await makeWorld();
    const a = await bankA.createWallet({ name: "A", kyc: "min", accountBalance: rupees(20_000) });
    const b = await bankA.createWallet({ name: "B", kyc: "full" });
    await bankA.load(a.id, rupees(9_000), "l");
    await bankA.payP2P({ from: a.id, to: b.id, amount: rupees(4_000), requestId: "p1" });
    expect((await rejects(() => bankA.payP2P({ from: a.id, to: b.id, amount: rupees(1_500), requestId: "p2" }))).code).toBe("KYC_DAILY_CAP");
    clock.advanceDays(1);
    await bankA.payP2P({ from: a.id, to: b.id, amount: rupees(1_500), requestId: "p3" });
    expect((await bankA.balance(b.id)).available).toBe(rupees(5_500));
  });
});

describe("payments", () => {
  it("settles cross-bank P2P through the core", async () => {
    const { bankA, bankB, ledger } = await makeWorld();
    const asha = await bankA.createWallet({ name: "Asha", kyc: "full", accountBalance: rupees(10_000) });
    const ravi = await bankB.createWallet({ name: "Ravi", kyc: "full" });
    await bankA.load(asha.id, rupees(1_000), "l");
    const res = await bankA.payP2P({ from: asha.id, to: ravi.id, amount: rupees(650), note: "rent", requestId: "x1" });
    expect(res.txId).toMatch(/^tx_/);
    expect((await bankB.balance(ravi.id)).available).toBe(rupees(650));
    expect((await bankA.balance(asha.id)).available).toBe(rupees(350));
    const entry = ledger.entriesList().find((e) => e.txId === res.txId);
    expect(entry?.summary.memo).toBe("rent");
    expectInvariant(ledger);
  });

  it("pays merchants from a UPI QR and respects fixed amounts", async () => {
    const { bankA, bankB } = await makeWorld();
    const ravi = await bankB.createWallet({ name: "Ravi", kyc: "full", accountBalance: rupees(10_000) });
    await bankB.load(ravi.id, rupees(2_000), "l");
    const shop = await bankA.createWallet({ name: "Shop", kind: "merchant", vpa: "shop@bank-a", mcc: "5411" });
    const fixed = buildUpiQr({ vpa: "shop@bank-a", name: "Shop", amount: rupees(120), mcc: "5411", note: "milk" });
    expect(parseUpiQr(fixed)).toMatchObject({ vpa: "shop@bank-a", amount: rupees(120), mcc: "5411", note: "milk" });

    const paid = await bankB.payQr({ from: ravi.id, qr: fixed, requestId: "q1" });
    expect(paid).toMatchObject({ vpa: "shop@bank-a", amount: rupees(120) });
    expect((await bankA.balance(shop.id)).available).toBe(rupees(120));

    expect((await rejects(() => bankB.payQr({ from: ravi.id, qr: fixed, amount: rupees(100), requestId: "q2" }))).code).toBe("AMOUNT_MISMATCH");
    expect((await rejects(() => bankB.payQr({ from: ravi.id, qr: buildUpiQr({ vpa: "shop@bank-a" }), requestId: "q3" }))).code).toBe("AMOUNT_REQUIRED");
    expect((await rejects(() => bankB.payQr({ from: ravi.id, qr: buildUpiQr({ vpa: "nobody@bank-a" }), amount: 100, requestId: "q4" }))).code).toBe("UNKNOWN_WALLET");
    expect((await rejects(() => bankB.payQr({ from: ravi.id, qr: "https://example.com", amount: 100, requestId: "q5" }))).code).toBe("INVALID_QR");
  });

  it("refuses payments to wallets that are not persons or merchants", async () => {
    const { bankA } = await makeWorld();
    const a = await bankA.createWallet({ name: "A", kyc: "full", accountBalance: rupees(1_000) });
    await bankA.load(a.id, rupees(500), "l");
    expect((await rejects(() => bankA.payP2P({ from: a.id, to: "bank-a:pool", amount: 100, requestId: "p" }))).code).toBe("NOT_PAYABLE");
    expect((await rejects(() => bankA.payP2P({ from: a.id, to: "bank-z:nobody", amount: 100, requestId: "p2" }))).code).toBe("UNKNOWN_WALLET");
  });
});

describe("audit trail and reserves", () => {
  it("records every action with before and after balances and the outcome", async () => {
    const { bankA } = await makeWorld();
    const a = await bankA.createWallet({ name: "A", kyc: "min", accountBalance: rupees(1_000) });
    await bankA.load(a.id, rupees(500), "load-1");
    await rejects(() => bankA.load(a.id, rupees(5_000), "load-2"));
    const log = bankA.auditLog();
    const ok = log.find((e) => e.requestId === "load-1");
    expect(ok?.outcome).toBe("ok");
    expect((ok?.detail.before as { available: number }).available).toBe(0);
    expect((ok?.detail.after as { available: number }).available).toBe(rupees(500));
    const bad = log.find((e) => e.requestId === "load-2");
    expect(bad?.outcome).toBe("rejected");
    expect(bad?.detail.code).toBe("INSUFFICIENT_ACCOUNT");
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
  });

  it("redeems pool tokens back to the RBI and credits the reserve", async () => {
    const { bankA, ledger } = await makeWorld();
    const before = ledger.reserveOf("bank-a");
    const res = await bankA.redeem(rupees(12_345.5), "redeem-1");
    expect(res.amount).toBe(rupees(12_345.5));
    expect(ledger.reserveOf("bank-a") - before).toBe(rupees(12_345.5));
    expectInvariant(ledger);
  });
});
