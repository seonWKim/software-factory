// Issue #461: the run-results step reads finished runs not yet acknowledged (listUnacknowledgedRuns: status in
// the finished set, acknowledged_at IS NULL, ordered by updated_at). No index covered acknowledged_at, so every
// read scanned all of worker_runs. worker_runs_ack walks the unacknowledged runs in updated_at order; the status
// filter stays a check on each of those few rows. Additive: old code reads the same table.

import { defineMigration, type MigrationDb } from "../../state/index.js";

const TABLE = "worker_runs";
const INDEX = "worker_runs_ack";

async function hasIndex(db: MigrationDb): Promise<boolean> {
  const rows = await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?", [TABLE, INDEX]);
  return rows.length > 0;
}

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    if (!(await hasIndex(db))) await db.run(`CREATE INDEX ${INDEX} ON ${TABLE} (acknowledged_at, updated_at)`);
  },
});
