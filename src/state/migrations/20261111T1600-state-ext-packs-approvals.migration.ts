// Pack tool and MCP server approvals (design 11-packs, issue #589): one `ext_packs_approvals` row per approve or
// revoke of an `ext_packs_entries` entry, keyed by (kind, name, description_hash): the approval is pinned to that
// description. `action` approve | revoke, `user_id` the approver's user ID (never a display name), `at` from the
// Clock. The log is the audit too: the latest row of a key says whether that description is approved. Additive: a
// new table only, no backfill (no entry was ever approved), safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "ext_packs_approvals";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    description_hash  TEXT NOT NULL,
    action            TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    at                TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
