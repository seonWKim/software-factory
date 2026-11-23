// Schedules (design 08-schedules): `controller_schedules`, one row per schedule with its cadence, zone, next due
// time and the start of its running occurrence, and `controller_schedule_runs`, one row per claimed occurrence
// (fired or refused), unique on (schedule_id, occurrence_at). `outcome` is plain text so a later outcome adds no
// migration. Additive: two new tables and an index, no backfill (a plain task's repeat stays on the task), safe to
// rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_schedules", "controller_schedule_runs"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_schedules (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    cadence_kind   TEXT NOT NULL,
    cadence_spec   TEXT NOT NULL,
    zone           TEXT NOT NULL,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    next_due_at    TEXT,
    running_since  TEXT
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_schedules_due ON controller_schedules (next_due_at)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_schedule_runs (
    schedule_id    TEXT NOT NULL,
    occurrence_at  TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    PRIMARY KEY (schedule_id, occurrence_at)
  )`);
  },
});
