// The migration safety kit (RFC 0015 §12, rules D1, D2 and D4). Before a breaking step, every table it
// touches is written as JSONL under the state dir with a manifest of row counts and checksums. A copy is
// verified against its source before any swap. The same export archives a table before it is dropped.
// Logical export works on SQLite and MySQL alike and needs no mysqldump.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Row, SqlExecutor, SqlValue } from "../sql-driver.js";

const PAGE = 1_000;
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export interface TableSummary {
  readonly rows: number;
  /** Order-independent: the sum of each row's hash mod 2^64, as hex. */
  readonly checksum: string;
}

/** Only the rows whose `column` equals `value` (a merge copies several tables into one, RFC 0015 §12 D7). */
export interface RowFilter {
  readonly column: string;
  readonly value: SqlValue;
}

export interface BackupManifest {
  readonly id: string;
  readonly reason: string;
  readonly created_at: string;
  readonly tables: Readonly<Record<string, TableSummary>>;
}

function checkName(table: string): string {
  if (!TABLE_NAME.test(table)) throw new Error(`not a table name: ${table}`);
  return table;
}

async function* pages(db: SqlExecutor, table: string, filter?: RowFilter): AsyncGenerator<Row[]> {
  const where = filter ? ` WHERE ${checkName(filter.column)} = ?` : "";
  for (let offset = 0; ; offset += PAGE) {
    // Stable order for paging: every factory table has a primary key or rowid; ORDER BY 1 is enough
    // because the copy is verified with an order-independent checksum, not by position.
    const rows = await db.all(`SELECT * FROM ${checkName(table)}${where} ORDER BY 1 LIMIT ${PAGE} OFFSET ${offset}`, filter ? [filter.value] : []);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE) return;
  }
}

/** A row's values over `columns`, in that order, so the same values hash the same in any table. */
function canonical(row: Row, columns: readonly string[]): string {
  return JSON.stringify(columns.map((c) => normalize(row[c])));
}

function normalize(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}

function hash64(text: string): bigint {
  return createHash("sha256").update(text).digest().readBigUInt64BE(0);
}

const MOD = 1n << 64n;

/**
 * Row count and order-independent checksum of `table` over `columns`, hashed by position so renamed columns
 * still compare (all columns, sorted by name, when omitted).
 */
export async function tableChecksum(db: SqlExecutor, table: string, columns?: readonly string[], filter?: RowFilter): Promise<TableSummary> {
  let rows = 0;
  let sum = 0n;
  for await (const page of pages(db, table, filter)) {
    for (const row of page) {
      const cols = columns ?? Object.keys(row).sort();
      sum = (sum + hash64(canonical(row, cols))) % MOD;
      rows++;
    }
  }
  return { rows, checksum: sum.toString(16).padStart(16, "0") };
}

/**
 * D2 verify: `to` holds exactly the rows of `from` over `columns`. Returns the problems; empty means equal.
 * `columns` maps a column of `from` to its name in `to` (identity when the names match). `toFilter`: only those
 * rows of `to` are compared (the part of a merged table that came from `from`).
 */
export async function verifyCopy(
  db: SqlExecutor,
  from: string,
  to: string,
  columns: readonly string[] | Readonly<Record<string, string>>,
  toFilter?: RowFilter,
): Promise<string[]> {
  const fromCols = Array.isArray(columns) ? [...columns] : Object.keys(columns);
  const toCols = Array.isArray(columns) ? [...columns] : Object.values(columns);
  const a = await tableChecksum(db, from, fromCols);
  const b = await tableChecksum(db, to, toCols, toFilter);
  const out: string[] = [];
  if (a.rows !== b.rows) out.push(`${to} has ${b.rows} rows, ${from} has ${a.rows}`);
  else if (a.checksum !== b.checksum) out.push(`${to} differs from ${from} over ${fromCols.length} columns (checksum ${b.checksum} vs ${a.checksum})`);
  return out;
}

/** D1/D4: writes each table to `<dir>/<table>.jsonl` plus `manifest.json`. Read-only on the database. */
export async function backupTables(
  db: SqlExecutor,
  tables: readonly string[],
  dir: string,
  meta: { id: string; reason: string; created_at: string },
): Promise<BackupManifest> {
  mkdirSync(dir, { recursive: true });
  const summaries: Record<string, TableSummary> = {};
  for (const table of tables) {
    const lines: string[] = [];
    for await (const page of pages(db, table)) {
      for (const row of page) lines.push(JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalize(v)]))));
    }
    writeFileSync(join(dir, `${checkName(table)}.jsonl`), lines.length ? lines.join("\n") + "\n" : "");
    summaries[table] = await tableChecksum(db, table);
  }
  const manifest: BackupManifest = { ...meta, tables: summaries };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Puts a backup's rows back: each table is emptied and refilled, then checked against the manifest.
 * Run inside one transaction (the caller's `tx`), so a failed restore changes nothing.
 */
export async function restoreBackup(tx: SqlExecutor, dir: string): Promise<BackupManifest> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  for (const table of Object.keys(manifest.tables)) {
    await tx.run(`DELETE FROM ${checkName(table)}`);
    const text = readFileSync(join(dir, `${table}.jsonl`), "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as Record<string, SqlValue>;
      const cols = Object.keys(row);
      await tx.run(`INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]!));
    }
    const got = await tableChecksum(tx, table);
    const want = manifest.tables[table]!;
    if (got.rows !== want.rows || got.checksum !== want.checksum) {
      throw new Error(`restore of ${table} does not match the backup (${got.rows} rows ${got.checksum}, expected ${want.rows} rows ${want.checksum})`);
    }
  }
  return manifest;
}
