import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { migrationPendingError } from "../../../interfaces/updater.js";
import { type Row, type SqlDialect, type SqlDriver, type SqlExecutor, type SqlValue, applyMigrations, pendingMigrations } from "../../../state/index.js";
import type { ReadOnlyQueryOpts, ReadOnlyQueryResult } from "../../../interfaces/factory-store.js";
import { readOnlyQuery } from "./readonly-query.js";
import { MIGRATIONS } from "./schema.js";

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
/** One `ALTER TABLE <t> ADD COLUMN <c> ...;` statement at the start of a line, up to its `;`. */
const ADD_COLUMN = /^[ \t]*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)[^;]*;/gim;

/**
 * One SQLite file, one machine. Transactions are `BEGIN IMMEDIATE`, which takes the write lock up front,
 * so processes sharing the file serialize instead of deadlocking; within this process, transactions and
 * reads run one at a time on the single connection. No row locks are needed, so the lock suffixes are empty.
 */
export class SqliteDriver implements SqlDriver {
  readonly dialect: SqlDialect = { name: "sqlite", seq: "rowid" };
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly exec: SqlExecutor = {
    all: async (sql, params = []) => this.db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, params = []) => Number(this.db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };

  /**
   * `baselineOnly`: stop after the frozen numbered list, for tests of a historical step on an old database
   * (the timestamped migrations then run as on any database when a later driver opens it).
   * `applyBreaking`: also apply a pending breaking migration to a database that holds data. `npm run migrate`
   * (after its drain) and a rehearsal on a copy set it.
   * `canApplyBreaking`: asked on an open that finds one pending; true when no other factory process runs, so it
   * applies on this open (the drain is already done). False, or absent, refuses with MIGRATION_PENDING, so new code
   * never renames tables under a factory that still writes them (§12 D1).
   */
  constructor(
    private readonly path: string,
    private readonly opts: { baselineOnly?: boolean; applyBreaking?: boolean; canApplyBreaking?: () => Promise<boolean> } = {},
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]> {
    return this.serialize(() => this.exec.all(sql, params));
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<number> {
    return this.serialize(() => this.exec.run(sql, params));
  }

  /**
   * One read-only query (design 09-dashboard-app, Data page Ask) on its own read-only connection to this file, never
   * on this driver's connection, so it neither waits behind this process's writes nor can make one.
   */
  readOnlyQuery(sql: string, opts?: ReadOnlyQueryOpts): Promise<ReadOnlyQueryResult> {
    return readOnlyQuery(this.path, sql, opts);
  }

  /**
   * The frozen numbered baseline, then the timestamped migrations (RFC 0015 §6.3), all in one transaction.
   * A breaking migration backs up its tables to `backups/` beside a file database first (§12 D1). On a database
   * that existed before this open, a pending breaking migration is refused unless `applyBreaking` is set or
   * `canApplyBreaking` says no factory runs. A migration that fails rolls the whole open back and is named.
   */
  migrate(): Promise<void> {
    return this.transaction(async () => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
      const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
      for (let v = (row.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        this.db.exec(this.withoutExistingColumns(MIGRATIONS[v - 1]!));
        this.db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
      if (this.opts.baselineOnly) return;
      // A database built just now holds nothing worth a backup.
      const fresh = (row.v ?? 0) === 0;
      const db = { dialect: "sqlite" as const, ...this.exec };
      const pending = await pendingMigrations(db);
      const breaking = pending.filter((m) => m.change === "breaking").map((m) => m.id);
      if (!fresh && breaking.length > 0 && !this.opts.applyBreaking && !(await this.opts.canApplyBreaking?.())) {
        throw migrationPendingError(this.opts.canApplyBreaking ? drainingMessage(breaking) : breakingPendingMessage(breaking));
      }
      const backupDir = this.path === ":memory:" || fresh ? null : join(dirname(this.path), "backups");
      // One at a time, so a failure names its migration; the transaction then rolls back every one of them.
      for (const m of pending) {
        try {
          await applyMigrations(db, { backupDir, now: () => new Date().toISOString(), migrations: [m] });
        } catch (err) {
          throw new Error(`migration ${m.id} failed; nothing was applied: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
    });
  }

  /**
   * `sql` without its ADD COLUMN statements whose column the table already has: SQLite has no ADD COLUMN IF NOT
   * EXISTS, and a migration must be safe to run again on a database whose recorded version was set back.
   */
  private withoutExistingColumns(sql: string): string {
    const has = this.db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?");
    return sql.replace(ADD_COLUMN, (stmt, table: string, column: string) => (has.get(table, column) ? "" : stmt));
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

/** Why a store with a pending breaking migration refuses to open with no drain check; it names `npm run migrate`, as MySQL's does. */
export function breakingPendingMessage(ids: readonly string[]): string {
  return `SQLite: breaking migration${ids.length === 1 ? "" : "s"} pending (${ids.join(", ")}): run \`npm run migrate\` (it drains a running factory first)`;
}

/** One line for an open that found a breaking migration while a factory process runs: the supervisor drains, then applies it. */
export function drainingMessage(ids: readonly string[]): string {
  return `The factory is draining or migrating: breaking migration${ids.length === 1 ? "" : "s"} ${ids.join(", ")} apply once every factory process has stopped; try again in a minute`;
}
