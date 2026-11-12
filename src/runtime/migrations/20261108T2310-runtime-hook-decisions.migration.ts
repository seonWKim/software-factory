// RFC 0015 M10: the audit of hook decisions (one row per enabled hook that ran at a point). Additive: a new table
// only, safe to rerun. Ids only: subject, project and passport ids, never a display name.

import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS runtime_hook_decisions (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    hook         TEXT NOT NULL,
    point        TEXT NOT NULL,
    subject      TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    passport_id  TEXT,
    outcome      TEXT NOT NULL,
    text         TEXT,
    at           TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS runtime_hook_decisions_subject ON runtime_hook_decisions (subject, seq)",
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
  },
});
