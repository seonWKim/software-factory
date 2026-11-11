// Pack tool and MCP server approvals (design 11-packs, issue #589): one `ext_packs_approvals` row per approve or
// revoke of an `ext_packs_entries` entry, keyed by (kind, name, description_hash): the approval is pinned to that
// description. `action` approve | revoke, `user_id` the approver's user ID (never a display name), `at` from the
// Clock. The log is the audit too: the latest row of a key says whether that description is approved. Additive: a
// new table only, no backfill (no entry was ever approved), safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_packs_approvals";

const SQLITE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    description_hash  TEXT NOT NULL,
    action            TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    at                TEXT NOT NULL
  )`;

const MYSQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq               BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind              VARCHAR(16) NOT NULL,
    name              VARCHAR(191) NOT NULL,
    description_hash  CHAR(64) NOT NULL,
    action            VARCHAR(16) NOT NULL,
    user_id           VARCHAR(191) NOT NULL,
    at                CHAR(24) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(db.dialect === "sqlite" ? SQLITE : MYSQL);
  },
});
