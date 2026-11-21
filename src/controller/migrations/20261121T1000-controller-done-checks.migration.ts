// Done-when checks (design 04-triage.md, 2026-11-22): triage's check per done-when line, stored on the item as
// `done_checks` (JSON text) by the controller's triage branch. Additive: one nullable column, no backfill (an item
// triaged before keeps null), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_work_items")).includes("done_checks")) await db.run("ALTER TABLE controller_work_items ADD COLUMN done_checks TEXT");
  },
});
