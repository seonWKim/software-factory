// Run next (design 05-coordination, 2026-11-22): `run_next_seq` on `worker_runs`, set by the owner's Run next on a
// queued run; claimRun takes the highest first, ahead of the kind rank. Additive: one nullable column, no backfill
// (an existing run has none, so the queued runs keep their order), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "worker_runs")).includes("run_next_seq")) await db.run("ALTER TABLE worker_runs ADD COLUMN run_next_seq INTEGER");
  },
});
