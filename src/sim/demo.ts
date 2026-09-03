/**
 * End-to-end scenario, in process. `npm run demo`.
 *
 *   1. RBI mints; two banks receive e₹ against their reserves.
 *   2. Customers load wallets; P2P across banks; P2M via a UPI QR.
 *   3. A subsidy scheme disburses purpose-bound tokens; wrong merchant and
 *      wrong place are rejected; the right dealer is paid; the rest expires
 *      and is swept back.
 *   4. Offline: prefund, pay by voucher, sync. Then a cloned device tries to
 *      spend the same counter twice and gets caught.
 *
 * The conservation invariant is checked after every step.
 */
import { BankTier, type Wallet } from "../bank.js";
import { InProcessCoreClient } from "../core-client.js";
import { generateKeyPair, signCanonical } from "../crypto.js";
import { CoreLedger, LedgerError, signingPayload } from "../ledger.js";
import { formatInr, rupees } from "../money.js";
import { OfflineWallet } from "../offline.js";
import { buildUpiQr } from "../upi.js";

let now = new Date("2026-09-03T09:00:00.000Z");
const clock = () => now;
const advanceDays = (d: number) => (now = new Date(now.getTime() + d * 86_400_000));

let step = 0;
function log(title: string, ...lines: string[]): void {
  step += 1;
  console.log(`\n${String(step).padStart(2, "0")}. ${title}`);
  for (const l of lines) console.log(`    ${l}`);
}

