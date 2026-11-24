// A task that followed its rejected item's replacement (design 02-tasks-build, 2026-11-24): `link_note` on
// `controller_tasks`, the short note (`Moved from wi_…`) the store writes when it moves the task's link. Additive: one
// nullable column, no backfill (an existing task, open or closed by hand, keeps its state and has none), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_tasks")).includes("link_note")) await db.run("ALTER TABLE controller_tasks ADD COLUMN link_note TEXT");
  },
});
