// Standing-rule changes (design 05-standing-approvals, 2026-11-22): one `controller_standing_rule_changes` row per
// add, pause, edit or remove of a rule, from the Rules page or `/standing`. `action` is add, pause, edit or remove;
// `before_value` and `after_value` are JSON text (`{"enabled":…}` or `{"threshold":…}`), null for no row before (add)
// or none after (remove); `actor` is a user ID, never a display name. Additive: a new table, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "controller_standing_rule_changes";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    gate          TEXT NOT NULL,
    tier          INTEGER NOT NULL,
    action        TEXT NOT NULL,
    before_value  TEXT,
    after_value   TEXT,
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
