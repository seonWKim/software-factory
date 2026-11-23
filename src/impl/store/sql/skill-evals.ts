// Skill evals: the SkillEvalStore methods over `controller_skill_eval_*`, as SqlSkillEvalStore, which SqlFactoryStore
// extends. Each method is one transaction; times come from the store's injected Clock. A duplicate key is "already
// there": the stored row is returned.

import type { SkillEvalCase, SkillEvalReplay, SkillEvalRun, SkillEvalRunStatus, SkillEvalStore, SkillEvalSuite } from "../../../interfaces/skill-eval-store.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { SqlScheduleStore } from "./schedules.js";

const SUITE_COLUMNS = "id, skill_ref, title, created_by, created_at";
const CASE_COLUMNS = "id, suite_id, input, expected, created_at";
const RUN_COLUMNS = "id, suite_id, status, started_at, finished_at, created_by, skill_version";
const REPLAY_COLUMNS = "run_id, case_id, verdict, detail, recorded_at";

const ts = (v: unknown) => String(v) as Timestamp;

const rowToSuite = (r: Row): SkillEvalSuite => ({ id: String(r.id), skill_ref: String(r.skill_ref), title: String(r.title), created_by: String(r.created_by) as UserId, created_at: ts(r.created_at) });
const rowToCase = (r: Row): SkillEvalCase => ({ id: String(r.id), suite_id: String(r.suite_id), input: JSON.parse(String(r.input)), expected: JSON.parse(String(r.expected)), created_at: ts(r.created_at) });
const rowToRun = (r: Row): SkillEvalRun => ({
  id: String(r.id), suite_id: String(r.suite_id), status: String(r.status) as SkillEvalRunStatus, started_at: ts(r.started_at),
  finished_at: r.finished_at == null ? null : ts(r.finished_at), created_by: String(r.created_by) as UserId,
  skill_version: r.skill_version == null ? null : String(r.skill_version),
});
const rowToReplay = (r: Row): SkillEvalReplay => ({ run_id: String(r.run_id), case_id: String(r.case_id), verdict: String(r.verdict), detail: JSON.parse(String(r.detail)), recorded_at: ts(r.recorded_at) });

/** SkillEvalStore over a SqlDriver; `evalStamp` is the store's injected Clock's time. */
export class SqlSkillEvalStore extends SqlScheduleStore implements SkillEvalStore {
  constructor(db: SqlDriver, private readonly evalStamp: () => Timestamp) {
    super(db, evalStamp);
  }

  createSkillEvalSuite(s: Omit<SkillEvalSuite, "created_at">): Promise<SkillEvalSuite> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_suites (${SUITE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [s.id, s.skill_ref, s.title, s.created_by, this.evalStamp()]);
      const [row] = await tx.all(`SELECT ${SUITE_COLUMNS} FROM controller_skill_eval_suites WHERE id = ?`, [s.id]);
      return rowToSuite(row!);
    });
  }

  async listSkillEvalSuites(): Promise<SkillEvalSuite[]> {
    return (await this.db.all(`SELECT ${SUITE_COLUMNS} FROM controller_skill_eval_suites ORDER BY created_at, id`)).map(rowToSuite);
  }

  addSkillEvalCase(c: Omit<SkillEvalCase, "created_at">): Promise<SkillEvalCase> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_cases (${CASE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [c.id, c.suite_id, JSON.stringify(c.input), JSON.stringify(c.expected), this.evalStamp()]);
      const [row] = await tx.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE id = ?`, [c.id]);
      return rowToCase(row!);
    });
  }

  async listSkillEvalCases(suite_id: string): Promise<SkillEvalCase[]> {
    return (await this.db.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE suite_id = ? ORDER BY created_at, id`, [suite_id])).map(rowToCase);
  }

  startSkillEvalRun(r: Pick<SkillEvalRun, "id" | "suite_id" | "created_by"> & { skill_version?: string | null }): Promise<SkillEvalRun> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_runs (${RUN_COLUMNS}) VALUES (?, ?, 'running', ?, NULL, ?, ?)`, [r.id, r.suite_id, this.evalStamp(), r.created_by, r.skill_version ?? null]);
      const [row] = await tx.all(`SELECT ${RUN_COLUMNS} FROM controller_skill_eval_runs WHERE id = ?`, [r.id]);
      return rowToRun(row!);
    });
  }

  finishSkillEvalRun(id: string, status: Exclude<SkillEvalRunStatus, "running">): Promise<boolean> {
    return this.db.transaction(async (tx) => (await tx.run("UPDATE controller_skill_eval_runs SET status = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL", [status, this.evalStamp(), id])) === 1);
  }

  recordSkillEvalReplay(r: Omit<SkillEvalReplay, "recorded_at">): Promise<SkillEvalReplay> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_replays (${REPLAY_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [r.run_id, r.case_id, r.verdict, JSON.stringify(r.detail), this.evalStamp()]);
      const [row] = await tx.all(`SELECT ${REPLAY_COLUMNS} FROM controller_skill_eval_replays WHERE run_id = ? AND case_id = ?`, [r.run_id, r.case_id]);
      return rowToReplay(row!);
    });
  }

  async listSkillEvalReplays(run_id: string): Promise<SkillEvalReplay[]> {
    return (await this.db.all(`SELECT ${REPLAY_COLUMNS} FROM controller_skill_eval_replays WHERE run_id = ? ORDER BY recorded_at, case_id`, [run_id])).map(rowToReplay);
  }
}
