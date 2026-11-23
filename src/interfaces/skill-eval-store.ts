// Skill evals: the store's methods over `controller_skill_eval_suites`, `_cases`, `_runs` and `_replays`. A suite
// belongs to one skill; a run replays a suite's cases and records one verdict per case. JSON values (`input`,
// `expected`, `detail`) are stored as text and read back as the values written. The skill-eval engine
// (src/runtime/skill-evals/) calls them.

import type { Timestamp, UserId } from "../core/types.js";

export interface SkillEvalSuite {
  id: string;
  skill_ref: string;
  title: string;
  /** A user or agent ID, never a display name. */
  created_by: UserId;
  created_at: Timestamp;
}

export interface SkillEvalCase {
  id: string;
  suite_id: string;
  input: unknown;
  expected: unknown;
  created_at: Timestamp;
}

export type SkillEvalRunStatus = "running" | "passed" | "failed" | "errored";

export interface SkillEvalRun {
  id: string;
  suite_id: string;
  status: SkillEvalRunStatus;
  started_at: Timestamp;
  /** Null while the run is going. */
  finished_at: Timestamp | null;
  created_by: UserId;
  /** The SHA-256 of the skill folder the run replayed (capabilities skillVersion); null on a run stored before it. */
  skill_version: string | null;
}

export interface SkillEvalReplay {
  run_id: string;
  case_id: string;
  verdict: string;
  detail: unknown;
  recorded_at: Timestamp;
}

export interface SkillEvalStore {
  /** Idempotent on the id: a second call returns the stored suite. */
  createSkillEvalSuite(s: Omit<SkillEvalSuite, "created_at">): Promise<SkillEvalSuite>;
  listSkillEvalSuites(): Promise<SkillEvalSuite[]>;
  /** Idempotent on the id. */
  addSkillEvalCase(c: Omit<SkillEvalCase, "created_at">): Promise<SkillEvalCase>;
  listSkillEvalCases(suite_id: string): Promise<SkillEvalCase[]>;
  /** Idempotent on the id: starts the run as `running`, with its skill version (absent: null). */
  startSkillEvalRun(r: Pick<SkillEvalRun, "id" | "suite_id" | "created_by"> & { skill_version?: string | null }): Promise<SkillEvalRun>;
  /** Sets the final status once; false when the run is unknown or already finished. */
  finishSkillEvalRun(id: string, status: Exclude<SkillEvalRunStatus, "running">): Promise<boolean>;
  /** One verdict per run and case; a second record for the pair keeps the first. */
  recordSkillEvalReplay(r: Omit<SkillEvalReplay, "recorded_at">): Promise<SkillEvalReplay>;
  listSkillEvalReplays(run_id: string): Promise<SkillEvalReplay[]>;
}
