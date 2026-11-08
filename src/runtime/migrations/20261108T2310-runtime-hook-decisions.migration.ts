// RFC 0015 M10: the audit of hook decisions (one row per enabled hook that ran at a point). Additive: a new table
// only, safe to rerun. Ids only: subject, project and passport ids, never a display name.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
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

// Index inline, so the statement is whole and a rerun after a failure (MySQL DDL is not transactional) is a no-op.
const MYSQL = [
  `CREATE TABLE IF NOT EXISTS runtime_hook_decisions (
    seq          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hook         VARCHAR(64) NOT NULL,
    point        VARCHAR(32) NOT NULL,
    subject      VARCHAR(191) NOT NULL,
    project_id   VARCHAR(191) NOT NULL,
    passport_id  VARCHAR(191) NULL,
    outcome      VARCHAR(16) NOT NULL,
    text         VARCHAR(255) NULL,
    at           CHAR(24) NOT NULL,
    KEY runtime_hook_decisions_subject (subject, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of db.dialect === "sqlite" ? SQLITE : MYSQL) await db.run(sql);
  },
});
