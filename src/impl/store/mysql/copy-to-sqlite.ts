// `npm run migrate -- --copy-from-mysql`: copies every table of the MySQL store into <state_dir>/db/factory.db,
// verbatim, so the factory can switch to SQLite (docs/plugins/factory-store.md). MySQL is only read, inside one
// consistent read-only snapshot on one connection, as the rehearsal reads it. The copy is built in a temporary
// file beside factory.db at the latest SQLite schema, checked per table (row count and checksum over the
// primary-key columns), and renamed into place only then. Removed with the `mysql` plugin.

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";
import { MIGRATIONS_TABLE, type MigrationDb, type Row, type SqlValue, tableChecksum, tableColumns } from "../../../state/index.js";
import { SqliteDriver } from "../sqlite/sqlite-driver.js";
import type { MysqlOptions } from "./mysql-driver.js";

/** Bookkeeping of each backend's own schema history; every other table is copied. */
const SKIP = new Set(["schema_state", "schema_migrations"]);
/** Rows read and written per statement. */
const BATCH = 500;
const SIDECARS = ["", "-wal", "-shm"] as const;
const NAME = /^[a-z_][a-z0-9_]*$/;
/** MySQL's insertion-order column; SQLite keeps the same order in its rowid (the store's dialect.seq). */
const SEQ = "seq";

/** Runs `fn` over one connection inside one consistent read snapshot of the source. */
export type SnapshotReader = <T>(fn: (db: MigrationDb) => Promise<T>) => Promise<T>;

export interface CopyOptions {
  /** The state folder: the copy goes to `<stateDir>/db/factory.db`. */
  stateDir: string;
  dryRun: boolean;
  replace: boolean;
  /** The live factory processes on this machine (teardown's check). */
  livePids(): Promise<number[]>;
  /** Builds the rest of the SQLite schema after the migrations (the discovered topic tables). */
  schema(driver: SqliteDriver): Promise<void>;
  now(): Date;
  print(line: string): void;
}

/** One connection to the MySQL store, read-only, in one consistent snapshot; values come back as MySQL holds them. */
export function mysqlSnapshotReader(opts: MysqlOptions): SnapshotReader {
  return async (fn) => {
    const c = await mysql.createConnection({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      dateStrings: true,
      supportBigNumbers: true,
      // JSON as MySQL's text, not parsed: the copy stores it as text.
      typeCast: (field, next) => (field.type === "JSON" ? field.string("utf8") : next()),
    });
    try {
      await c.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await c.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      const db: MigrationDb = {
        dialect: "mysql",
        all: async (sql, params = []) => (await c.query(sql, [...params]))[0] as Row[],
        run: () => Promise.reject(new Error("the copy only reads MySQL")),
      };
      const out = await fn(db);
      await c.query("COMMIT");
      return out;
    } finally {
      await c.end();
    }
  };
}

function q(name: string): string {
  if (!NAME.test(name)) throw new Error(`not a table or column name: ${name}`);
  return `\`${name}\``;
}

