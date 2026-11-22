// One-off repair: a queued run whose work item is CLOSED. Before 2026-11-22 a run an interactive takeover cancelled
// got an automatic retry, and a merge close left it queued (design 05-restarts), so a worker could claim it on a closed
// item. Cancels such runs as the store's cancel does (status cancelled, lease cleared, a paused attempt record closed
// cancelled) and leaves them unacknowledged, so the controller acks them as it acks any cancelled run. Additive: it
// only updates rows; a second run finds nothing left to change.

import { defineMigration } from "../../state/index.js";

/** The database's time, in the ISO form the store writes (migrations read no clock). */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const STALE = `status = 'queued' AND work_item_id IN (SELECT id FROM controller_work_items WHERE stage = 'CLOSED')`;

export default defineMigration({
  change: "additive",
  tables: ["worker_runs", "worker_run_attempts"],
  async up(db) {
    await db.run(
      `UPDATE worker_run_attempts SET status = 'cancelled', finished_at = COALESCE(finished_at, ${NOW})
       WHERE status = 'paused' AND run_id IN (SELECT id FROM worker_runs WHERE ${STALE})`,
    );
    await db.run(`UPDATE worker_runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ${NOW} WHERE ${STALE}`);
  },
});
