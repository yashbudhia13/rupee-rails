import { describe, expect, it } from "vitest";
import { rupees } from "../src/money.js";
import { evaluateRules, haversineMeters, type TokenRules } from "../src/rules.js";
import { buildUpiQr } from "../src/upi.js";
import { expectInvariant, makeWorld, rejects } from "./helpers.js";

const belagavi = { lat: 15.85, lng: 74.5 };
const bengaluru = { lat: 12.97, lng: 77.59 };

describe("evaluateRules", () => {
  const rules: TokenRules = {
    purpose: "FERT-SUBSIDY-2026",
    returnTo: "a".repeat(64),
    mccAllowlist: ["0763"],
    expiresAt: "2026-12-01T00:00:00.000Z",
    geofence: { ...belagavi, radiusM: 50_000 },
  };
  const at = "2026-09-03T00:00:00.000Z";

  it("passes a qualifying spend", () => {
    expect(evaluateRules(rules, { at, recipientMcc: "0763", location: { lat: 15.87, lng: 74.52 } })).toBeNull();
  });
  it("checks expiry first", () => {
    expect(evaluateRules(rules, { at: "2026-12-02T00:00:00.000Z", recipientMcc: "0763", location: belagavi })?.code).toBe("EXPIRED");
  });
  it("requires a merchant in the allowlist", () => {
    expect(evaluateRules(rules, { at, location: belagavi })?.code).toBe("MERCHANT_REQUIRED");
    expect(evaluateRules(rules, { at, recipientMcc: "5411", location: belagavi })?.code).toBe("MCC_NOT_ALLOWED");
  });
  it("requires a location inside the fence", () => {
    expect(evaluateRules(rules, { at, recipientMcc: "0763" })?.code).toBe("LOCATION_REQUIRED");
    expect(evaluateRules(rules, { at, recipientMcc: "0763", location: bengaluru })?.code).toBe("OUTSIDE_GEOFENCE");
  });
  it("measures distance sensibly", () => {
    const km = haversineMeters(belagavi, bengaluru) / 1000;
    expect(km).toBeGreaterThan(400);
    expect(km).toBeLessThan(500);
  });
});

describe("purpose-bound tokens on the ledger", () => {
  async function scheme() {
    const w = await makeWorld();
    const scheme = await w.bankA.createWallet({ name: "Fertiliser Subsidy", kind: "scheme", accountBalance: rupees(100_000) });
    await w.bankA.load(scheme.id, rupees(50_000), "load-scheme");
    const farmer = await w.bankA.createWallet({ name: "Asha", kyc: "min", accountBalance: rupees(10_000) });
    const dealer = await w.bankA.createWallet({ name: "Kisan Agro", kind: "merchant", vpa: "kisan@bank-a", mcc: "0763" });
    const grocery = await w.bankB.createWallet({ name: "Nandini", kind: "merchant", vpa: "nandini@bank-b", mcc: "5411" });
    const rules = {
      purpose: "FERT-SUBSIDY-2026",
      mccAllowlist: ["0763"],
      expiresAt: new Date(w.clock.now.getTime() + 90 * 86_400_000).toISOString(),
      geofence: { ...belagavi, radiusM: 50_000 },
    };
    await w.bankA.disburse({ schemeWalletId: scheme.id, to: farmer.id, amount: rupees(2_000), rules, requestId: "dbt-1" });
    return { ...w, scheme, farmer, dealer, grocery, rules };
  }

  it("disburses with rules attached and reports them by purpose", async () => {
    const { bankA, farmer, ledger } = await scheme();
    const b = await bankA.balance(farmer.id);
    expect(b.available).toBe(0);
    expect(b.byPurpose["FERT-SUBSIDY-2026"]).toBe(rupees(2_000));
    expectInvariant(ledger);
  });

  it("refuses the wrong merchant and the wrong place, and records the violation", async () => {
    const { bankA, farmer } = await scheme();
    const wrongMcc = await rejects(() =>
      bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "nandini@bank-b", mcc: "5411" }), amount: rupees(300), purpose: "FERT-SUBSIDY-2026", location: belagavi, requestId: "r1" }),
    );
    expect(wrongMcc.code).toBe("RULE_VIOLATION");
    expect(wrongMcc.details?.violation).toBe("MCC_NOT_ALLOWED");

    const wrongPlace = await rejects(() =>
      bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "kisan@bank-a", mcc: "0763" }), amount: rupees(300), purpose: "FERT-SUBSIDY-2026", location: bengaluru, requestId: "r2" }),
    );
    expect(wrongPlace.details?.violation).toBe("OUTSIDE_GEOFENCE");

    const audit = bankA.auditLog().filter((e) => e.action === "pay.qr" && e.outcome === "rejected");
    expect(audit).toHaveLength(2);
  });

  it("releases rules on a qualifying spend and keeps them on the change", async () => {
    const { bankA, farmer, dealer, ledger } = await scheme();
    await bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "kisan@bank-a", mcc: "0763" }), amount: rupees(1_500), purpose: "FERT-SUBSIDY-2026", location: { lat: 15.86, lng: 74.51 }, requestId: "ok" });
    const farmerBal = await bankA.balance(farmer.id);
    expect(farmerBal.byPurpose["FERT-SUBSIDY-2026"]).toBe(rupees(500));
    const dealerBal = await bankA.balance(dealer.id);
    expect(dealerBal.available).toBe(rupees(1_500));
    expect(dealerBal.byPurpose).toEqual({});
    expectInvariant(ledger);
  });

  it("cannot spend purpose-bound tokens without naming the purpose, nor unrestricted ones as if bound", async () => {
    const { bankA, farmer } = await scheme();
    const noFunds = await rejects(() => bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "kisan@bank-a", mcc: "0763" }), amount: rupees(100), requestId: "nf" }));
    expect(noFunds.code).toBe("INSUFFICIENT_FUNDS");
    const wrongPurpose = await rejects(() => bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "kisan@bank-a", mcc: "0763" }), amount: rupees(100), purpose: "OTHER", requestId: "wp" }));
    expect(wrongPurpose.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("sweeps expired tokens back to the scheme wallet", async () => {
    const { bankA, farmer, scheme: schemeWallet, ledger, clock } = await scheme();
    const before = await bankA.balance(schemeWallet.id);
    clock.advanceDays(91);
    const expired = await rejects(() =>
      bankA.payQr({ from: farmer.id, qr: buildUpiQr({ vpa: "kisan@bank-a", mcc: "0763" }), amount: rupees(100), purpose: "FERT-SUBSIDY-2026", location: belagavi, requestId: "late" }),
    );
    expect(expired.details?.violation).toBe("EXPIRED");
    const swept = ledger.sweepExpired();
    expect(swept.swept.reduce((a, t) => a + t.amount, 0)).toBe(rupees(2_000));
    const after = await bankA.balance(schemeWallet.id);
    expect(after.available - before.available).toBe(rupees(2_000));
    expect((await bankA.balance(farmer.id)).byPurpose).toEqual({});
    expectInvariant(ledger);
    expect(ledger.sweepExpired().swept).toHaveLength(0);
  });
});
