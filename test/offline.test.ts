import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/crypto.js";
import { rupees } from "../src/money.js";
import { OfflineWallet, verifyVoucher } from "../src/offline.js";
import { expectInvariant, makeWorld } from "./helpers.js";

async function offlineWorld() {
  const w = await makeWorld();
  const payer = await w.bankB.createWallet({ name: "Ravi", kyc: "full", accountBalance: rupees(10_000) });
  const dealer = await w.bankA.createWallet({ name: "Dealer", kind: "merchant", vpa: "dealer@bank-a", mcc: "0763" });
  const grocery = await w.bankB.createWallet({ name: "Grocery", kind: "merchant", vpa: "grocery@bank-b", mcc: "5411" });
  await w.bankB.load(payer.id, rupees(1_000), "load");
  const directory = (id: string) => w.bankA.publicKeyOf(id) ?? w.bankB.publicKeyOf(id);
  const payerDevice = new OfflineWallet(payer.id, w.bankB.exportKeys(payer.id), directory);
  const dealerDevice = new OfflineWallet(dealer.id, w.bankA.exportKeys(dealer.id), directory);
  const groceryDevice = new OfflineWallet(grocery.id, w.bankB.exportKeys(grocery.id), directory);
  const prefund = await w.bankB.prefundOffline(payer.id, rupees(300), "prefund");
  payerDevice.fund(prefund.offline);
  return { ...w, payer, dealer, grocery, payerDevice, dealerDevice, groceryDevice };
}

describe("vouchers on the device", () => {
  it("issues signed, counter-linked vouchers and refuses to overspend the offline balance", async () => {
    const { payerDevice, dealer } = await offlineWorld();
    const v1 = payerDevice.createVoucher(dealer.id, rupees(100));
    const v2 = payerDevice.createVoucher(dealer.id, rupees(100));
    expect(verifyVoucher(v1)).toBe(true);
    expect(v2.counter).toBe(v1.counter + 1);
    expect(v2.prevHash).not.toBe(v1.prevHash);
    expect(payerDevice.balance).toBe(rupees(100));
    expect(() => payerDevice.createVoucher(dealer.id, rupees(150))).toThrow(/offline balance/);
  });

  it("verifies incoming vouchers against the cached directory", async () => {
    const { payerDevice, dealerDevice, dealer, payer } = await offlineWorld();
    const good = payerDevice.createVoucher(dealer.id, rupees(50));
    dealerDevice.receiveVoucher(good);
    expect(dealerDevice.pendingVouchers()).toHaveLength(1);

    const forged = { ...payerDevice.createVoucher(dealer.id, rupees(50)), amount: rupees(250) };
    expect(() => dealerDevice.receiveVoucher(forged)).toThrow(/signature/);

    const stranger = new OfflineWallet("bank-z:stranger", generateKeyPair(), () => undefined);
    stranger.fund(rupees(100));
    expect(() => dealerDevice.receiveVoucher(stranger.createVoucher(dealer.id, rupees(50)))).toThrow(/no cached key/);

    const impostor = new OfflineWallet(payer.id, generateKeyPair(), () => undefined);
    impostor.fund(rupees(100));
    expect(() => dealerDevice.receiveVoucher(impostor.createVoucher(dealer.id, rupees(50)))).toThrow(/does not match/);
  });
});

describe("settlement at the bank", () => {
  it("credits the payee on sync, draws down escrow, and is idempotent", async () => {
    const { bankA, bankB, ledger, payer, dealer, payerDevice, dealerDevice } = await offlineWorld();
    const v = payerDevice.createVoucher(dealer.id, rupees(100));
    dealerDevice.receiveVoucher(v);
    const first = await bankB.syncVouchers(dealerDevice.pendingVouchers(), "s1");
    expect(first[0]).toMatchObject({ voucherId: v.id, ok: true });
    expect((await bankA.balance(dealer.id)).available).toBe(rupees(100));
    expect((await bankB.balance(payer.id)).offline).toBe(rupees(200));
    const again = await bankB.syncVouchers([v], "s2");
    expect(again[0]).toMatchObject({ ok: false, code: "DUPLICATE_VOUCHER" });
    expect((await bankA.balance(dealer.id)).available).toBe(rupees(100));
    expectInvariant(ledger);
  });

  it("detects a cloned device spending the same counter twice and freezes the payer", async () => {
    const { bankA, bankB, ledger, payer, dealer, grocery, payerDevice, dealerDevice, groceryDevice } = await offlineWorld();
    const clone = payerDevice.clone();
    const va = payerDevice.createVoucher(dealer.id, rupees(100));
    const vb = clone.createVoucher(grocery.id, rupees(100));
    expect(va.counter).toBe(vb.counter);
    dealerDevice.receiveVoucher(va);
    groceryDevice.receiveVoucher(vb);

    const r1 = await bankB.syncVouchers([va], "sa");
    expect(r1[0]?.ok).toBe(true);
    const r2 = await bankB.syncVouchers([vb], "sb");
    expect(r2[0]).toMatchObject({ ok: false, code: "DOUBLE_SPEND" });
    expect(bankB.wallet(payer.id).frozen).toBe(true);
    expect(ledger.lookupWallet(payer.id)?.frozen).toBe(true);
    expect((await bankA.balance(dealer.id)).available).toBe(rupees(100));
    expect((await bankB.balance(grocery.id)).available).toBe(0);

    // Once frozen, even an honest later voucher is held.
    const later = payerDevice.createVoucher(dealer.id, rupees(50));
    const r3 = await bankB.syncVouchers([later], "sc");
    expect(r3[0]).toMatchObject({ ok: false, code: "FROZEN" });
    expectInvariant(ledger);
  });

  it("detects vouchers beyond the escrowed amount", async () => {
    const { bankB, payer, dealer, payerDevice } = await offlineWorld();
    payerDevice.fund(rupees(1_000)); // a tampered device claims more than the bank escrowed
    const big = payerDevice.createVoucher(dealer.id, rupees(800));
    const r = await bankB.syncVouchers([big], "over");
    expect(r[0]).toMatchObject({ ok: false, code: "OVERSPEND" });
    expect(bankB.wallet(payer.id).frozen).toBe(true);
  });

  it("only settles vouchers from its own customers", async () => {
    const { bankA, dealer, payerDevice } = await offlineWorld();
    const v = payerDevice.createVoucher(dealer.id, rupees(100));
    const r = await bankA.syncVouchers([v], "wrong-bank");
    expect(r[0]).toMatchObject({ ok: false, code: "WRONG_BANK" });
  });
});
