// The one-time size cap (design 04-split-specs, 2026-11-24): `size_cap` on controller_work_items, the cap an over-cap
// `/approve` stored as JSON text (`max_diff_lines`, `max_diff_files`), read through src/core/size-cap.ts. Additive: one
// nullable column, no backfill (an item approved before keeps null, so its project's caps apply), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "controller_work_items")).includes("size_cap")) await db.run("ALTER TABLE controller_work_items ADD COLUMN size_cap TEXT");
  },
});
