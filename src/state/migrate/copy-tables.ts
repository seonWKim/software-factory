// Renames tables without moving data in place (RFC 0015 §12 D2): each table is cloned under its new name
// from its own DDL (same columns, types, keys, foreign keys, auto-increment counter), its rows copied and
// verified over every column, and only then are all old tables renamed to `legacy_<old>` at once. Until the
// contract migration drops them, the legacy tables are the way back (D9).
//
// SQLite runs this inside the caller's transaction. Every phase is resumable too: a table whose legacy copy
// exists is done, and a half-built new table is dropped and rebuilt.

import type { MigrationDb } from "./migration.js";
import { verifyCopy } from "./backup.js";

export interface Rename {
  readonly from: string;
  readonly to: string;
}

export const LEGACY_PREFIX = "legacy_";

const NAME = /^[a-z_][a-z0-9_]*$/;

function q(name: string): string {
  if (!NAME.test(name)) throw new Error(`not a table name: ${name}`);
  return name;
}

export async function tableExists(db: MigrationDb, table: string): Promise<boolean> {
  const rows = await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return rows.length > 0;
}

export async function tableColumns(db: MigrationDb, table: string): Promise<string[]> {
  const rows = await db.all(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`);
  return rows.map((r) => String(r.name));
}

/** A renamed index: the old table's prefix swapped for the new one, else the new table's name in front. */
export function renamedObject(name: string, r: Rename): string {
  return name.startsWith(`${r.from}_`) ? `${r.to}${name.slice(r.from.length)}` : `${r.to}_${name}`;
}

/** The old table's DDL rewritten for the new name, with references to renamed tables following them. */
async function cloneDdl(db: MigrationDb, r: Rename, map: ReadonlyMap<string, string>): Promise<{ table: string; indexes: string[] }> {
  const [row] = await db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [r.from]);
  const ddl = String(row?.sql ?? "");
  const table = ddl
    .replace(/^CREATE TABLE\s+"?(\w+)"?/i, `CREATE TABLE ${r.to}`)
    .replace(/REFERENCES\s+"?(\w+)"?\s*\(/gi, (m, t: string) => `REFERENCES ${map.get(t) ?? t}(`);
  const idx = await db.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name", [r.from]);
  const indexes = idx.map((i) =>
    String(i.sql)
      .replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)"?(\w+)"?/i, (_, head: string, n: string) => `${head}${renamedObject(n, r)}`)
      .replace(/\bON\s+"?(\w+)"?\s*\(/i, `ON ${r.to} (`),
  );
  return { table, indexes };
}

/** `tables` with each one after every table among them its foreign keys point to. */
async function parentsFirst(db: MigrationDb, tables: readonly string[]): Promise<string[]> {
  const deps = new Map<string, Set<string>>();
  const names = new Set(tables);
  for (const t of tables) {
    const refs = (await db.all(`SELECT "table" AS t FROM pragma_foreign_key_list('${t}')`)).map((x) => String(x.t));
    deps.set(t, new Set(refs.filter((r) => names.has(r) && r !== t)));
  }
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, path: Set<string>): void => {
    if (done.has(t)) return;
    if (path.has(t)) throw new Error(`foreign key cycle through ${t}`);
    path.add(t);
    for (const d of deps.get(t) ?? []) visit(d, path);
    done.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

/** Copy order: a table after every table its foreign keys point to (among those being copied). */
async function copyOrder(db: MigrationDb, renames: readonly Rename[]): Promise<Rename[]> {
  const by = new Map(renames.map((r) => [r.from, r]));
  return (await parentsFirst(db, renames.map((r) => r.from))).map((t) => by.get(t)!);
}

/**
 * Drops the tables that exist among `tables`, each before any table it points to by foreign key, so a contract
 * migration that stopped half way finishes on its rerun (§12 D3). The runner archived their rows first (D4).
 */
export async function dropTables(db: MigrationDb, tables: readonly string[]): Promise<void> {
  const present: string[] = [];
  for (const t of tables) if (await tableExists(db, t)) present.push(t);
  for (const t of (await parentsFirst(db, present)).reverse()) await db.run(`DROP TABLE ${q(t)}`);
}

export interface CopyReport {
  readonly table: string;
  readonly to: string;
  readonly rows: number;
}

/**
 * Copies each `from` to `to` (when `to` is set) and verifies it, then renames every `from` to `legacy_<from>`.
 * `archiveOnly`: tables with no successor; they are only renamed to legacy (archived first by the runner's backup).
 */
export async function renameTablesByCopy(db: MigrationDb, renames: readonly Rename[], archiveOnly: readonly string[] = []): Promise<CopyReport[]> {
  const pending: Rename[] = [];
  for (const r of renames) {
    if (await tableExists(db, LEGACY_PREFIX + r.from)) continue; // done by an earlier, interrupted run
    if (!(await tableExists(db, r.from))) throw new Error(`cannot rename ${r.from}: the table does not exist`);
    pending.push(r);
  }
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const report: CopyReport[] = [];
  for (const r of await copyOrder(db, pending)) {
    if (await tableExists(db, r.to)) await db.run(`DROP TABLE ${q(r.to)}`); // half-built by an interrupted run
    const ddl = await cloneDdl(db, r, map);
    await db.run(ddl.table);
    for (const i of ddl.indexes) await db.run(i);
    const cols = await tableColumns(db, r.from);
    const list = cols.map((c) => `"${c}"`).join(", ");
    await db.run(`INSERT INTO ${q(r.to)} (${list}) SELECT ${list} FROM ${q(r.from)}`);
    if (await tableExists(db, "sqlite_sequence")) {
      // Keep the AUTOINCREMENT high-water mark, so a deleted seq is never handed out again.
      await db.run("UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name = ?) WHERE name = ? AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)", [r.from, r.to, r.from]);
      await db.run("INSERT INTO sqlite_sequence (name, seq) SELECT ?, seq FROM sqlite_sequence WHERE name = ? AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)", [r.to, r.from, r.to]);
    }
    const problems = await verifyCopy(db, r.from, r.to, cols);
    if (problems.length > 0) throw new Error(`copy of ${r.from} to ${r.to} failed verification: ${problems.join("; ")}`);
    const [count] = await db.all(`SELECT COUNT(*) AS n FROM ${q(r.to)}`);
    report.push({ table: r.from, to: r.to, rows: Number(count?.n ?? 0) });
  }
  const toLegacy = [...pending.map((r) => r.from)];
  for (const t of archiveOnly) if (!(await tableExists(db, LEGACY_PREFIX + t)) && (await tableExists(db, t))) toLegacy.push(t);
  if (toLegacy.length > 0) {
    for (const t of toLegacy) await db.run(`ALTER TABLE ${t} RENAME TO ${LEGACY_PREFIX}${t}`);
  }
  return report;
}

/**
 * Verifies a finished rename: every new table holds exactly its legacy table's rows over the legacy columns,
 * and every archive-only table sits as legacy_<name>. Returns the problems.
 */
export async function verifyRenamedTables(db: MigrationDb, renames: readonly Rename[], archiveOnly: readonly string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const r of renames) {
    const legacy = LEGACY_PREFIX + r.from;
    if (!(await tableExists(db, legacy)) || !(await tableExists(db, r.to))) {
      out.push(`${r.from}: expected ${legacy} and ${r.to}`);
      continue;
    }
    out.push(...(await verifyCopy(db, legacy, r.to, await tableColumns(db, legacy))));
  }
  for (const t of archiveOnly) if ((await tableExists(db, t)) && !(await tableExists(db, LEGACY_PREFIX + t))) out.push(`${t}: not archived as ${LEGACY_PREFIX}${t}`);
  return out;
}
