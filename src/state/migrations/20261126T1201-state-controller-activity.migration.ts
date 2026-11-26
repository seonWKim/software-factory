// The Activity record (design 08-schedules-actions, 2026-11-26): one `controller_activity` row per autonomous
// action the factory takes on its own (a lease expiry, a retention batch, a cleanup pass, an auto-grant, a schedule
// run, a supervised restart, a migration). `actor_id` is the job's system actor ID, never a display name; `kind` its
// Activity kind (src/controller/background-jobs.ts); `subject` what it acted on; `outcome` what came of it; `reason`
// why; `ref` a transcript path or a log reference (null: none); `at` the store's time. `controller_schedule_runs`
// gains `reason` and `ref` for the same two facts. Additive: a new table and two nullable columns, no backfill (past
// actions get no row), safe to rerun.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const TABLE = "controller_activity";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id  TEXT NOT NULL,
    kind      TEXT NOT NULL,
    subject   TEXT NOT NULL,
    outcome   TEXT NOT NULL,
    reason    TEXT NOT NULL,
    ref       TEXT,
    at        TEXT NOT NULL
  )`;

const RUN_COLUMNS = ["reason", "ref"] as const;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
    await db.run(`CREATE INDEX IF NOT EXISTS controller_activity_at ON ${TABLE} (at)`);
    for (const column of RUN_COLUMNS) {
      if (!(await tableColumns(db, "controller_schedule_runs")).includes(column)) await db.run(`ALTER TABLE controller_schedule_runs ADD COLUMN ${column} TEXT`);
    }
  },
});
