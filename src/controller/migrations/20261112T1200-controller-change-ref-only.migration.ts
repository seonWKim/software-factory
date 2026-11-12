// The change fields, phase 4 (design 02-work-item): controller_work_items and controller_unreviewed_merges lose
// pr_number, the mirror of change_ref that SQLite migration 35 and MySQL step 0035 backfilled change_ref from.
// SQLite cannot remove a column under a UNIQUE key (unreviewed_merges' (project, pr_number)), so both tables are
// rebuilt: each is built as `<table>_next` without it, its rows copied and verified, and only then are the old
// tables renamed to `legacy_<table>` and the new ones take their names, as the prefix migration did
// (src/state/migrations/20261108T1300-state-prefix-tables). The legacy tables stay until a contract migration.
//
// The legacy tables keep the old index names, so the new indexes are named `<table>_by_<what>`. Renaming a parent
// table moves the foreign keys that point to it (SQLite and InnoDB both follow a rename), so the work item
// children are pointed back at controller_work_items after the rename.
//
// SQLite runs this inside the migration transaction. MySQL DDL is not transactional, so every step is resumable:
// a table whose legacy copy exists is done, a half-filled `_next` table is emptied and refilled, the renames are
// one atomic RENAME TABLE, and a child key still pointing at a legacy table is moved on the rerun.

import { defineMigration, LEGACY_PREFIX, tableColumns, tableExists, verifyCopy, type MigrationDb } from "../../state/index.js";

const MYSQL_TABLE = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

interface Rebuild {
  readonly table: string;
  /** The statements that build `<table>_next`, its indexes included, on each dialect. */
  readonly sqlite: readonly string[];
  readonly mysql: readonly string[];
}

const WORK_ITEMS = "controller_work_items";
const UNREVIEWED = "controller_unreviewed_merges";
const next = (table: string) => `${table}_next`;

