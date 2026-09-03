/**
 * Cross-language contract test: vouchers signed by the C++ secure element must
 * verify in TypeScript and settle at the bank; a cloned state file must be
 * caught as a double-spend. Skipped when the native binary is not built
 * (`npm run build:native`). CI always builds it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rupees } from "../src/money.js";
import { OfflineWallet, verifyVoucher, voucherHash } from "../src/offline.js";
import { SecureElementDevice, secureElementAvailable, seedHex } from "../src/secure-element.js";
import { expectInvariant, makeWorld } from "./helpers.js";

const available = secureElementAvailable();

describe.skipIf(!available)("C++ secure element interop", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rupee-se-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function world() {
    const w = await makeWorld();
    const payer = await w.bankB.createWallet({ name: "Ravi", kyc: "full", accountBalance: rupees(10_000) });
    const dealer = await w.bankA.createWallet({ name: "Dealer", kind: "merchant", vpa: "dealer@bank-a", mcc: "0763" });
    const grocery = await w.bankB.createWallet({ name: "Grocery", kind: "merchant", vpa: "grocery@bank-b", mcc: "5411" });
    await w.bankB.load(payer.id, rupees(1_000), "load");
    const prefund = await w.bankB.prefundOffline(payer.id, rupees(300), "prefund");
    const device = SecureElementDevice.enrol({
      stateFile: path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`),
      walletId: payer.id,
      seedHex: seedHex(w.bankB.exportKeys(payer.id).privateKey),
    });
    device.fund(prefund.offline);
    const directory = (id: string) => w.bankA.publicKeyOf(id) ?? w.bankB.publicKeyOf(id);
    const dealerDevice = new OfflineWallet(dealer.id, w.bankA.exportKeys(dealer.id), directory);
    return { ...w, payer, dealer, grocery, device, dealerDevice };
  }

  it("derives the same public key the bank registered from the seed", async () => {
    const { device, payer } = await world();
    const state = device.state();
    expect(state.publicKey).toBe(payer.publicKey);
    expect(state.balance).toBe(rupees(300));
    expect(state.counter).toBe(0);
  });

  it("signs vouchers that TypeScript verifies, hashes identically, and the bank settles", async () => {
    const { device, dealer, dealerDevice, bankA, bankB, payer, ledger, clock } = await world();
    const v = device.createVoucher(dealer.id, rupees(100), clock.now);
    expect(v.from).toBe(payer.id);
    expect(v.counter).toBe(1);
    expect(verifyVoucher(v)).toBe(true);
    const native = SecureElementDevice.verify(v);
    expect(native.ok).toBe(true);
    expect(native.hash).toBe(voucherHash(v));

    dealerDevice.receiveVoucher(v); // the payee's (TypeScript) device accepts it offline
    const result = await bankB.syncVouchers(dealerDevice.pendingVouchers(), "sync");
    expect(result[0]).toMatchObject({ voucherId: v.id, ok: true });
    expect((await bankA.balance(dealer.id)).available).toBe(rupees(100));
    expect((await bankB.balance(payer.id)).offline).toBe(rupees(200));
    expect(device.state().balance).toBe(rupees(200));
    expectInvariant(ledger);
  });

  it("chains vouchers by hash and refuses to overspend without burning a counter", async () => {
    const { device, dealer, clock } = await world();
    const v1 = device.createVoucher(dealer.id, rupees(100), clock.now);
    const v2 = device.createVoucher(dealer.id, rupees(100), clock.now);
    expect(v2.prevHash).toBe(voucherHash(v1));
    expect(() => device.createVoucher(dealer.id, rupees(150), clock.now)).toThrow(/insufficient offline balance/);
    expect(device.state().counter).toBe(2);
  });

  it("catches a cloned state file spending the same counter twice", async () => {
    const { device, dealer, grocery, bankB, payer, clock, ledger } = await world();
    const clone = device.clone(device.stateFile.replace(/\.json$/, ".clone.json"));
    const a = device.createVoucher(dealer.id, rupees(100), clock.now);
    const b = clone.createVoucher(grocery.id, rupees(100), clock.now);
    expect(a.counter).toBe(b.counter);
    expect(verifyVoucher(a) && verifyVoucher(b)).toBe(true);

    const first = await bankB.syncVouchers([a], "s1");
    const second = await bankB.syncVouchers([b], "s2");
    expect(first[0]?.ok).toBe(true);
    expect(second[0]).toMatchObject({ ok: false, code: "DOUBLE_SPEND" });
    expect(bankB.wallet(payer.id).frozen).toBe(true);
    expectInvariant(ledger);
  });
});