async function sourceTables(db: MigrationDb): Promise<string[]> {
  const rows =
    db.dialect === "mysql"
      ? await db.all("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY 1")
      : await db.all("SELECT name AS t FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  return rows.map((r) => String(r.t));
}

/** The primary-key columns in key order; every column when the table has no primary key. */
export async function primaryKey(db: MigrationDb, table: string): Promise<string[]> {
  const rows =
    db.dialect === "mysql"
      ? await db.all(
          "SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position",
          [table],
        )
      : await db.all("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", [table]);
  const pk = rows.map((r) => String(r.name));
  return pk.length > 0 ? pk : tableColumns(db, table);
}

function sqliteDb(d: SqliteDriver): MigrationDb {
  return { dialect: "sqlite", all: (s, p) => d.all(s, p), run: (s, p) => d.run(s, p) };
}

/** Row counts of every table of a SQLite file, read-only. */
function sqliteCounts(file: string): Map<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = new Map<string, number>();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all();
    for (const t of tables) out.set(String(t.name), Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q(String(t.name))}`).get() as { n: number }).n));
    return out;
  } finally {
    db.close();
  }
}

/** A value as SQLite stores it: MySQL's text, numbers and bytes as they are (node:sqlite binds bytes too). */
function sqliteValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string" || Buffer.isBuffer(v)) return v as SqlValue;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function rowCount(n: number): string {
  return `${n} row${n === 1 ? "" : "s"}`;
}

async function removeFile(file: string): Promise<void> {
  for (const s of SIDECARS) await rm(file + s, { force: true });
}

/**
 * The copy. Returns the exit code; prints instead of throwing. Writes no file when it refuses, and leaves no
 * file behind when the check fails.
 */
export async function copyToSqlite(read: SnapshotReader, o: CopyOptions): Promise<number> {
  const dbDir = join(o.stateDir, "db");
  const target = join(dbDir, "factory.db");
  if (!o.dryRun) {
    const live = await o.livePids();
    if (live.length > 0) {
      o.print(`refusing: the factory is running on this machine (pid ${live.join(", ")}); stop it first, then copy again`);
      return 1;
    }
  }
  // The SQLite schema, built in memory: which tables it has, and the rows a new file holds (seed rows).
  const fresh = new SqliteDriver(":memory:");
  const schema = new Map<string, { rows: number; columns: Set<string> }>();
  try {
    await fresh.migrate();
    await o.schema(fresh);
    for (const t of await sourceTables(sqliteDb(fresh))) {
      const rows = Number((await fresh.all(`SELECT COUNT(*) AS n FROM ${q(t)}`))[0]!.n);
      schema.set(t, { rows, columns: new Set(await tableColumns(sqliteDb(fresh), t)) });
    }
  } finally {
    await fresh.close();
  }
  if (!o.dryRun && existsSync(target) && !o.replace) {
    const held = [...sqliteCounts(target)].filter(([t, n]) => t !== "schema_migrations" && t !== MIGRATIONS_TABLE && n !== (schema.get(t)?.rows ?? 0));
    if (held.length > 0) {
      o.print(`refusing: ${target} already holds data (${held.map(([t, n]) => `${t}: ${n} rows`).join(", ")}); copy again with --replace to back it up and replace it`);
      return 1;
    }
  }

  const stamp = o.now().toISOString().replace(/[:.]/g, "-");
  const tmp = join(dbDir, `factory.db.copy-${stamp}.tmp`);
  return read(async (src) => {
    const all = await sourceTables(src);
    const tables = all.filter((t) => !SKIP.has(t));
    const missing = tables.filter((t) => !schema.has(t));
    if (missing.length > 0) {
      o.print(`refusing: the SQLite schema has no table for ${missing.join(", ")}; nothing was written`);
      return 1;
    }
    const keys = new Map<string, string[]>();
    // Tables whose insertion order SQLite keeps in its hidden rowid, where MySQL has a `seq` column: the store
    // breaks ties on it (dialect.seq), so `seq` is copied into rowid, and a SQLite source reads its rowid as `seq`.
    const rowidSeq = new Set<string>();
    for (const t of tables) {
      const into = schema.get(t)!.columns;
      if (!into.has(SEQ)) rowidSeq.add(t);
      const extra = (await tableColumns(src, t)).filter((c) => !into.has(c) && !(c === SEQ && rowidSeq.has(t)));
      if (extra.length > 0) {
        o.print(`refusing: SQLite table ${t} has no column ${extra.join(", ")}; nothing was written`);
        return 1;
      }
      keys.set(t, await primaryKey(src, t));
    }
    for (const t of all.filter((t) => SKIP.has(t))) o.print(`skip ${t} (schema bookkeeping)`);
    if (o.dryRun) {
      for (const t of tables) o.print(`${t}: ${rowCount(Number((await src.all(`SELECT COUNT(*) AS n FROM ${q(t)}`))[0]!.n))}`);
      for (const t of [...schema.keys()].filter((t) => !all.includes(t))) o.print(`${t}: not in MySQL (left as SQLite builds it)`);
      o.print("dry run: nothing was written");
      return 0;
    }

    await mkdir(dbDir, { recursive: true, mode: 0o700 });
    await removeFile(tmp);
    const driver = new SqliteDriver(tmp);
    let placed = false;
    try {
      await driver.migrate();
      await o.schema(driver);
      const out = sqliteDb(driver);
      await driver.transaction(async (tx) => {
        await tx.run("PRAGMA defer_foreign_keys = ON");
        for (const t of tables) {
          const key = keys.get(t)!;
          const seqToRowid = rowidSeq.has(t);
          const select = src.dialect === "sqlite" && seqToRowid ? `rowid AS ${SEQ}, *` : "*";
          await tx.run(`DELETE FROM ${q(t)}`);
          for (let offset = 0; ; offset += BATCH) {
            const rows = await src.all(`SELECT ${select} FROM ${q(t)} ORDER BY ${key.map(q).join(", ")} LIMIT ${BATCH} OFFSET ${offset}`);
            for (const row of rows) {
              const cols = Object.keys(row);
              await tx.run(
                `INSERT INTO ${q(t)} (${cols.map((c) => q(seqToRowid && c === SEQ ? "rowid" : c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
                cols.map((c) => sqliteValue(row[c])),
              );
            }
            if (rows.length < BATCH) break;
          }
        }
      });
      const differ: string[] = [];
      let total = 0;
      for (const t of tables) {
        const key = keys.get(t)!;
        const a = await tableChecksum(src, t, key);
        const b = await tableChecksum(out, t, key);
        total += a.rows;
        if (a.rows !== b.rows) differ.push(`${t}: SQLite has ${b.rows} rows, MySQL has ${a.rows}`);
        else if (a.checksum !== b.checksum) differ.push(`${t}: primary keys differ (checksum ${b.checksum} vs ${a.checksum})`);
        else o.print(`${t}: ${rowCount(a.rows)}, checksum ${a.checksum}`);
      }
      if (differ.length > 0) {
        for (const d of differ) o.print(`mismatch: ${d}`);
        o.print("copy FAILED: the new file was deleted; nothing was replaced");
        return 1;
      }
      // One file to rename: the WAL is folded back into it.
      await driver.run("PRAGMA journal_mode = DELETE");
      await driver.close();
      if (existsSync(target)) {
        const backups = join(dbDir, "backups");
        await mkdir(backups, { recursive: true, mode: 0o700 });
        const backup = join(backups, `factory-${stamp}.db`);
        for (const s of SIDECARS) if (existsSync(target + s)) await rename(target + s, backup + s);
        o.print(`moved the old file to ${backup}`);
      }
      await rename(tmp, target);
      placed = true;
      o.print(`copied ${tables.length} tables (${total} rows) to ${target}`);
      o.print('next: set "store": { "type": "sqlite" } in factory.config.json, run `npm run migrate`, then start the factory');
      return 0;
    } finally {
      if (!placed) {
        await driver.close().catch(() => undefined);
        await removeFile(tmp);
      }
    }
  }).catch(async (err: unknown) => {
    await removeFile(tmp);
    o.print(`copy failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  });
}
