// Skill evals: `controller_skill_eval_suites` (one per skill), `_cases` (a suite's input and expected output),
// `_runs` (one replay of a suite) and `_replays` (one verdict per run and case). JSON values are text. Additive: four
// new tables and indexes, no backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_skill_eval_suites", "controller_skill_eval_cases", "controller_skill_eval_runs", "controller_skill_eval_replays"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_eval_suites (
    id          TEXT PRIMARY KEY,
    skill_ref   TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_skill_eval_suites_skill ON controller_skill_eval_suites (skill_ref)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_eval_cases (
    id          TEXT PRIMARY KEY,
    suite_id    TEXT NOT NULL,
    input       TEXT NOT NULL,
    expected    TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_skill_eval_cases_suite ON controller_skill_eval_cases (suite_id)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_eval_runs (
    id           TEXT PRIMARY KEY,
    suite_id     TEXT NOT NULL,
    status       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    created_by   TEXT NOT NULL
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_skill_eval_runs_suite ON controller_skill_eval_runs (suite_id)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_skill_eval_replays (
    run_id       TEXT NOT NULL,
    case_id      TEXT NOT NULL,
    verdict      TEXT NOT NULL,
    detail       TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id)
  )`);
  },
});