async function expectRejection(label: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error(`${label}: expected a rejection`);
  } catch (err) {
    if (err instanceof LedgerError || (err as { code?: string }).code) {
      const e = err as { code: string; message: string; details?: Record<string, unknown> };
      return `${label}: rejected ${e.details?.violation ?? e.code} (${e.message})`;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const rbi = generateKeyPair();
  const ledger = new CoreLedger(rbi.publicKey, clock);
  const core = new InProcessCoreClient(ledger);
  const check = (label: string) => {
    const inv = ledger.invariants();
    if (!inv.ok) throw new Error(`invariant broken after ${label}: ${inv.problems.join("; ")}`);
    return `invariant ok: unspent ${formatInr(inv.unspentTotal)} = minted ${formatInr(inv.minted)} - burned ${formatInr(inv.burned)}, ${inv.entries} entries, chain intact`;
  };
  const rbiSign = <T extends { signature: string }>(type: string, req: T): T => ({ ...req, signature: signCanonical(rbi.privateKey, signingPayload(type, req)) });

  // 1. Central bank and two banks
  const bankA = await BankTier.create("bank-a", core, { clock, openingReserve: rupees(10_000_000) });
  const bankB = await BankTier.create("bank-b", core, { clock, openingReserve: rupees(10_000_000) });
  ledger.mint(rbiSign("mint", { amount: rupees(2_000_000), idempotencyKey: "mint-1", signature: "" }));
  ledger.issue(rbiSign("issue", { bankId: "bank-a", amount: rupees(1_000_000), idempotencyKey: "issue-a", signature: "" }));
  ledger.issue(rbiSign("issue", { bankId: "bank-b", amount: rupees(1_000_000), idempotencyKey: "issue-b", signature: "" }));
  log(
    "RBI mints ₹20,00,000 and issues ₹10,00,000 to each bank against reserves",
    `bank-a reserve now ${formatInr(ledger.reserveOf("bank-a"))}, pool ${formatInr(ledger.balanceOf(bankA.poolPublicKey))}`,
    check("issue"),
  );

  // 2. Customers and merchants
  const asha = await bankA.createWallet({ name: "Asha Patil", kyc: "min", accountBalance: rupees(50_000) });
  const ravi = await bankB.createWallet({ name: "Ravi Kumar", kyc: "full", accountBalance: rupees(200_000) });
  const grocery = await bankB.createWallet({ name: "Nandini Stores", kind: "merchant", vpa: "nandini.stores@bank-b", mcc: "5411" });
  const dealer = await bankA.createWallet({ name: "Kisan Agro Dealer", kind: "merchant", vpa: "kisan.agro@bank-a", mcc: "0763" });
  const farDealer = await bankB.createWallet({ name: "Far Away Agro", kind: "merchant", vpa: "far.agro@bank-b", mcc: "0763" });
  await bankA.load(asha.id, rupees(2_000), "load-asha-1");
  await bankB.load(ravi.id, rupees(20_000), "load-ravi-1");
  log(
    "Wallets opened and loaded from bank accounts",
    `${asha.name} (min KYC) ${formatInr((await bankA.balance(asha.id)).total)}, ${ravi.name} (full KYC) ${formatInr((await bankB.balance(ravi.id)).total)}`,
    check("load"),
  );

  const capHit = await expectRejection("min-KYC wallet loading ₹9,000 more (cap ₹10,000)", () => bankA.load(asha.id, rupees(9_000), "load-asha-cap"));
  log("KYC limits are enforced at the bank tier", capHit);

  // 3. P2P across banks and P2M via UPI QR
  await bankA.payP2P({ from: asha.id, to: ravi.id, amount: rupees(500), note: "lunch", requestId: "p2p-1" });
  const qr = buildUpiQr({ vpa: "nandini.stores@bank-b", name: "Nandini Stores", amount: rupees(120), mcc: "5411" });
  const paid = await bankB.payQr({ from: ravi.id, qr, requestId: "qr-1" });
  log(
    "Cross-bank P2P and a UPI-QR merchant payment",
    `Asha -> Ravi ₹500 settled through the core; Ravi scanned ${qr}`,
    `paid ${formatInr(paid.amount)} to ${paid.vpa}; ${grocery.name} now holds ${formatInr((await bankB.balance(grocery.id)).available)}`,
    check("payments"),
  );

  // 4. Programmable money: a fertiliser subsidy
  const scheme = await bankA.createWallet({ name: "PM Fertiliser Subsidy 2026", kind: "scheme", accountBalance: rupees(500_000) });
  await bankA.load(scheme.id, rupees(100_000), "load-scheme");
  const district = { lat: 15.85, lng: 74.5 }; // Belagavi
  await bankA.disburse({
    schemeWalletId: scheme.id,
    to: asha.id,
    amount: rupees(2_000),
    rules: {
      purpose: "FERT-SUBSIDY-2026",
      mccAllowlist: ["0763"],
      expiresAt: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
      geofence: { ...district, radiusM: 50_000 },
    },
    requestId: "dbt-asha",
  });
  const ashaBal = await bankA.balance(asha.id);
  log(
    "Scheme disburses ₹2,000 of purpose-bound e₹ to Asha (MCC 0763 only, 90 days, within 50 km of Belagavi)",
    `Asha: ${formatInr(ashaBal.available)} unrestricted + ${formatInr(ashaBal.byPurpose["FERT-SUBSIDY-2026"] ?? 0)} FERT-SUBSIDY-2026`,
    check("disburse"),
  );

  const groceryQr = buildUpiQr({ vpa: "nandini.stores@bank-b", mcc: "5411" });
  const wrongMerchant = await expectRejection("subsidy at a grocery", () =>
    bankA.payQr({ from: asha.id, qr: groceryQr, amount: rupees(300), purpose: "FERT-SUBSIDY-2026", location: district, requestId: "sub-grocery" }),
  );
  const wrongPlace = await expectRejection("subsidy at a dealer 400 km away", () =>
    bankA.payQr({ from: asha.id, qr: buildUpiQr({ vpa: "far.agro@bank-b", mcc: "0763" }), amount: rupees(300), purpose: "FERT-SUBSIDY-2026", location: { lat: 12.97, lng: 77.59 }, requestId: "sub-far" }),
  );
  const rightSpend = await bankA.payQr({
    from: asha.id,
    qr: buildUpiQr({ vpa: "kisan.agro@bank-a", mcc: "0763" }),
    amount: rupees(1_500),
    purpose: "FERT-SUBSIDY-2026",
    location: { lat: 15.87, lng: 74.52 },
    requestId: "sub-ok",
  });
  const afterSpend = await bankA.balance(asha.id);
  log(
    "The core enforces the rules on every spend",
    wrongMerchant,
    wrongPlace,
    `dealer inside the zone: paid ${formatInr(rightSpend.amount)} (tx ${rightSpend.txId}); change ${formatInr(afterSpend.byPurpose["FERT-SUBSIDY-2026"] ?? 0)} stays purpose-bound; ${dealer.name} received ordinary e₹`,
    check("rules"),
  );

  advanceDays(91);
  const swept = ledger.sweepExpired();
  log(
    "91 days later the unspent subsidy expires and is swept back to the scheme",
    `swept ${swept.swept.length} tokens worth ${formatInr(swept.swept.reduce((a, t) => a + t.amount, 0))}; scheme balance ${formatInr((await bankA.balance(scheme.id)).available)}`,
    check("sweep"),
  );

  // 5. Offline payments
  const directory = (walletId: string) => bankA.publicKeyOf(walletId) ?? bankB.publicKeyOf(walletId);
  const raviDevice = new OfflineWallet(ravi.id, keysOf(bankB, ravi), directory);
  const dealerDevice = new OfflineWallet(dealer.id, keysOf(bankA, dealer), directory);
  const groceryDevice = new OfflineWallet(grocery.id, keysOf(bankB, grocery), directory);
  const prefund = await bankB.prefundOffline(ravi.id, rupees(300), "prefund-ravi");
  raviDevice.fund(prefund.offline);
  const v1 = raviDevice.createVoucher(dealer.id, rupees(100), now);
  dealerDevice.receiveVoucher(v1);
  const sync1 = await bankB.syncVouchers(dealerDevice.pendingVouchers(), "sync-dealer-1");
  dealerDevice.markSynced(sync1.filter((r) => r.ok).map((r) => r.voucherId));
  log(
    "Offline: Ravi prefunds ₹300, pays the dealer ₹100 by signed voucher, dealer syncs later",
    `voucher ${v1.id} counter ${v1.counter} verified offline by the dealer's device, settled on sync: ${JSON.stringify(sync1[0])}`,
    `Ravi's remaining offline balance ${formatInr(raviDevice.balance)}; escrow at bank ${formatInr((await bankB.balance(ravi.id)).offline)}`,
    check("offline"),
  );

  const cloned = raviDevice.clone();
  const v2a = raviDevice.createVoucher(dealer.id, rupees(100), now);
  const v2b = cloned.createVoucher(grocery.id, rupees(100), now);
  dealerDevice.receiveVoucher(v2a);
  groceryDevice.receiveVoucher(v2b);
  const sync2 = await bankB.syncVouchers([v2a], "sync-dealer-2");
  const sync3 = await bankB.syncVouchers([v2b], "sync-grocery-1");
  const raviAfter = bankB.wallet(ravi.id);
  log(
    "Attack: Ravi's device is cloned; both copies issue counter 2 to different merchants",
    `both merchants verified their voucher offline (same key, valid signature), which is exactly the limit of offline verification`,
    `first to sync: ${JSON.stringify(sync2[0])}`,
    `second to sync: ${JSON.stringify(sync3[0])}`,
    `Ravi's wallet frozen: ${raviAfter.frozen} (${raviAfter.frozenReason ?? ""})`,
    check("double-spend"),
  );

  const frozenPay = await expectRejection("frozen wallet paying P2P", () => bankB.payP2P({ from: ravi.id, to: asha.id, amount: rupees(50), requestId: "p2p-frozen" }));
  log("The core also refuses the frozen wallet", frozenPay);

  const inv = ledger.invariants();
  const auditA = bankA.auditLog();
  const auditB = bankB.auditLog();
  log(
    "Done",
    `ledger entries ${inv.entries}, hash chain ${inv.chainOk ? "intact" : "BROKEN"}, conservation ${inv.ok ? "holds" : "BROKEN"}`,
    `audit: bank-a ${auditA.length} entries (${auditA.filter((e) => e.outcome === "rejected").length} rejected), bank-b ${auditB.length} entries (${auditB.filter((e) => e.outcome === "rejected").length} rejected)`,
  );
}

function keysOf(bank: BankTier, wallet: Wallet) {
  // The bank is custodial in this sandbox; the device borrows the wallet key to sign vouchers.
  return bank.exportKeys(wallet.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
