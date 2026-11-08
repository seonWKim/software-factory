// The audit of local users (design 08-permissions, issue #445): one row per add, role change or removal of an
// identity_local_users row, written in the same transaction as the change. `action` add | change | remove,
// `old_role` NULL for an add, `new_role` NULL for a remove, `actor` the user ID that made the change. A table of
// its own, not columns on identity_local_users: a removal deletes that row, and the audit row keeps the record.
// Additive: a new table only, no backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

const SQLITE = `CREATE TABLE IF NOT EXISTS identity_local_user_changes (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL,
    action    TEXT NOT NULL,
    old_role  TEXT,
    new_role  TEXT,
    actor     TEXT NOT NULL,
    at        TEXT NOT NULL
  )`;

const MYSQL = `CREATE TABLE IF NOT EXISTS identity_local_user_changes (
    seq       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id   VARCHAR(128) NOT NULL,
    action    VARCHAR(16) NOT NULL,
    old_role  VARCHAR(16) NULL,
    new_role  VARCHAR(16) NULL,
    actor     VARCHAR(128) NOT NULL,
    at        CHAR(24) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run(db.dialect === "sqlite" ? SQLITE : MYSQL);
  },
});
