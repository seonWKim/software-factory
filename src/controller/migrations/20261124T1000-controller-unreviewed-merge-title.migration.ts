// A merged PR's title on its unreviewed merge row (design 09-dashboard-tasks-needs, 2026-11-24): `title` on
// `controller_unreviewed_merges`, the title the forge's closed-PR read already carries, so the Tasks page names each
// merge. Additive: one nullable column, no backfill (an older row has none and shows its PR number), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_unreviewed_merges")).includes("title")) await db.run("ALTER TABLE controller_unreviewed_merges ADD COLUMN title TEXT");
  },
});