const REBUILDS: readonly Rebuild[] = [
  {
    table: WORK_ITEMS,
    sqlite: [
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
    // Keys inline, so the statement is whole and a rerun after a failure is a no-op.
    mysql: [
      `CREATE TABLE IF NOT EXISTS \`${next(WORK_ITEMS)}\` (
    seq                      BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
    id                       VARCHAR(64) NOT NULL PRIMARY KEY,
    version                  INT NOT NULL,
    source_type              VARCHAR(32) NOT NULL,
    source_id                VARCHAR(255) NOT NULL,
    source_link              TEXT NOT NULL,
    requester_id             VARCHAR(128) NOT NULL,
    project                  VARCHAR(255) NOT NULL,
    problem                  MEDIUMTEXT NOT NULL,
    resources                MEDIUMTEXT NOT NULL,
    done_criteria            MEDIUMTEXT,
    desired_output           MEDIUMTEXT,
    scope                    MEDIUMTEXT,
    allowed_paths            MEDIUMTEXT NOT NULL,
    tier                     TINYINT,
    stage                    VARCHAR(16) NOT NULL,
    blocked_on               VARCHAR(16) NOT NULL,
    blocked_reason           TEXT,
    close_reason             VARCHAR(32),
    loop_count               INT NOT NULL,
    restart_count            INT NOT NULL,
    token_cost               BIGINT NOT NULL,
    merge_sha                VARCHAR(64),
    fixes_pr                 INT,
    created_at               CHAR(24) NOT NULL,
    updated_at               CHAR(24) NOT NULL,
    title                    TEXT NULL,
    issue_text               MEDIUMTEXT NULL,
    revision_count           INT NOT NULL DEFAULT 0,
    spec_feedback            MEDIUMTEXT NULL,
    spec_comment_url         TEXT NULL,
    failure_comment_url      TEXT NULL,
    origin                   VARCHAR(16) NOT NULL DEFAULT 'factory',
    head_branch              VARCHAR(255) NULL,
    last_head_sha            VARCHAR(64) NULL,
    parent_id                VARCHAR(64) NULL,
    phase                    INT NULL,
    files_to_change          MEDIUMTEXT NULL,
    pr_files                 MEDIUMTEXT NULL,
    edges_source_updated_at  CHAR(24) NULL,
    change_ref               VARCHAR(64) NULL,
    change_url               TEXT NULL,
    UNIQUE KEY ${WORK_ITEMS}_by_source (source_type, source_id),
    KEY ${WORK_ITEMS}_by_change (project, change_ref),
    KEY ${WORK_ITEMS}_by_merge_sha (merge_sha),
    KEY ${WORK_ITEMS}_by_parent (parent_id, phase),
    KEY ${WORK_ITEMS}_by_stage (stage, updated_at),
    KEY ${WORK_ITEMS}_by_tier (project, tier, stage)
  ) ${MYSQL_TABLE}`,
    ],
  },
  {
    table: UNREVIEWED,
    sqlite: [
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
    mysql: [
      `CREATE TABLE IF NOT EXISTS \`${next(UNREVIEWED)}\` (
    seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    project     VARCHAR(255) NOT NULL,
    merge_sha   VARCHAR(64) NOT NULL,
    merger_id   VARCHAR(128) NULL,
    at          CHAR(24) NOT NULL,
    change_ref  VARCHAR(64) NULL,
    UNIQUE KEY ${UNREVIEWED}_by_change (project, change_ref),
    KEY ${UNREVIEWED}_by_at (at)
  ) ${MYSQL_TABLE}`,
    ],
  },
];

const legacy = (table: string) => `${LEGACY_PREFIX}${table}`;
const quote = (db: MigrationDb, name: string) => (db.dialect === "mysql" ? `\`${name}\`` : `"${name}"`);

/** Builds `<table>_next` and fills it with every row of `table` over the new table's columns, verified. */
async function buildNext(db: MigrationDb, r: Rebuild): Promise<void> {
  for (const sql of db.dialect === "sqlite" ? r.sqlite : r.mysql) await db.run(sql);
  await db.run(`DELETE FROM ${next(r.table)}`); // half-filled by an interrupted run
  const cols = await tableColumns(db, next(r.table));
  const list = cols.map((c) => quote(db, c)).join(", ");
  await db.run(`INSERT INTO ${next(r.table)} (${list}) SELECT ${list} FROM ${r.table}`);
  const problems = await verifyCopy(db, r.table, next(r.table), cols);
  if (problems.length > 0) throw new Error(`copy of ${r.table} failed verification: ${problems.join("; ")}`);
}

/** The foreign keys outside the legacy tables that point to legacy_controller_work_items: moved there by the rename. */
async function keysOnLegacy(db: MigrationDb): Promise<{ table: string; name: string; column: string; to_column: string }[]> {
  if (db.dialect === "sqlite") {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'legacy\\_%' ESCAPE '\\'");
    const out: { table: string; name: string; column: string; to_column: string }[] = [];
    for (const { name } of rows) {
      for (const k of await db.all(`SELECT "from" AS c, "to" AS t, "table" AS p FROM pragma_foreign_key_list('${String(name)}')`)) {
        if (k.p === legacy(WORK_ITEMS)) out.push({ table: String(name), name: "", column: String(k.c), to_column: String(k.t) });
      }
    }
    return out;
  }
  const rows = await db.all(
    `SELECT table_name AS t, constraint_name AS n, column_name AS c, referenced_column_name AS rc FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name = ? AND table_name NOT LIKE 'legacy\\_%'`,
    [legacy(WORK_ITEMS)],
  );
  return rows.map((r) => ({ table: String(r.t), name: String(r.n), column: String(r.c), to_column: String(r.rc) }));
}

/**
 * Points the work item children back at controller_work_items. SQLite has no ALTER for a foreign key and cannot turn
 * foreign keys off inside a transaction, so their stored DDL is edited in place (SQLite's documented procedure for
 * a schema change that leaves the stored rows as they are: writable_schema, then a new schema_version). MySQL adds a
 * key to the new table before it removes the one on the legacy table, so a rerun finds whatever is left.
 */
async function repointChildren(db: MigrationDb): Promise<void> {
  const keys = await keysOnLegacy(db);
  if (keys.length === 0) return;
  if (db.dialect === "sqlite") {
    const [v] = await db.all("PRAGMA schema_version");
    await db.run("PRAGMA writable_schema = ON");
    for (const table of new Set(keys.map((k) => k.table))) {
      await db.run(`UPDATE sqlite_master SET sql = replace(sql, 'REFERENCES "${legacy(WORK_ITEMS)}"', 'REFERENCES ${WORK_ITEMS}') WHERE type = 'table' AND name = ?`, [table]);
    }
    await db.run(`PRAGMA schema_version = ${Number(v?.schema_version) + 1}`);
    await db.run("PRAGMA writable_schema = OFF");
    return;
  }
  for (const k of keys) {
    const moved = `${k.name}_new`;
    const has = await db.all("SELECT 1 AS x FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?", [k.table, moved]);
    if (has.length === 0) {
      await db.run(`ALTER TABLE \`${k.table}\` ADD CONSTRAINT \`${moved}\` FOREIGN KEY (\`${k.column}\`) REFERENCES \`${WORK_ITEMS}\` (\`${k.to_column}\`)`);
    }
    await db.run(`ALTER TABLE \`${k.table}\` DROP FOREIGN KEY \`${k.name}\``);
  }
}

export default defineMigration({
  change: "breaking",
  tables: REBUILDS.map((r) => r.table),
  async up(db) {
    const pending: Rebuild[] = [];
    for (const r of REBUILDS) if (!(await tableExists(db, legacy(r.table)))) pending.push(r);
    for (const r of pending) await buildNext(db, r);
    if (pending.length > 0) {
      if (db.dialect === "mysql") {
        await db.run(`RENAME TABLE ${pending.map((r) => `\`${r.table}\` TO \`${legacy(r.table)}\`, \`${next(r.table)}\` TO \`${r.table}\``).join(", ")}`);
      } else {
        for (const r of pending) {
          await db.run(`ALTER TABLE ${r.table} RENAME TO ${legacy(r.table)}`);
          await db.run(`ALTER TABLE ${next(r.table)} RENAME TO ${r.table}`);
        }
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
