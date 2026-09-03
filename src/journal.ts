/**
 * The ledger's journal: an append-only record of every accepted operation.
 *
 * The core ledger is event-sourced. State in memory is a projection of the
 * journal, and `CoreLedger.open` rebuilds it by replaying the journal from the
 * start. Writes are write-ahead: an operation is validated, journaled, and
 * only then applied, so a crash between the two cannot lose an accepted
 * operation or apply an unrecorded one.
 *
 * Three adapters share one interface: in-memory (tests, demo), SQLite through
 * node:sqlite (single-node durability with zero dependencies), and PostgreSQL
 * (what a bank would actually run). The journal is deliberately dumb: one
 * table, insert and scan. All meaning lives in the ledger.
 */
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

export type JournalEventType =
  | "bank.register"
  | "wallet.register"
  | "wallet.frozen"
  | "mint"
  | "burn"
  | "issue"
  | "redeem"
  | "transfer"
  | "sweep";

export interface JournalEvent {
  /** 1-based, contiguous. The journal rejects gaps and duplicates. */
  seq: number;
  at: string;
  type: JournalEventType;
  payload: Record<string, unknown>;
}

export interface Journal {
  append(event: JournalEvent): Promise<void>;
  readAll(): Promise<JournalEvent[]>;
  close(): Promise<void>;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export class MemoryJournal implements Journal {
  readonly events: JournalEvent[] = [];
  async append(event: JournalEvent): Promise<void> {
    if (event.seq !== this.events.length + 1) throw new JournalError(`expected seq ${this.events.length + 1}, got ${event.seq}`);
    this.events.push(structuredClone(event));
  }
  async readAll(): Promise<JournalEvent[]> {
    return structuredClone(this.events);
  }
  async close(): Promise<void> {}
}

export class SqliteJournal implements Journal {
  private readonly db: DatabaseSync;
  private readonly insert;
  private readonly scan;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS ledger_journal (
      seq INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
    this.insert = this.db.prepare("INSERT INTO ledger_journal (seq, at, type, payload) VALUES (?, ?, ?, ?)");
    this.scan = this.db.prepare("SELECT seq, at, type, payload FROM ledger_journal ORDER BY seq");
  }

  async append(event: JournalEvent): Promise<void> {
    try {
      this.insert.run(event.seq, event.at, event.type, JSON.stringify(event.payload));
    } catch (err) {
      throw new JournalError(`append seq ${event.seq} failed: ${(err as Error).message}`);
    }
  }

  async readAll(): Promise<JournalEvent[]> {
    const rows = this.scan.all() as Array<{ seq: number; at: string; type: string; payload: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), at: r.at, type: r.type as JournalEventType, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class PostgresJournal implements Journal {
  private constructor(
    private readonly pool: pg.Pool,
    readonly table: string,
  ) {}

  static async connect(connectionString: string, table = "ledger_journal"): Promise<PostgresJournal> {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new JournalError(`bad table name ${table}`);
    const pool = new pg.Pool({ connectionString });
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      seq BIGINT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      payload JSONB NOT NULL
    )`);
    return new PostgresJournal(pool, table);
  }

  async append(event: JournalEvent): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO ${this.table} (seq, at, type, payload) VALUES ($1, $2, $3, $4)`, [
        event.seq,
        event.at,
        event.type,
        JSON.stringify(event.payload),
      ]);
    } catch (err) {
      throw new JournalError(`append seq ${event.seq} failed: ${(err as Error).message}`);
    }
  }

  async readAll(): Promise<JournalEvent[]> {
    const res = await this.pool.query<{ seq: string; at: Date; type: string; payload: Record<string, unknown> }>(
      `SELECT seq, at, type, payload FROM ${this.table} ORDER BY seq`,
    );
    return res.rows.map((r) => ({ seq: Number(r.seq), at: new Date(r.at).toISOString(), type: r.type as JournalEventType, payload: r.payload }));
  }

  /** Test helper: start from an empty journal. */
  async truncate(): Promise<void> {
    await this.pool.query(`TRUNCATE ${this.table}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Pick an adapter from a URL or path: `postgres://…` for PostgreSQL, anything else is a SQLite file. */
export async function openJournal(target: string): Promise<Journal> {
  if (/^postgres(ql)?:\/\//.test(target)) return PostgresJournal.connect(target);
  return new SqliteJournal(target);
}
