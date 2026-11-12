// The change fields, phase 4 (design 02-work-item): controller_work_items and controller_unreviewed_merges lose
// pr_number, the mirror of change_ref that SQLite migration 35 backfilled change_ref from.
// SQLite cannot remove a column under a UNIQUE key (unreviewed_merges' (project, pr_number)), so both tables are
// rebuilt: each is built as `<table>_next` without it, its rows copied and verified, and only then are the old
// tables renamed to `legacy_<table>` and the new ones take their names, as the prefix migration did
// (src/state/migrations/20261108T1300-state-prefix-tables). The legacy tables stay until a contract migration.
//
// The legacy tables keep the old index names, so the new indexes are named `<table>_by_<what>`. Renaming a parent
// table moves the foreign keys that point to it (SQLite follows a rename), so the work item
// children are pointed back at controller_work_items after the rename.
//
// This runs inside the migration transaction.

import { defineMigration, LEGACY_PREFIX, tableColumns, tableExists, verifyCopy, type MigrationDb } from "../../state/index.js";

interface Rebuild {
  readonly table: string;
  /** The statements that build `<table>_next`, its indexes included. */
  readonly statements: readonly string[];
}

const WORK_ITEMS = "controller_work_items";
const UNREVIEWED = "controller_unreviewed_merges";
const next = (table: string) => `${table}_next`;

const REBUILDS: readonly Rebuild[] = [
  {
    table: WORK_ITEMS,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${next(WORK_ITEMS)} (
    id                       TEXT PRIMARY KEY,
    version                  INTEGER NOT NULL,
    source_type              TEXT NOT NULL,
    source_id                TEXT NOT NULL,
    source_link              TEXT NOT NULL,
    requester_id             TEXT NOT NULL,
    project                  TEXT NOT NULL,
    problem                  TEXT NOT NULL,
    resources                TEXT NOT NULL,
    done_criteria            TEXT,
    desired_output           TEXT,
    scope                    TEXT,
    allowed_paths            TEXT NOT NULL,
    tier                     INTEGER,
    stage                    TEXT NOT NULL,
    blocked_on               TEXT NOT NULL,
    blocked_reason           TEXT,
    close_reason             TEXT,
    loop_count               INTEGER NOT NULL,
    restart_count            INTEGER NOT NULL,
    token_cost               INTEGER NOT NULL,
    merge_sha                TEXT,
    fixes_pr                 INTEGER,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    title                    TEXT,
    issue_text               TEXT,
    revision_count           INTEGER NOT NULL DEFAULT 0,
    spec_feedback            TEXT,
    spec_comment_url         TEXT,
    failure_comment_url      TEXT,
    origin                   TEXT NOT NULL DEFAULT 'factory',
    head_branch              TEXT,
    last_head_sha            TEXT,
    parent_id                TEXT,
    phase                    INTEGER,
    files_to_change          TEXT,
    pr_files                 TEXT,
    edges_source_updated_at  TEXT,
    change_ref               TEXT,
    change_url               TEXT,
    UNIQUE (source_type, source_id)
  )`,
      `CREATE INDEX IF NOT EXISTS ${WORK_ITEMS}_by_change ON ${next(WORK_ITEMS)} (project, change_ref)`,
      `CREATE INDEX IF NOT EXISTS ${WORK_ITEMS}_by_merge_sha ON ${next(WORK_ITEMS)} (merge_sha)`,
      `CREATE INDEX IF NOT EXISTS ${WORK_ITEMS}_by_parent ON ${next(WORK_ITEMS)} (parent_id, phase)`,
      `CREATE INDEX IF NOT EXISTS ${WORK_ITEMS}_by_stage ON ${next(WORK_ITEMS)} (stage, updated_at)`,
      `CREATE INDEX IF NOT EXISTS ${WORK_ITEMS}_by_tier ON ${next(WORK_ITEMS)} (project, tier, stage)`,
    ],
  },
  {
    table: UNREVIEWED,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${next(UNREVIEWED)} (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    merge_sha   TEXT NOT NULL,
    merger_id   TEXT,
    at          TEXT NOT NULL,
    change_ref  TEXT
  )`,
      `CREATE INDEX IF NOT EXISTS ${UNREVIEWED}_by_at ON ${next(UNREVIEWED)} (at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${UNREVIEWED}_by_change ON ${next(UNREVIEWED)} (project, change_ref)`,
    ],
  },
];

