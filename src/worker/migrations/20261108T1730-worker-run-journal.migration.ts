// RFC 0015 M6: the step journal of the `journal` ExecutionEngine (§6.2, §7 Workers). Additive: old code never
// reads the new table or columns.
// - worker_run_steps: one row per (run, step); a succeeded step's stored result is returned instead of running
//   the step again, so a resumed run skips finished steps.
// - worker_runs.code_version: the revision that runs the run; a resume on other code is detected (§8).
// - worker_runs.deadline_at: created_at + the run kind's schedule_to_close; the reaper fails runs past it.
// - worker_runs_lease: the reaper's scan of running runs by lease expiry.
// passport_id (also new on worker_runs in the target schema) comes with the passports (M9).
//
// MySQL DDL is not transactional, so every statement is skipped when its object already exists: a rerun after
// a crash halfway finishes the rest.

import { defineMigration, tableExists, type MigrationDb } from "../../state/index.js";

const STEPS: Record<MigrationDb["dialect"], string> = {
  sqlite: `CREATE TABLE worker_run_steps (
    run_id       TEXT NOT NULL REFERENCES worker_runs(id),
    step_id      TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    status       TEXT NOT NULL,
    result_ref   TEXT,
    error_code   TEXT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    PRIMARY KEY (run_id, step_id)
  )`,
  mysql: `CREATE TABLE worker_run_steps (
    run_id       VARCHAR(64) NOT NULL,
    step_id      VARCHAR(64) NOT NULL,
    attempt      INT NOT NULL,
    status       VARCHAR(16) NOT NULL,
    result_ref   MEDIUMTEXT,
    error_code   VARCHAR(64),
    started_at   CHAR(24) NOT NULL,
    finished_at  CHAR(24),
    PRIMARY KEY (run_id, step_id),
    CONSTRAINT worker_run_steps_run FOREIGN KEY (run_id) REFERENCES worker_runs (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
};

const COLUMNS: readonly { name: string; sqlite: string; mysql: string }[] = [
  { name: "code_version", sqlite: "TEXT", mysql: "VARCHAR(64)" },
  { name: "deadline_at", sqlite: "TEXT", mysql: "CHAR(24)" },
];

async function hasColumn(db: MigrationDb, table: string, column: string): Promise<boolean> {
  const rows =
    db.dialect === "sqlite"
      ? await db.all(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = ?`, [column])
      : await db.all("SELECT 1 AS x FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?", [table, column]);
  return rows.length > 0;
}

async function hasIndex(db: MigrationDb, table: string, index: string): Promise<boolean> {
  const rows =
    db.dialect === "sqlite"
      ? await db.all("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?", [table, index])
      : await db.all("SELECT 1 AS x FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?", [table, index]);
  return rows.length > 0;
}

export default defineMigration({
  change: "additive",
  tables: ["worker_runs"],
  async up(db) {
    for (const c of COLUMNS) {
      if (!(await hasColumn(db, "worker_runs", c.name))) await db.run(`ALTER TABLE worker_runs ADD COLUMN ${c.name} ${c[db.dialect]}`);
    }
    if (!(await hasIndex(db, "worker_runs", "worker_runs_lease"))) {
      await db.run("CREATE INDEX worker_runs_lease ON worker_runs (status, lease_expires_at)");
    }
    if (!(await tableExists(db, "worker_run_steps"))) await db.run(STEPS[db.dialect]);
  },
});
