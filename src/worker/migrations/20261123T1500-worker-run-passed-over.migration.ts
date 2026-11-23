// Passed over (design 05-coordination, 2026-11-23): `passed_over_by` on `worker_runs`, the work item a queued run was last
// passed over for (an open session it overlaps, a coordination hold), so the item page names it. Set by claimRun, cleared
// by the claim. Additive: one nullable column, no backfill (an existing run names none), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "worker_runs")).includes("passed_over_by")) await db.run("ALTER TABLE worker_runs ADD COLUMN passed_over_by TEXT");
  },
});
