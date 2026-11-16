// One-off repair: a finished run (worker_runs.status succeeded, failed or cancelled) whose latest attempt record
// in worker_run_attempts says something else, e.g. a run that succeeded while its latest attempt still says
// paused. Sets that record's status to the run's, and its finished_at to the run's when it had none. Additive: it
// only updates rows and creates no table or column; a second run finds nothing left to change. doctor's
// run/attempt check reports the same mismatch (run-attempt-status.ts holds the one predicate for both).

import { defineMigration } from "../../state/index.js";
import { mismatch } from "./run-attempt-status.js";

export default defineMigration({
  change: "additive",
  tables: ["worker_run_attempts"],
  async up(db) {
    await db.run(
      `UPDATE worker_run_attempts
       SET status = (SELECT r.status FROM worker_runs r WHERE r.id = worker_run_attempts.run_id),
           finished_at = COALESCE(finished_at, (SELECT COALESCE(r.finished_at, r.updated_at) FROM worker_runs r WHERE r.id = worker_run_attempts.run_id))
       WHERE EXISTS (SELECT 1 FROM worker_runs r WHERE r.id = worker_run_attempts.run_id AND ${mismatch("worker_run_attempts", "r")})`,
    );
  },
});
