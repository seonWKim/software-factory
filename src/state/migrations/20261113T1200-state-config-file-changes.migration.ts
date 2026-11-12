// File-only key edits (design 08-settings, phase 2 of "Settings without editing factory.config.json"): one
// `runtime_config_file_changes` row per edit the writer filed as a local item, written in the item's transaction.
// `actor` is the asker's user ID (never a display name); `old_value` and `new_value` are JSON text, `old_value` null
// when the file had no such key; `branch` is the item's local branch. An audit only: the value lives in the file.
// SQLite only (owner answer: the MySQL store is being removed). Additive: a new table, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "runtime_config_file_changes";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id  TEXT NOT NULL UNIQUE,
    setting_key   TEXT NOT NULL,
    old_value     TEXT,
    new_value     TEXT NOT NULL,
    branch        TEXT NOT NULL,
    actor         TEXT NOT NULL,
    at            TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
