/**
 * HTTP face of one bank (Tier 2). Runs against a core over HTTP:
 *
 *   npm run dev:core                 # core on :4000
 *   BANK_ID=bank-a PORT=4001 npm run dev:bank
 *   BANK_ID=bank-b PORT=4002 npm run dev:bank
 */
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BankError, BankTier } from "../bank.js";
import { HttpCoreClient } from "../core-client.js";
import { LedgerError } from "../ledger.js";
import { MoneyError, rupees } from "../money.js";
import { UpiError } from "../upi.js";

const voucher = z.object({
  id: z.string(),
  from: z.string(),
  fromKey: z.string(),
  to: z.string(),
  amount: z.number().int(),
  counter: z.number().int(),
  prevHash: z.string(),
  issuedAt: z.string(),
  signature: z.string(),
});

export function buildBankServer(bank: BankTier): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BankError) return reply.status(statusFor(err.code)).send({ code: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof LedgerError) return reply.status(422).send({ code: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof MoneyError || err instanceof UpiError) return reply.status(400).send({ code: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      const issues = (err as z.ZodError).issues;
      return reply.status(400).send({ code: "INVALID_REQUEST", message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
  });

  app.get("/health", async () => ({ ok: true, bankId: bank.bankId }));

  app.post("/wallets", async (req, reply) => {
    const body = z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        kind: z.enum(["person", "merchant", "scheme"]).optional(),
        kyc: z.enum(["min", "full"]).optional(),
        vpa: z.string().optional(),
        mcc: z.string().regex(/^\d{4}$/).optional(),
        accountBalance: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    return reply.status(201).send(await bank.createWallet(body));
  });
  app.get("/wallets", async () => bank.listWallets());
  app.get<{ Params: { id: string } }>("/wallets/:id", async (req) => ({ wallet: bank.wallet(req.params.id), balance: await bank.balance(req.params.id) }));

  const amountReq = z.object({ amount: z.number().int(), requestId: z.string().min(1) });
  app.post<{ Params: { id: string } }>("/wallets/:id/load", async (req) => {
    const body = amountReq.parse(req.body);
    return bank.load(req.params.id, body.amount, body.requestId);
  });
  app.post<{ Params: { id: string } }>("/wallets/:id/unload", async (req) => {
    const body = amountReq.parse(req.body);
    return bank.unload(req.params.id, body.amount, body.requestId);
  });

  app.post("/pay/p2p", async (req) =>
    bank.payP2P(z.object({ from: z.string(), to: z.string(), amount: z.number().int(), note: z.string().optional(), requestId: z.string().min(1) }).parse(req.body)),
  );
  app.post("/pay/qr", async (req) =>
    bank.payQr(
      z
        .object({
          from: z.string(),
          qr: z.string(),
          amount: z.number().int().optional(),
          purpose: z.string().optional(),
          location: z.object({ lat: z.number(), lng: z.number() }).optional(),
          requestId: z.string().min(1),
        })
        .parse(req.body),
    ),
  );
  app.post("/disburse", async (req) =>
    bank.disburse(
      z
        .object({
          schemeWalletId: z.string(),
          to: z.string(),
          amount: z.number().int(),
          rules: z.object({
            purpose: z.string().min(1),
            mccAllowlist: z.array(z.string()).optional(),
            expiresAt: z.string().optional(),
            geofence: z.object({ lat: z.number(), lng: z.number(), radiusM: z.number() }).optional(),
          }),
          requestId: z.string().min(1),
        })
        .parse(req.body),
    ),
  );

  app.post("/offline/prefund", async (req) => {
    const body = z.object({ walletId: z.string(), amount: z.number().int(), requestId: z.string().min(1) }).parse(req.body);
    return bank.prefundOffline(body.walletId, body.amount, body.requestId);
  });
  app.post("/offline/sync", async (req) => {
    const body = z.object({ vouchers: z.array(voucher).min(1), requestId: z.string().min(1) }).parse(req.body);
    return bank.syncVouchers(body.vouchers, body.requestId);
  });

  app.get("/audit", async () => bank.auditLog());
  return app;
}

function statusFor(code: BankError["code"]): number {
  switch (code) {
    case "UNKNOWN_WALLET":
      return 404;
    case "DUPLICATE_VOUCHER":
      return 409;
    case "AMOUNT_MISMATCH":
    case "AMOUNT_REQUIRED":
    case "BAD_VOUCHER":
      return 400;
    default:
      return 422;
  }
}

async function main(): Promise<void> {
  const coreUrl = process.env.CORE_URL ?? "http://127.0.0.1:4000";
  const bankId = process.env.BANK_ID ?? "bank-a";
  const port = Number(process.env.PORT ?? 4001);
  const core = new HttpCoreClient(coreUrl);
  const bank = await BankTier.create(bankId, core);

  // Sandbox bootstrap: ask the RBI desk to mint and issue an opening float to this bank.
  const float = rupees(500_000);
  const headers = { "content-type": "application/json", ...(process.env.ADMIN_TOKEN ? { "x-admin-token": process.env.ADMIN_TOKEN } : {}) };
  await fetch(`${coreUrl}/admin/mint`, { method: "POST", headers, body: JSON.stringify({ amount: float, idempotencyKey: `boot-mint-${bankId}` }) });
  await fetch(`${coreUrl}/admin/issue`, { method: "POST", headers, body: JSON.stringify({ bankId, amount: float, idempotencyKey: `boot-issue-${bankId}` }) });

  const app = buildBankServer(bank);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`rupee-rails ${bankId} on http://127.0.0.1:${port}  (core ${coreUrl})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
