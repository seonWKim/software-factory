// RFC 0015 M6: the step journal of the `journal` ExecutionEngine (§6.2, §7 Workers). Additive: old code never
// reads the new table or columns.
// - worker_run_steps: one row per (run, step); a succeeded step's stored result is returned instead of running
//   the step again, so a resumed run skips finished steps.
// - worker_runs.code_version: the revision that runs the run; a resume on other code is detected (§8).
// - worker_runs.deadline_at: created_at + the run kind's schedule_to_close. The worker enforces it: its heartbeat
//   aborts a run past it, and the engine refuses its next step (design 10-event-driven; the reaper never reads it).
// - worker_runs_lease: the reaper's scan of running runs by lease expiry.
// passport_id (also new on worker_runs in the target schema) comes with the passports (M9).
//
// Every statement is skipped when its object already exists, so a rerun finishes the rest.

import { defineMigration, tableExists, type MigrationDb } from "../../state/index.js";

const STEPS = `CREATE TABLE worker_run_steps (
    run_id       TEXT NOT NULL REFERENCES worker_runs(id),
    step_id      TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    status       TEXT NOT NULL,
    result_ref   TEXT,
    error_code   TEXT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    PRIMARY KEY (run_id, step_id)
  )`;

const COLUMNS = ["code_version", "deadline_at"];

async function hasColumn(db: MigrationDb, table: string, column: string): Promise<boolean> {
  const rows = await db.all(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = ?`, [column]);
  return rows.length > 0;
}

async function hasIndex(db: MigrationDb, table: string, index: string): Promise<boolean> {
  const rows = await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?", [table, index]);
  return rows.length > 0;
}

export default defineMigration({
  change: "additive",
  tables: ["worker_runs"],
  async up(db) {
    for (const name of COLUMNS) {
      if (!(await hasColumn(db, "worker_runs", name))) await db.run(`ALTER TABLE worker_runs ADD COLUMN ${name} TEXT`);
    }
    if (!(await hasIndex(db, "worker_runs", "worker_runs_lease"))) {
      await db.run("CREATE INDEX worker_runs_lease ON worker_runs (status, lease_expires_at)");
    }
    if (!(await tableExists(db, "worker_run_steps"))) await db.run(STEPS);
  },
});
