import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBankServer } from "../src/api/bank-server.js";
import { buildCoreServer, type CoreServer } from "../src/api/core-server.js";
import { BankTier } from "../src/bank.js";
import { HttpCoreClient } from "../src/core-client.js";
import { rupees } from "../src/money.js";

describe("core and bank over HTTP", () => {
  let core: CoreServer;
  let baseUrl: string;

  beforeAll(async () => {
    core = buildCoreServer({ adminToken: "secret" });
    baseUrl = await core.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await core.app.close();
  });

  it("runs a bank against the core through HttpCoreClient", async () => {
    const client = new HttpCoreClient(baseUrl);
    const bank = await BankTier.create("bank-http", client, { openingReserve: rupees(1_000_000) });
    const headers = { "content-type": "application/json", "x-admin-token": "secret" };
    const mint = await fetch(`${baseUrl}/admin/mint`, { method: "POST", headers, body: JSON.stringify({ amount: rupees(100_000), idempotencyKey: "m" }) });
    expect(mint.status).toBe(200);
    const issue = await fetch(`${baseUrl}/admin/issue`, { method: "POST", headers, body: JSON.stringify({ bankId: "bank-http", amount: rupees(50_000), idempotencyKey: "i" }) });
    expect(issue.status).toBe(200);

    const a = await bank.createWallet({ name: "A", kyc: "full", accountBalance: rupees(5_000) });
    const b = await bank.createWallet({ name: "B", kyc: "full" });
    await bank.load(a.id, rupees(1_000), "l1");
    await bank.payP2P({ from: a.id, to: b.id, amount: rupees(250), requestId: "p1" });
    expect((await bank.balance(b.id)).available).toBe(rupees(250));

    const inv = await client.invariants();
    expect(inv.ok).toBe(true);
    expect(await client.reserveOf("bank-http")).toBe(rupees(950_000));

    const bankApp = buildBankServer(bank);
    const res = await bankApp.inject({ method: "GET", url: `/wallets/${a.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance.available).toBe(rupees(750));
    const bad = await bankApp.inject({ method: "POST", url: `/wallets/${a.id}/load`, payload: { amount: 75, requestId: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("INVALID_AMOUNT");
    await bankApp.close();
  });

  it("guards admin routes and maps ledger errors to HTTP statuses", async () => {
    const denied = await fetch(`${baseUrl}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 100 }) });
    expect(denied.status).toBe(401);
    const unknown = await fetch(`${baseUrl}/wallets/nope`);
    expect((await unknown.json()).wallet).toBeNull();
    const badSig = await fetch(`${baseUrl}/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 100, idempotencyKey: "k", signature: "00" }) });
    expect(badSig.status).toBe(403);
    expect((await badSig.json()).code).toBe("BAD_SIGNATURE");
  });
});
