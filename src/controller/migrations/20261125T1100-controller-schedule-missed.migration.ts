// The missed-time setting (design 08-schedules, 2026-11-25): `controller_schedules.missed_rule`, `catch_up` (a claim
// fires once, however late) or `skip` (a claim late by more than a tick, or while the factory is busy, is skipped).
// Additive: one TEXT NOT NULL column defaulting to `catch_up`, and every row whose skip_when_busy is 1 becomes `skip`.
// skip_when_busy stays, no longer read. The column check makes a rerun change nothing.

import { defineMigration, tableColumns } from "../../state/index.js";

const TABLE = "controller_schedules";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    if ((await tableColumns(db, TABLE)).includes("missed_rule")) return;
    await db.run(`ALTER TABLE ${TABLE} ADD COLUMN missed_rule TEXT NOT NULL DEFAULT 'catch_up'`);
    await db.run(`UPDATE ${TABLE} SET missed_rule = 'skip' WHERE skip_when_busy = 1`);
  },
});
