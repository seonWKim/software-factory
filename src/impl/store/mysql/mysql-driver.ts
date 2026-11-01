import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { Row, SqlDialect, SqlDriver, SqlExecutor, SqlValue } from "../sql/driver.js";
import { MysqlMigrations, pendingMessage } from "./migrations.js";

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
  /** Where the schema step files are (default: migrations/mysql/ under the code root). Tests point elsewhere. */
  stepsDir?: string;
}

const ER_DUP_ENTRY = 1062;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;
const TX_ATTEMPTS = 5;

/**
 * MySQL (InnoDB), any number of processes on any hosts. Transactions are READ COMMITTED with row locks;
 * deadlocks and lock-wait timeouts retry the whole transaction.
 */
export class MysqlDriver implements SqlDriver {
  readonly dialect: SqlDialect = {
    seq: "seq",
    forUpdate: " FOR UPDATE",
    forUpdateSkipLocked: " FOR UPDATE SKIP LOCKED",
    forShare: " FOR SHARE",
  };
  private readonly pool: Pool;
  private readonly steps: { dir?: string };

  constructor(opts: MysqlOptions) {
    this.steps = opts.stepsDir === undefined ? {} : { dir: opts.stepsDir };
    this.pool = mysql.createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      connectionLimit: opts.connectionLimit ?? 10,
      // affectedRows = rows matched, even when an UPDATE writes identical values (SqlExecutor.run's contract).
      flags: ["FOUND_ROWS"],
    });
  }

  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]> {
    return all(this.pool, sql, params);
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<number> {
    return run(this.pool, sql, params);
  }

  /**
   * A check, not a migration: schema steps run only through `npm run migrate`. Throws while steps are
   * pending (message names `npm run migrate`), so every caller that starts the factory refuses. Applies
   * nothing. A database ahead of the code starts (only `npm run migrate` refuses it).
   */
  async migrate(): Promise<void> {
    const s = await new MysqlMigrations(this.pool, this.steps).status();
    if (s.state !== null && s.state > s.latest) return;
    if (s.refusal) throw new Error(`MySQL schema: ${s.refusal}`);
    if (s.pending.length > 0) throw new Error(pendingMessage(s));
  }

  /**
   * Reads only (no lock, no CREATE TABLE): the recorded step state and the newest step file. Throws the
   * same message as `migrate()` while steps are pending, so doctor shows it as a FAIL line.
   */
  async schemaVersion(): Promise<{ applied: number; latest: number }> {
    const s = await new MysqlMigrations(this.pool, this.steps).status();
    if (s.state !== null && s.state > s.latest) return { applied: s.state, latest: s.latest };
    if (s.refusal) throw new Error(`MySQL schema: ${s.refusal}`);
    if (s.pending.length > 0) throw new Error(pendingMessage(s));
    return { applied: s.state ?? 0, latest: s.latest };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.getConnection();
      try {
        await c.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await c.query("START TRANSACTION");
        const result = await fn({ all: (sql, params) => all(c, sql, params), run: (sql, params) => run(c, sql, params) });
        await c.query("COMMIT");
        return result;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        const code = errno(err);
        if (attempt < TX_ATTEMPTS && (code === ER_LOCK_DEADLOCK || code === ER_LOCK_WAIT_TIMEOUT)) continue;
        throw err;
      } finally {
        c.release();
      }
    }
  }

  isDuplicateKey(err: unknown): boolean {
    return errno(err) === ER_DUP_ENTRY;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

async function all(db: Pool | PoolConnection, sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, [...params]);
  return rows;
}

async function run(db: Pool | PoolConnection, sql: string, params: readonly SqlValue[] = []): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(sql, [...params]);
  return result.affectedRows;
}

function errno(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "errno" in err ? (err as { errno: number }).errno : undefined;
}
