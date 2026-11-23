// Schedules that skip when busy (design 08-schedules, 2026-11-23): `controller_schedules.skip_when_busy` (null or 0:
// off, 1: on) and `controller_schedule_runs.queued_implement_runs`, the queued implement count a skipped occurrence
// was recorded with (null on every other outcome). Additive: two nullable columns, no backfill (a stored schedule
// keeps the option off), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_schedules")).includes("skip_when_busy")) await db.run("ALTER TABLE controller_schedules ADD COLUMN skip_when_busy INTEGER");
    if (!(await tableColumns(db, "controller_schedule_runs")).includes("queued_implement_runs")) {
      await db.run("ALTER TABLE controller_schedule_runs ADD COLUMN queued_implement_runs INTEGER");
    }
  },
});
