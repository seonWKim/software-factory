import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { Row, SqlDialect, SqlDriver, SqlExecutor, SqlValue } from "../sql/driver.js";
import { MIGRATIONS } from "./schema.js";

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
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

  constructor(opts: MysqlOptions) {
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

  async migrate(): Promise<void> {
    const c = await this.pool.getConnection();
    try {
      // DDL commits implicitly, so concurrent migrators serialize on a named lock instead of a transaction.
      await c.query("SELECT GET_LOCK('software_factory_migrate', 60)");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL PRIMARY KEY)");
      const [row] = await all(c, "SELECT MAX(version) AS v FROM schema_migrations");
      for (let v = Number(row?.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        for (const statement of MIGRATIONS[v - 1]!) await c.query(statement);
        await c.query("INSERT INTO schema_migrations (version) VALUES (?)", [v]);
      }
    } finally {
      await c.query("SELECT RELEASE_LOCK('software_factory_migrate')").catch(() => undefined);
      c.release();
    }
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
