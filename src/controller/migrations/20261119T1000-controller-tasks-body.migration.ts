// Plain tasks get a description (design 02-tasks): `body` on `controller_tasks`, the text Build this puts below the
// title in its work item's problem. Additive: one nullable column, no backfill (an existing task has none), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_tasks")).includes("body")) await db.run("ALTER TABLE controller_tasks ADD COLUMN body TEXT");
  },
});