const legacy = (table: string) => `${LEGACY_PREFIX}${table}`;
const quote = (name: string) => `"${name}"`;

/** Builds `<table>_next` and fills it with every row of `table` over the new table's columns, verified. */
async function buildNext(db: MigrationDb, r: Rebuild): Promise<void> {
  for (const sql of r.statements) await db.run(sql);
  await db.run(`DELETE FROM ${next(r.table)}`); // half-filled by an interrupted run
  const cols = await tableColumns(db, next(r.table));
  const list = cols.map((c) => quote(c)).join(", ");
  await db.run(`INSERT INTO ${next(r.table)} (${list}) SELECT ${list} FROM ${r.table}`);
  const problems = await verifyCopy(db, r.table, next(r.table), cols);
  if (problems.length > 0) throw new Error(`copy of ${r.table} failed verification: ${problems.join("; ")}`);
}

/** The foreign keys outside the legacy tables that point to legacy_controller_work_items: moved there by the rename. */
async function keysOnLegacy(db: MigrationDb): Promise<{ table: string; column: string; to_column: string }[]> {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'legacy\\_%' ESCAPE '\\'");
  const out: { table: string; column: string; to_column: string }[] = [];
  for (const { name } of rows) {
    for (const k of await db.all(`SELECT "from" AS c, "to" AS t, "table" AS p FROM pragma_foreign_key_list('${String(name)}')`)) {
      if (k.p === legacy(WORK_ITEMS)) out.push({ table: String(name), column: String(k.c), to_column: String(k.t) });
    }
  }
  return out;
}

/**
 * Points the work item children back at controller_work_items. SQLite has no ALTER for a foreign key and cannot turn
 * foreign keys off inside a transaction, so their stored DDL is edited in place (SQLite's documented procedure for
 * a schema change that leaves the stored rows as they are: writable_schema, then a new schema_version).
 */
async function repointChildren(db: MigrationDb): Promise<void> {
  const keys = await keysOnLegacy(db);
  if (keys.length === 0) return;
  const [v] = await db.all("PRAGMA schema_version");
  await db.run("PRAGMA writable_schema = ON");
  for (const table of new Set(keys.map((k) => k.table))) {
    await db.run(`UPDATE sqlite_master SET sql = replace(sql, 'REFERENCES "${legacy(WORK_ITEMS)}"', 'REFERENCES ${WORK_ITEMS}') WHERE type = 'table' AND name = ?`, [table]);
  }
  await db.run(`PRAGMA schema_version = ${Number(v?.schema_version) + 1}`);
  await db.run("PRAGMA writable_schema = OFF");
}

export default defineMigration({
  change: "breaking",
  tables: REBUILDS.map((r) => r.table),
  async up(db) {
    const pending: Rebuild[] = [];
    for (const r of REBUILDS) if (!(await tableExists(db, legacy(r.table)))) pending.push(r);
    for (const r of pending) await buildNext(db, r);
    if (pending.length > 0) {
      for (const r of pending) {
        await db.run(`ALTER TABLE ${r.table} RENAME TO ${legacy(r.table)}`);
        await db.run(`ALTER TABLE ${next(r.table)} RENAME TO ${r.table}`);
      }
    }
    await repointChildren(db);
  },
  async verify(db) {
    const out: string[] = [];
    for (const r of REBUILDS) {
      if (!(await tableExists(db, legacy(r.table))) || !(await tableExists(db, r.table))) {
        out.push(`${r.table}: expected ${legacy(r.table)} and ${r.table}`);
        continue;
      }
      const cols = await tableColumns(db, r.table);
      if (cols.includes("pr_number")) out.push(`${r.table} still has pr_number`);
      out.push(...(await verifyCopy(db, legacy(r.table), r.table, cols)));
    }
    for (const k of await keysOnLegacy(db)) out.push(`${k.table}.${k.column} still points to ${legacy(WORK_ITEMS)}`);
    return out;
  },
});
