/**
 * HTTP face of the core ledger (Tier 1). Banks talk to this through
 * HttpCoreClient. The /admin routes sign with the in-process RBI key and exist
 * only so a sandbox can be driven end to end; a real central bank would keep
 * that key in an HSM behind its own approval flow.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateKeyPair, signCanonical, type KeyPair } from "../crypto.js";
import { CoreLedger, LedgerError, signingPayload } from "../ledger.js";
import { MoneyError } from "../money.js";

const walletRecord = z.object({
  walletId: z.string().min(1),
  bankId: z.string().min(1),
  publicKey: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["person", "merchant", "scheme", "pool", "escrow"]),
  name: z.string().min(1),
  vpa: z.string().optional(),
  mcc: z.string().regex(/^\d{4}$/).optional(),
  frozen: z.boolean(),
});

const rules = z.object({
  purpose: z.string().min(1),
  returnTo: z.string().regex(/^[0-9a-f]{64}$/),
  mccAllowlist: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  geofence: z.object({ lat: z.number(), lng: z.number(), radiusM: z.number() }).optional(),
});

const transfer = z.object({
  inputs: z.array(z.string()).min(1),
  outputs: z.array(z.object({ owner: z.string(), amount: z.number().int(), rules: rules.optional() })).min(1),
  memo: z.string().optional(),
  context: z
    .object({ at: z.string(), recipientMcc: z.string().optional(), location: z.object({ lat: z.number(), lng: z.number() }).optional() })
    .optional(),
  idempotencyKey: z.string().min(1),
  signature: z.string(),
});

const signed = { idempotencyKey: z.string().min(1), signature: z.string() };

export interface CoreServer {
  app: FastifyInstance;
  ledger: CoreLedger;
  rbi: KeyPair;
}

export function buildCoreServer(opts: { ledger?: CoreLedger; rbi?: KeyPair; adminToken?: string } = {}): CoreServer {
  const rbi = opts.rbi ?? generateKeyPair();
  const ledger = opts.ledger ?? new CoreLedger(rbi.publicKey);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LedgerError) {
      return reply.status(statusFor(err.code)).send({ code: err.code, message: err.message, details: err.details ?? null });
    }
    if (err instanceof MoneyError) return reply.status(400).send({ code: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      const issues = (err as z.ZodError).issues;
      return reply.status(400).send({ code: "INVALID_REQUEST", message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
  });

  app.get("/health", async () => ({ ok: true, rbiPublicKey: rbi.publicKey }));

  app.post("/banks", async (req, reply) => {
    const body = z.object({ bankId: z.string().min(1), poolPublicKey: z.string().regex(/^[0-9a-f]{64}$/), openingReserve: z.number().int().nonnegative() }).parse(req.body);
    ledger.registerBank(body.bankId, body.poolPublicKey, body.openingReserve);
    return reply.status(201).send({ ok: true });
  });
  app.get<{ Params: { bankId: string } }>("/banks/:bankId/reserve", async (req) => ({ reserve: ledger.reserveOf(req.params.bankId) }));

  app.post("/wallets", async (req, reply) => reply.status(201).send(ledger.registerWallet(walletRecord.parse(req.body))));
  app.get<{ Params: { walletId: string } }>("/wallets/:walletId", async (req) => ({ wallet: ledger.lookupWallet(req.params.walletId) ?? null }));
  app.post<{ Params: { walletId: string } }>("/wallets/:walletId/frozen", async (req) => {
    const body = z.object({ frozen: z.boolean() }).parse(req.body);
    return ledger.setFrozen(req.params.walletId, body.frozen);
  });
  app.get<{ Params: { vpa: string } }>("/vpa/:vpa", async (req) => ({ wallet: ledger.lookupVpa(req.params.vpa) ?? null }));
  app.get<{ Params: { owner: string } }>("/owners/:owner/tokens", async (req) => ledger.unspentOf(req.params.owner));

  app.post("/mint", async (req) => ledger.mint(z.object({ amount: z.number().int(), ...signed }).parse(req.body)));
  app.post("/burn", async (req) => ledger.burn(z.object({ inputs: z.array(z.string()).min(1), ...signed }).parse(req.body)));
  app.post("/issue", async (req) => ledger.issue(z.object({ bankId: z.string(), amount: z.number().int(), ...signed }).parse(req.body)));
  app.post("/redeem", async (req) => ledger.redeem(z.object({ bankId: z.string(), inputs: z.array(z.string()).min(1), ...signed }).parse(req.body)));
  app.post("/transfer", async (req) => ledger.transfer(transfer.parse(req.body)));
  app.post("/sweep", async (req) => {
    const body = z.object({ at: z.string().optional() }).parse(req.body ?? {});
    return ledger.sweepExpired(body.at ? new Date(body.at) : undefined);
  });

  app.get("/invariants", async () => ledger.invariants());
  app.get("/entries", async () => ledger.entriesList());

  // Sandbox-only: the "RBI desk". Signs with the in-process key.
  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/admin/") && opts.adminToken && req.headers["x-admin-token"] !== opts.adminToken) {
      return reply.status(401).send({ code: "UNAUTHORIZED", message: "admin token required" });
    }
  });
  app.post("/admin/mint", async (req) => {
    const body = z.object({ amount: z.number().int(), idempotencyKey: z.string().optional() }).parse(req.body);
    const unsigned = { amount: body.amount, idempotencyKey: body.idempotencyKey ?? `admin-mint-${Date.now()}`, signature: "" };
    return ledger.mint({ ...unsigned, signature: signCanonical(rbi.privateKey, signingPayload("mint", unsigned)) });
  });
  app.post("/admin/issue", async (req) => {
    const body = z.object({ bankId: z.string(), amount: z.number().int(), idempotencyKey: z.string().optional() }).parse(req.body);
    const unsigned = { bankId: body.bankId, amount: body.amount, idempotencyKey: body.idempotencyKey ?? `admin-issue-${Date.now()}`, signature: "" };
    return ledger.issue({ ...unsigned, signature: signCanonical(rbi.privateKey, signingPayload("issue", unsigned)) });
  });

  return { app, ledger, rbi };
}

function statusFor(code: LedgerError["code"]): number {
  switch (code) {
    case "BAD_SIGNATURE":
    case "NOT_OWNER":
      return 403;
    case "UNKNOWN_TOKEN":
    case "UNKNOWN_BANK":
    case "UNKNOWN_WALLET":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "ALREADY_SPENT":
    case "DUPLICATE_WALLET":
      return 409;
    case "FROZEN":
    case "RULE_VIOLATION":
    case "INSUFFICIENT_RESERVE":
    case "INSUFFICIENT_FUNDS":
      return 422;
    default:
      return 400;
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const { app, rbi } = buildCoreServer({ adminToken: process.env.ADMIN_TOKEN });
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`rupee-rails core ledger on http://127.0.0.1:${port}  (RBI key ${rbi.publicKey.slice(0, 12)}…)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
