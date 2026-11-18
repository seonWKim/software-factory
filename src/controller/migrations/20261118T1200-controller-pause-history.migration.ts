// Pause history (design 07-self-improvement): one `controller_pause_history` row per ended `model_stall` or `network`
// claim pause, with when it began and ended, so the improve run can leave out the runs that failed inside one. The
// pause rows in `worker_claim_pauses` keep only the current time per name; this table is append-only, keyed on
// (name, started_at) so a pause is stored once, and retention does not prune it. SQLite only (owner answer: the
// MySQL store is being removed). Additive: a new table and its index, no backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

const TABLE = "controller_pause_history";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    UNIQUE (name, started_at)
  )`);
    await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_ended ON ${TABLE} (ended_at)`);
  },
});
