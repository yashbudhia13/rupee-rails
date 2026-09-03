/**
 * Property-based tests: random interleavings of online transfers, offline
 * vouchers, syncs and clone attacks across two banks. Two properties must hold
 * after every step:
 *
 *   1. Conservation: sum(unspent) == minted - burned, and the hash chain verifies.
 *   2. Every clone attack (two vouchers with one counter) is detected on sync,
 *      and exactly one of the pair settles.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BankTier } from "../src/bank.js";
import { rupees } from "../src/money.js";
import { OfflineWallet, type Voucher } from "../src/offline.js";
import { makeWorld } from "./helpers.js";

type Cmd =
  | { kind: "load"; who: number; amount: number }
  | { kind: "p2p"; from: number; to: number; amount: number }
  | { kind: "prefund"; who: number; amount: number }
  | { kind: "voucher"; from: number; to: number; amount: number }
  | { kind: "clone"; from: number; to1: number; to2: number; amount: number }
  | { kind: "sync"; who: number };

const idx = fc.integer({ min: 0, max: 5 });
const amount = fc.integer({ min: 1, max: 40 }).map((n) => n * 50);
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ kind: fc.constant("load" as const), who: idx, amount }),
  fc.record({ kind: fc.constant("p2p" as const), from: idx, to: idx, amount }),
  fc.record({ kind: fc.constant("prefund" as const), who: idx, amount }),
  fc.record({ kind: fc.constant("voucher" as const), from: idx, to: idx, amount }),
  fc.record({ kind: fc.constant("clone" as const), from: idx, to1: idx, to2: idx, amount }),
  fc.record({ kind: fc.constant("sync" as const), who: idx }),
);

const EXPECTED_ERRORS = new Set([
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_ACCOUNT",
  "INSUFFICIENT_OFFLINE_BALANCE",
  "KYC_BALANCE_CAP",
  "KYC_DAILY_CAP",
  "FROZEN",
  "NOT_PAYABLE",
  "BAD_VOUCHER",
  "KEY_MISMATCH",
]);

describe("random interleavings", () => {
  it("never break conservation and always catch clone double-spends", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 40 }), async (cmds) => {
        const w = await makeWorld(rupees(100_000));
        const banks: BankTier[] = [w.bankA, w.bankA, w.bankA, w.bankB, w.bankB, w.bankB];
        const ids: string[] = [];
        for (const [i, bank] of banks.entries()) {
          const wallet = await bank.createWallet({ id: `w${i}`, name: `W${i}`, kyc: "full", accountBalance: rupees(5_000) });
          ids.push(wallet.id);
        }
        const directory = (id: string) => w.bankA.publicKeyOf(id) ?? w.bankB.publicKeyOf(id);
        const devices = ids.map((id, i) => new OfflineWallet(id, banks[i]!.exportKeys(id), directory));
        const inbox: Voucher[][] = ids.map(() => []);
        const attacks: Array<{ a: string; b: string }> = [];
        let step = 0;

        const check = () => {
          const inv = w.ledger.invariants();
          if (!inv.ok) throw new Error(`invariant broken at step ${step}: ${inv.problems.join("; ")}`);
        };
        const tolerate = async (run: () => Promise<unknown> | unknown) => {
          try {
            await run();
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (!code || !EXPECTED_ERRORS.has(code)) throw err;
          }
        };
        const syncFor = async (who: number) => {
          const pending = inbox[who]!;
          inbox[who] = [];
          for (const v of pending) {
            const payerIndex = ids.indexOf(v.from);
            await banks[payerIndex]!.syncVouchers([v], `sync-${step}-${v.id}`);
          }
        };

        for (const c of cmds) {
          step += 1;
          switch (c.kind) {
            case "load":
              await tolerate(() => banks[c.who]!.load(ids[c.who]!, c.amount, `load-${step}`));
              break;
            case "p2p":
              if (c.from !== c.to) await tolerate(() => banks[c.from]!.payP2P({ from: ids[c.from]!, to: ids[c.to]!, amount: c.amount, requestId: `p2p-${step}` }));
              break;
            case "prefund":
              await tolerate(async () => {
                await banks[c.who]!.prefundOffline(ids[c.who]!, c.amount, `prefund-${step}`);
                devices[c.who]!.fund(c.amount);
              });
              break;
            case "voucher":
              if (c.from !== c.to) {
                await tolerate(() => {
                  const v = devices[c.from]!.createVoucher(ids[c.to]!, c.amount, w.clock.now);
                  devices[c.to]!.receiveVoucher(v);
                  inbox[c.to]!.push(v);
                });
              }
              break;
            case "clone":
              if (c.from !== c.to1 && c.from !== c.to2 && c.to1 !== c.to2) {
                await tolerate(() => {
                  const clone = devices[c.from]!.clone();
                  const a = devices[c.from]!.createVoucher(ids[c.to1]!, c.amount, w.clock.now);
                  const b = clone.createVoucher(ids[c.to2]!, c.amount, w.clock.now);
                  devices[c.to1]!.receiveVoucher(a);
                  devices[c.to2]!.receiveVoucher(b);
                  inbox[c.to1]!.push(a);
                  inbox[c.to2]!.push(b);
                  attacks.push({ a: a.id, b: b.id });
                });
              }
              break;
            case "sync":
              await syncFor(c.who);
              break;
          }
          check();
        }
        for (let i = 0; i < ids.length; i++) await syncFor(i);
        check();

        // Every attack: exactly one voucher of the pair settled, the other was flagged.
        const settled = new Set<string>();
        const flagged = new Set<string>();
        for (const bank of [w.bankA, w.bankB]) {
          for (const e of bank.auditLog()) {
            if (e.action !== "offline.sync") continue;
            const id = e.detail.voucherId as string;
            if (e.outcome === "ok") settled.add(id);
            else if (e.detail.code === "DOUBLE_SPEND" || e.detail.code === "FROZEN" || e.detail.code === "OVERSPEND") flagged.add(id);
          }
        }
        for (const { a, b } of attacks) {
          const settledCount = Number(settled.has(a)) + Number(settled.has(b));
          expect(settledCount, `attack ${a}/${b} settled ${settledCount} vouchers`).toBeLessThanOrEqual(1);
          expect(flagged.has(a) || flagged.has(b), `attack ${a}/${b} was not flagged`).toBe(true);
        }
      }),
      { numRuns: 25 },
    );
  });
});
