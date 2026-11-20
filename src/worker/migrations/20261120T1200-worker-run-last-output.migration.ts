// A run's last model output time (design 05-restarts): `last_output_at` on `worker_runs`, written by the worker on
// model output (never by the heartbeat), read by the controller to tell one silent run from a model that is down.
// Additive: one nullable column, no backfill (an existing run has none), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "worker_runs")).includes("last_output_at")) await db.run("ALTER TABLE worker_runs ADD COLUMN last_output_at TEXT");
  },
});
