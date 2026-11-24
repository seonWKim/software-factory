// Skill evals: the store's methods over `controller_skill_eval_suites`, `_cases`, `_runs` and `_replays`. A suite
// belongs to one skill; a run replays a suite's cases and records one verdict per case. JSON values (`input`,
// `expected`, `detail`) are stored as text and read back as the values written. The skill-eval engine
// (src/runtime/skill-evals/) calls them; the eval wiring (src/skill-evals.ts) records a finished run's figures, and
// `factory eval results` and GET /api/v1/evals/<skill>/runs list a skill's runs; `factory eval compare` and
// GET /api/v1/evals/<skill>/compare read runs by id. Skill versions are rows of `ext_skill_versions`: the plugin import
// (src/import/import-plugins.ts) records one each time an imported skill's folder hash changes.

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
  /** The figures (SkillEvalRunFigures) once recorded; each null on a run stored before them or not recorded yet. */
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/** A finished run's figures, written once after the engine finishes. */
export interface SkillEvalRunFigures {
  /** The model class the replays ran on. */
  model_class: string;
  /** The judge's class: judgeClass of `model_class` (src/core/scorer.ts). */
  judge_model_class: string;
  /** Case replays made: one per case. */
  replays: number;
  /** Pass verdicts ÷ replays; null when replays is 0. */
  pass_rate: number | null;
  /** Cases with an `errored` verdict. */
  errored: number;
}

export interface SkillEvalReplay {
  run_id: string;
  case_id: string;
  verdict: string;
  detail: unknown;
  recorded_at: Timestamp;
}

/** One version of an imported skill (an `ext_skill_refs` row of kind `skill`), as an import saw it. */
export interface SkillVersion {
  /** The `ext_skill_refs` id. */
  ref_id: string;
  /** 1 for the first import, then one more per changed folder hash. */
  version: number;
  /** The skill folder's version (capabilities skillVersion), as eval runs store it. */
  folder_hash: string;
  /** The full SKILL.md text. */
  text: string;
  /** The ref's source label, such as `claude`. */
  source: string;
  created_at: Timestamp;
}

export interface SkillEvalStore {
  /** Idempotent on the id: a second call returns the stored suite. */
  createSkillEvalSuite(s: Omit<SkillEvalSuite, "created_at">): Promise<SkillEvalSuite>;
  listSkillEvalSuites(): Promise<SkillEvalSuite[]>;
  /** Idempotent on the id. */
  addSkillEvalCase(c: Omit<SkillEvalCase, "created_at">): Promise<SkillEvalCase>;
  listSkillEvalCases(suite_id: string): Promise<SkillEvalCase[]>;
  /** Sets a suite's title; null when the suite is unknown. */
  updateSkillEvalSuiteTitle(id: string, title: string): Promise<SkillEvalSuite | null>;
  /**
   * Deletes the suite and its cases in one transaction. Refuses (`running`, nothing deleted) while one of the suite's
   * runs is running, checked inside that transaction. Its runs and replays stay in the store, unlisted.
   */
  deleteSkillEvalSuite(id: string): Promise<"deleted" | "running" | "unknown">;
  getSkillEvalCase(id: string): Promise<SkillEvalCase | null>;
  /** Sets a case's input and expected; null when the case is unknown. */
  updateSkillEvalCase(id: string, c: Pick<SkillEvalCase, "input" | "expected">): Promise<SkillEvalCase | null>;
  /** False when the case is unknown. */
  deleteSkillEvalCase(id: string): Promise<boolean>;
  /** Idempotent on the id: starts the run as `running`, with its skill version (absent: null). */
  startSkillEvalRun(r: Pick<SkillEvalRun, "id" | "suite_id" | "created_by"> & { skill_version?: string | null }): Promise<SkillEvalRun>;
  /** Sets the final status once; false when the run is unknown or already finished. */
  finishSkillEvalRun(id: string, status: Exclude<SkillEvalRunStatus, "running">): Promise<boolean>;
  /** One verdict per run and case; a second record for the pair keeps the first. */
  recordSkillEvalReplay(r: Omit<SkillEvalReplay, "recorded_at">): Promise<SkillEvalReplay>;
  listSkillEvalReplays(run_id: string): Promise<SkillEvalReplay[]>;
  /** The runs of every suite of `skill_ref`, newest first (start time, then id). */
  listSkillEvalRuns(skill_ref: string): Promise<SkillEvalRun[]>;
  /** One run by id with its figures (as listSkillEvalRuns reads it), whatever its skill; null for an unknown id. */
  getSkillEvalRun(id: string): Promise<SkillEvalRun | null>;
  /** Writes a finished run's figures once; false when the run is unknown, still running or already has them. */
  recordSkillEvalRunFigures(id: string, f: SkillEvalRunFigures): Promise<boolean>;
  /**
   * Writes the ref's next version, in one transaction, when `folder_hash` differs from its latest version's (none:
   * version 1). Null when the hash is unchanged, or when another worker wrote that version first (the unique key).
   */
  recordSkillVersion(v: Omit<SkillVersion, "version" | "created_at">): Promise<SkillVersion | null>;
  /** A ref's versions, oldest first. */
  listSkillVersions(ref_id: string): Promise<SkillVersion[]>;
}
