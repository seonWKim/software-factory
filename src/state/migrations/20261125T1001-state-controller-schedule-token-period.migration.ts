// The token cap's period (design 08-schedules, 2026-11-25): `controller_schedules.token_period`, `day` (the cap
// counts only the runs whose occurrence falls on the UTC date of the slot claimed) or `lifetime` (all its runs).
// `addSchedule` stores `day` for a daily cadence and `lifetime` for any other. Additive: one nullable TEXT column with
// no default and no backfill; null, every schedule stored before it, counts as `lifetime`. The column check makes a
// rerun change nothing.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const TABLE = "controller_schedules";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, TABLE)).includes("token_period")) await db.run(`ALTER TABLE ${TABLE} ADD COLUMN token_period TEXT`);
  },
});
