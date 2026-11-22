// Project files (design 02-tasks): `base_folder` on `controller_projects`, the resolved real path of the folder whose
// files the Tasks page's Files tab shows. Additive: one nullable column, no backfill (an existing project has none), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_projects")).includes("base_folder")) await db.run("ALTER TABLE controller_projects ADD COLUMN base_folder TEXT");
  },
});
