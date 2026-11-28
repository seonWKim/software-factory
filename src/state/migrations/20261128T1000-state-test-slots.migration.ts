// Host test slots (phase 1 of 3 of local-28caa30d): one `worker_test_slots` row per full test run in progress on the
// host, so every worker process counts the same slots. `holder` is the run ID that took the slot, `expires_at` its
// lease expiry: a take deletes the expired rows first, so a slot whose holder died frees itself. Additive: a new
// table only, no backfill, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "worker_test_slots";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    holder      TEXT NOT NULL PRIMARY KEY,
    expires_at  TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
