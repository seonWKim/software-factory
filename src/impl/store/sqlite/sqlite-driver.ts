import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Row, SqlDialect, SqlDriver, SqlExecutor, SqlValue } from "../sql/driver.js";
import { MIGRATIONS } from "./schema.js";

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/**
 * One SQLite file, one machine. Transactions are `BEGIN IMMEDIATE`, which takes the write lock up front,
 * so processes sharing the file serialize instead of deadlocking; within this process, transactions and
 * reads run one at a time on the single connection. No row locks are needed, so the lock suffixes are empty.
 */
export class SqliteDriver implements SqlDriver {
  readonly dialect: SqlDialect = { seq: "rowid", forUpdate: "", forUpdateSkipLocked: "", forShare: "" };
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly exec: SqlExecutor = {
    all: async (sql, params = []) => this.db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, params = []) => Number(this.db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]> {
    return this.serialize(() => this.exec.all(sql, params));
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<number> {
    return this.serialize(() => this.exec.run(sql, params));
  }

  migrate(): Promise<void> {
    return this.transaction(async () => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
      const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
      for (let v = (row.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
    });
  }

  /** Reads sqlite_master first, so a database without the table stays untouched. */
  schemaVersion(): Promise<{ applied: number; latest: number }> {
    return this.serialize(async () => {
      const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      const row = table ? (this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }) : null;
      return { applied: Number(row?.v ?? 0), latest: MIGRATIONS.length };
    });
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.exec);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  isDuplicateKey(err: unknown): boolean {
    const code = (err as { errcode?: number } | null)?.errcode;
    return code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY;
  }

  async close(): Promise<void> {
    await this.queue;
    this.db.close();
  }

  /** One connection: an async transaction must not interleave with another statement. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
