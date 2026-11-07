// The change columns beside pr_number: the same as SQLite migration 35 (phase 1 of the change fields).
// work_items.change_ref (the PR number as text), work_items.change_url (https://<label>/pull/<n> for a GitHub
// project key whose label cursor `project_label:<key>` exists, else NULL: the same string as prUrl in src/main.ts),
// unreviewed_merges.change_ref; an index on work_items (project, change_ref) and a unique key on unreviewed_merges
// (project, change_ref).
//
// MySQL 8 has no ADD COLUMN IF NOT EXISTS, and DDL commits on its own, so a run that fails midway leaves part of
// the schema in place. Every change is checked first: a column or key is added only when information_schema lacks
// it, and the backfill only fills NULL columns. A second apply changes nothing.

import type { DataStep, Row, StepDb } from "../step.js";

interface Column {
  table: string;
  column: string;
  type: string;
}

interface Key {
  table: string;
  name: string;
  unique: boolean;
  columns: string;
}

const COLUMNS: readonly Column[] = [
  { table: "work_items", column: "change_ref", type: "VARCHAR(64) NULL" },
  { table: "work_items", column: "change_url", type: "TEXT NULL" },
  { table: "unreviewed_merges", column: "change_ref", type: "VARCHAR(64) NULL" },
];

const KEYS: readonly Key[] = [
  { table: "work_items", name: "work_items_change", unique: false, columns: "project, change_ref" },
  { table: "unreviewed_merges", name: "unreviewed_merges_change", unique: true, columns: "project, change_ref" },
];

/** The rows each backfill fills: only NULL columns, so a rerun matches none. */
const REF_WHERE = "pr_number IS NOT NULL AND change_ref IS NULL";
const LABEL_JOIN = "JOIN cursors c ON c.name = CONCAT('project_label:', w.project)";
const URL_WHERE = "w.pr_number IS NOT NULL AND w.change_url IS NULL AND w.project LIKE 'github:%'";

async function missingColumns(db: StepDb): Promise<Column[]> {
  const rows = await db.all(
    "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name IN ('change_ref', 'change_url')",
  );
  const have = new Set(rows.map((r) => `${String(r.t)}.${String(r.c)}`));
  return COLUMNS.filter((c) => !have.has(`${c.table}.${c.column}`));
}

async function missingKeys(db: StepDb): Promise<Key[]> {
  const rows = await db.all(
    "SELECT DISTINCT table_name AS t, index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name IN ('work_items_change', 'unreviewed_merges_change')",
  );
  const have = new Set(rows.map((r) => `${String(r.t)}.${String(r.i)}`));
  return KEYS.filter((k) => !have.has(`${k.table}.${k.name}`));
}

const step: DataStep = {
  async plan(db) {
    const columns = await missingColumns(db);
    const out: Row[] = [
      ...columns.map((c) => ({ add_column: `${c.table}.${c.column}` })),
      ...(await missingKeys(db)).map((k) => ({ add_key: `${k.table}.${k.name}` })),
    ];
    const missing = (table: string, column: string) => columns.some((c) => c.table === table && c.column === column);
    // A column not added yet is NULL on every row once added.
    const refWhere = (table: string) => (missing(table, "change_ref") ? "pr_number IS NOT NULL" : REF_WHERE);
    for (const r of await db.all(`SELECT id, pr_number FROM work_items WHERE ${refWhere("work_items")} ORDER BY id`)) {
      out.push({ table: "work_items", id: r.id, change_ref: String(r.pr_number) });
    }
    const urlWhere = missing("work_items", "change_url") ? URL_WHERE.replace(" AND w.change_url IS NULL", "") : URL_WHERE;
    for (const r of await db.all(
      `SELECT w.id, CONCAT('https://', c.value, '/pull/', w.pr_number) AS url FROM work_items w ${LABEL_JOIN} WHERE ${urlWhere} ORDER BY w.id`,
    )) {
      out.push({ table: "work_items", id: r.id, change_url: r.url });
    }
    for (const r of await db.all(`SELECT id, pr_number FROM unreviewed_merges WHERE ${refWhere("unreviewed_merges")} ORDER BY id`)) {
      out.push({ table: "unreviewed_merges", id: r.id, change_ref: String(r.pr_number) });
    }
    return out;
  },

  async apply(db) {
    for (const c of await missingColumns(db)) await db.run(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
    await db.run(`UPDATE work_items SET change_ref = CAST(pr_number AS CHAR) WHERE ${REF_WHERE}`);
    await db.run(`UPDATE work_items w ${LABEL_JOIN} SET w.change_url = CONCAT('https://', c.value, '/pull/', w.pr_number) WHERE ${URL_WHERE}`);
    await db.run(`UPDATE unreviewed_merges SET change_ref = CAST(pr_number AS CHAR) WHERE ${REF_WHERE}`);
    for (const k of await missingKeys(db)) {
      await db.run(`CREATE ${k.unique ? "UNIQUE " : ""}INDEX ${k.name} ON ${k.table} (${k.columns})`);
    }
  },
};

export default step;
