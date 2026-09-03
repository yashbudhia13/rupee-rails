/**
 * How a bank talks to the core. The bank tier is written against this
 * interface so the same code runs in-process (tests, demo) or over HTTP
 * against a separately deployed core (`npm run dev:core` + `npm run dev:bank`).
 */
import {
  CoreLedger,
  LedgerError,
  type BurnRequest,
  type Invariants,
  type IssueRequest,
  type LedgerEntry,
  type MintRequest,
  type RedeemRequest,
  type Token,
  type TransferRequest,
  type WalletRecord,
} from "./ledger.js";

export interface CoreClient {
  registerBank(bankId: string, poolPublicKey: string, openingReserve: number): Promise<void>;
  registerWallet(record: WalletRecord): Promise<WalletRecord>;
  lookupWallet(walletId: string): Promise<WalletRecord | undefined>;
  lookupVpa(vpa: string): Promise<WalletRecord | undefined>;
  setFrozen(walletId: string, frozen: boolean): Promise<WalletRecord>;
  mint(req: MintRequest): Promise<{ txId: string; tokens: Token[] }>;
  burn(req: BurnRequest): Promise<{ txId: string; amount: number }>;
  issue(req: IssueRequest): Promise<{ txId: string; tokens: Token[] }>;
  redeem(req: RedeemRequest): Promise<{ txId: string; amount: number }>;
  transfer(req: TransferRequest): Promise<{ txId: string; outputs: Token[] }>;
  sweepExpired(at?: Date): Promise<{ txId: string | null; swept: Token[] }>;
  unspentOf(owner: string): Promise<Token[]>;
  reserveOf(bankId: string): Promise<number>;
  invariants(): Promise<Invariants>;
  entries(): Promise<LedgerEntry[]>;
}

export class InProcessCoreClient implements CoreClient {
  constructor(readonly ledger: CoreLedger) {}
  async registerBank(bankId: string, poolPublicKey: string, openingReserve: number) {
    this.ledger.registerBank(bankId, poolPublicKey, openingReserve);
  }
  async registerWallet(record: WalletRecord) {
    return this.ledger.registerWallet(record);
  }
  async lookupWallet(walletId: string) {
    return this.ledger.lookupWallet(walletId);
  }
  async lookupVpa(vpa: string) {
    return this.ledger.lookupVpa(vpa);
  }
  async setFrozen(walletId: string, frozen: boolean) {
    return this.ledger.setFrozen(walletId, frozen);
  }
  async mint(req: MintRequest) {
    return this.ledger.mint(req);
  }
  async burn(req: BurnRequest) {
    return this.ledger.burn(req);
  }
  async issue(req: IssueRequest) {
    return this.ledger.issue(req);
  }
  async redeem(req: RedeemRequest) {
    return this.ledger.redeem(req);
  }
  async transfer(req: TransferRequest) {
    return this.ledger.transfer(req);
  }
  async sweepExpired(at?: Date) {
    return this.ledger.sweepExpired(at);
  }
  async unspentOf(owner: string) {
    return this.ledger.unspentOf(owner);
  }
  async reserveOf(bankId: string) {
    return this.ledger.reserveOf(bankId);
  }
  async invariants() {
    return this.ledger.invariants();
  }
  async entries() {
    return this.ledger.entriesList();
  }
}

/** Talks to `src/api/core-server.ts`. Errors come back as LedgerError with the server's code. */
export class HttpCoreClient implements CoreClient {
  constructor(readonly baseUrl: string) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const err = (data ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
      throw new LedgerError((err.code ?? "INVALID_OUTPUT") as LedgerError["code"], err.message ?? `HTTP ${res.status}`, err.details);
    }
    return data as T;
  }

  registerBank(bankId: string, poolPublicKey: string, openingReserve: number) {
    return this.call<void>("POST", "/banks", { bankId, poolPublicKey, openingReserve });
  }
  registerWallet(record: WalletRecord) {
    return this.call<WalletRecord>("POST", "/wallets", record);
  }
  async lookupWallet(walletId: string) {
    const r = await this.call<{ wallet: WalletRecord | null }>("GET", `/wallets/${encodeURIComponent(walletId)}`);
    return r.wallet ?? undefined;
  }
  async lookupVpa(vpa: string) {
    const r = await this.call<{ wallet: WalletRecord | null }>("GET", `/vpa/${encodeURIComponent(vpa)}`);
    return r.wallet ?? undefined;
  }
  setFrozen(walletId: string, frozen: boolean) {
    return this.call<WalletRecord>("POST", `/wallets/${encodeURIComponent(walletId)}/frozen`, { frozen });
  }
  mint(req: MintRequest) {
    return this.call<{ txId: string; tokens: Token[] }>("POST", "/mint", req);
  }
  burn(req: BurnRequest) {
    return this.call<{ txId: string; amount: number }>("POST", "/burn", req);
  }
  issue(req: IssueRequest) {
    return this.call<{ txId: string; tokens: Token[] }>("POST", "/issue", req);
  }
  redeem(req: RedeemRequest) {
    return this.call<{ txId: string; amount: number }>("POST", "/redeem", req);
  }
  transfer(req: TransferRequest) {
    return this.call<{ txId: string; outputs: Token[] }>("POST", "/transfer", req);
  }
  sweepExpired(at?: Date) {
    return this.call<{ txId: string | null; swept: Token[] }>("POST", "/sweep", at ? { at: at.toISOString() } : {});
  }
  unspentOf(owner: string) {
    return this.call<Token[]>("GET", `/owners/${owner}/tokens`);
  }
  async reserveOf(bankId: string) {
    const r = await this.call<{ reserve: number }>("GET", `/banks/${encodeURIComponent(bankId)}/reserve`);
    return r.reserve;
  }
  invariants() {
    return this.call<Invariants>("GET", "/invariants");
  }
  entries() {
    return this.call<LedgerEntry[]>("GET", "/entries");
  }
}
