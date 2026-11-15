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

/**
 * Where one `legacy_*` table's rows live now. `to: null`: a retired table with no replacement (`why` says so); its
 * rows are only archived. `key` and `values` map a current column to a SQL expression over the legacy row `l`;
 * by default the key is the legacy table's primary key and the values are the columns both tables have.
 */
export interface LegacySource {
  readonly to: string | null;
  readonly why?: string;
  readonly key?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
}

interface LegacyPlan {
  readonly legacy: string;
  readonly source: LegacySource;
  readonly rows: number;
  readonly key: Record<string, string>;
  readonly values: Record<string, string>;
}

const quoted = (c: string) => `"${c}"`;

/** Every `legacy_*` table in the database. */
export async function legacyTables(db: MigrationDb): Promise<string[]> {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\' ORDER BY name", [`${LEGACY_PREFIX.replace("_", "\\_")}%`]);
  return rows.map((r) => String(r.name));
}

async function planOf(db: MigrationDb, legacy: string, source: LegacySource): Promise<LegacyPlan> {
  const [count] = await db.all(`SELECT COUNT(*) AS n FROM ${q(legacy)}`);
  const plan = { legacy, source, rows: Number(count?.n ?? 0), key: {}, values: {} };
  if (source.to === null) return plan;
  if (!(await tableExists(db, source.to))) throw new Error(`${legacy} maps to ${source.to}, which does not exist; nothing was dropped`);
  const own = await tableColumns(db, legacy);
  const pk = (await db.all(`SELECT name FROM pragma_table_info('${q(legacy)}') WHERE pk > 0 ORDER BY pk`)).map((r) => String(r.name));
  const key = source.key ?? Object.fromEntries(pk.map((c) => [c, `l.${quoted(c)}`]));
  if (Object.keys(key).length === 0) throw new Error(`${legacy} has no primary key and its mapping gives none; nothing was dropped`);
  const target = await db.all(`SELECT name, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${q(source.to)}')`);
  const values = source.values ?? Object.fromEntries(target.filter((c) => own.includes(String(c.name))).map((c) => [String(c.name), `l.${quoted(String(c.name))}`]));
  const required = target.filter((c) => Number(c.nn) === 1 && c.d === null && Number(c.pk) === 0 && !(String(c.name) in values)).map((c) => String(c.name));
  if (required.length > 0) throw new Error(`${legacy} cannot fill ${source.to}.${required.join(", ")}; nothing was dropped`);
  return { ...plan, key, values };
}

/** The legacy rows whose key is not in the current table: the SELECT list is the key's columns. */
function missingSql(p: LegacyPlan, select: string): string {
  const match = Object.entries(p.key).map(([c, e]) => `c.${quoted(c)} IS ${e}`).join(" AND ");
  return `SELECT ${select} FROM ${q(p.legacy)} l WHERE NOT EXISTS (SELECT 1 FROM ${q(p.source.to!)} c WHERE ${match})`;
}

async function missingKeys(db: MigrationDb, p: LegacyPlan): Promise<string[]> {
  if (p.source.to === null) return [];
  const cols = Object.keys(p.key);
  const rows = await db.all(`${missingSql(p, Object.entries(p.key).map(([c, e]) => `${e} AS ${quoted(c)}`).join(", "))} ORDER BY ${cols.map(quoted).join(", ")}`);
  return rows.map((r) => cols.map((c) => `${c}=${String(r[c])}`).join(" "));
}

/**
 * The contract for `legacy_*` tables (RFC 0015 §12 D2): every legacy table in the database must be in `sources`,
 * else nothing happens and the error names the unmapped ones. Each legacy row whose key is not in its current table
 * is copied there (parents before children), the copy is checked, and then every legacy table is dropped. Safe to
 * rerun: a row already copied is not copied again, and a run that stopped before the drops only drops. The runner
 * archived the rows first (D4). Prints one line per table, with the key of each row it copied.
 */
export async function dropLegacyTables(db: MigrationDb, sources: Readonly<Record<string, LegacySource>>, print: (line: string) => void): Promise<void> {
  const present = await legacyTables(db);
  const unmapped = present.filter((t) => !Object.hasOwn(sources, t));
  if (unmapped.length > 0) throw new Error(`no current table is mapped for ${unmapped.join(", ")}; nothing was copied or dropped`);
  const plans: LegacyPlan[] = [];
  for (const t of present) plans.push(await planOf(db, t, sources[t]!));
  const targets = await parentsFirst(db, [...new Set(plans.flatMap((p) => (p.source.to === null ? [] : [p.source.to])))]);
  const copied = new Map<string, string[]>();
  for (const to of targets) {
    for (const p of plans.filter((x) => x.source.to === to)) {
      const keys = await missingKeys(db, p);
      copied.set(p.legacy, keys);
      if (keys.length === 0) continue;
      const cols = Object.keys(p.values);
      try {
        await db.run(`INSERT INTO ${q(to)} (${cols.map(quoted).join(", ")}) ${missingSql(p, Object.values(p.values).join(", "))}`);
      } catch (e) {
        throw new Error(`copy of ${p.legacy} into ${to} failed: ${(e as Error).message}; nothing was dropped`);
      }
      const left = await missingKeys(db, p);
      if (left.length > 0) throw new Error(`${p.legacy}: ${left.length} rows still missing from ${to} after the copy; nothing was dropped`);
    }
  }
  await dropTables(db, present);
  for (const p of plans) {
    const keys = copied.get(p.legacy) ?? [];
    const into = p.source.to === null ? `retired (${p.source.why ?? "no replacement"}), nothing copied` : `copied ${keys.length} into ${p.source.to}`;
    print(`${p.legacy}: ${p.rows} rows; ${into}; dropped ${p.rows}`);
    for (const k of keys) print(`  copied ${k}`);
  }
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
