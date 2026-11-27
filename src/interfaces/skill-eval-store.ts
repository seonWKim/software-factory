// Skill evals: the store's methods over `controller_skill_eval_suites`, `_cases`, `_runs` and `_replays`. A suite
// belongs to one skill; a run replays each of a suite's cases N times and records one verdict per replay. JSON values (`input`,
// `expected`, `detail`) are stored as text and read back as the values written. The skill-eval engine
// (src/runtime/skill-evals/) calls them; the eval wiring (src/skill-evals.ts) records a finished run's figures, and
// `factory eval results` and GET /api/v1/evals/<skill>/runs list a skill's runs; `factory eval compare` and
// GET /api/v1/evals/<skill>/compare read runs by id. Skill versions are rows of `ext_skill_versions`: the plugin import
// (src/import/import-plugins.ts) records one each time an imported skill's folder hash changes, with its gate row
// (`controller_skill_version_gates`, design 07-self-improvement) in the same transaction.

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
  /**
   * The case's seed folder, copied into its replay's clean sandbox, and the approved MCP servers its replay gets, by
   * name (design 06-measurement, clean replays). Read back only when set; absent or null: none.
   */
  seed?: string | null;
  mcp?: readonly string[] | null;
  /**
   * `dev` (a draft is tuned and measured on it) or `held-out` (only the promotion check replays it), design
   * 07-self-improvement; a case added with none is `dev`. `eval run` replays every case whatever its split.
   */
  split: SkillEvalSplit;
  created_at: Timestamp;
}

export const SKILL_EVAL_SPLITS = ["dev", "held-out"] as const;
export type SkillEvalSplit = (typeof SKILL_EVAL_SPLITS)[number];

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
  /**
   * What the run was measured against, written when it starts; each null on a run stored before them (no backfill).
   * suite_version: its suite's version then (one more on each case add, edit or delete); judge_version: the SHA-256 of
   * the judge's prompt; factory_version: the factory revision that ran it (`dev` unsupervised).
   */
  suite_version: number | null;
  judge_version: string | null;
  factory_version: string | null;
  /** The figures (SkillEvalRunFigures) once recorded; each null on a run stored before them or not recorded yet. */
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/** A run as it starts: which suite, who started it, and the versions it runs on (each absent: null). */
export type SkillEvalRunStart = Pick<SkillEvalRun, "id" | "suite_id" | "created_by"> & Partial<Pick<SkillEvalRun, "skill_version" | "judge_version" | "factory_version">>;

/** A finished run's figures, written once after the engine finishes. */
export interface SkillEvalRunFigures {
  /** The model class the replays ran on. */
  model_class: string;
  /** The judge's class: judgeClass of `model_class` (src/core/scorer.ts). */
  judge_model_class: string;
  /** Replays made: cases × N (`eval run --replays N`). */
  replays: number;
  /** Pass verdicts ÷ replays (pass@1); null when replays is 0. */
  pass_rate: number | null;
  /** Replays with an `errored` verdict. */
  errored: number;
}

export interface SkillEvalReplay {
  run_id: string;
  case_id: string;
  /** The replay's number in its run, 1 to N; null (or absent when written) on a replay stored before it (no backfill). */
  replay?: number | null;
  verdict: string;
  detail: unknown;
  /**
   * What the replay's agent run gave (design 06-measurement, clean replays): its transcript and final answer (each
   * null when the egress scan flagged it, the rule names then in `detail.withheld`), its tokens, its cost (null when
   * the runner reports none) and its wall time. Written absent: null; null on a replay stored before them (no backfill).
   */
  transcript?: string | null;
  answer?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  wall_ms?: number | null;
  recorded_at: Timestamp;
}

/** The owner's verdict on the judge's answer to one check: `right` (the owner agrees) or `wrong`. */
export type SkillEvalLabelVerdict = "right" | "wrong";

/**
 * The owner's label on one judged check (design 06-measurement, judge labels): a row of `controller_skill_eval_labels`,
 * one per run, case, replay number and check.
 */
export interface SkillEvalLabel {
  run_id: string;
  case_id: string;
  /** The replay's number in its run; 0 for a replay stored with none. */
  replay: number;
  /** The check's text, as the judge's answer names it (`detail.answers[].check`). */
  check: string;
  verdict: SkillEvalLabelVerdict;
  /** The owner's user ID, never a display name. */
  owner_id: UserId;
  created_at: Timestamp;
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

/** A new version's gate: pending until a gate pass takes it, running under a lease, then passed or held; a held one is passed or rejected by the owner. */
export type SkillVersionGateState = "pending" | "running" | "passed" | "held" | "rejected";

/** The gate row of one skill version (design 07-self-improvement); a version recorded before the gate has none. */
export interface SkillVersionGate {
  ref_id: string;
  version: number;
  state: SkillVersionGateState;
  /** The holder's token and its lease end while running; null otherwise. */
  lease_token: string | null;
  lease_until: Timestamp | null;
  /** The gate's eval run; null before it ran or when it ran none. */
  run_id: string | null;
  /** JSON: the reason, the pass rates compared and the cases whose pass rate fell. */
  detail: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A take of a gate: the holder's new token, the take's time (the gate pass's Clock) and its lease end. */
export interface SkillVersionGateTake {
  ref_id: string;
  version: number;
  lease_token: string;
  now: Timestamp;
  lease_until: Timestamp;
}

/** A gate's end as its holder writes it: passed, held, or pending again (its run gave no pass rate). */
export interface SkillVersionGateFinish {
  ref_id: string;
  version: number;
  lease_token: string;
  state: "passed" | "held" | "pending";
  run_id: string | null;
  detail: unknown;
}

export interface SkillEvalStore {
  /** Idempotent on the id: a second call returns the stored suite. */
  createSkillEvalSuite(s: Omit<SkillEvalSuite, "created_at">): Promise<SkillEvalSuite>;
  listSkillEvalSuites(): Promise<SkillEvalSuite[]>;
  /**
   * Idempotent on the id, with its seed, MCP servers and split when given (no split: `dev`). A new case gives its suite
   * the next version, in the same transaction.
   */
  addSkillEvalCase(c: Omit<SkillEvalCase, "created_at" | "split"> & { split?: SkillEvalSplit }): Promise<SkillEvalCase>;
  listSkillEvalCases(suite_id: string): Promise<SkillEvalCase[]>;
  /** Sets a suite's title; null when the suite is unknown. */
  updateSkillEvalSuiteTitle(id: string, title: string): Promise<SkillEvalSuite | null>;
  /**
   * Deletes the suite and its cases in one transaction. Refuses (`running`, nothing deleted) while one of the suite's
   * runs is running, checked inside that transaction. Its runs and replays stay in the store, unlisted.
   */
  deleteSkillEvalSuite(id: string): Promise<"deleted" | "running" | "unknown">;
  getSkillEvalCase(id: string): Promise<SkillEvalCase | null>;
  /** Sets a case's input and expected, and gives its suite the next version; null when the case is unknown. */
  updateSkillEvalCase(id: string, c: Pick<SkillEvalCase, "input" | "expected">): Promise<SkillEvalCase | null>;
  /** Sets a case's split, bumping no suite version; null when the case is unknown. */
  setSkillEvalCaseSplit(id: string, split: SkillEvalSplit): Promise<SkillEvalCase | null>;
  /** Deletes the case and gives its suite the next version; false when the case is unknown. */
  deleteSkillEvalCase(id: string): Promise<boolean>;
  /**
   * Idempotent on the id: starts the run as `running`, with its suite's version as it is now, and its skill, judge and
   * factory versions (each absent: null).
   */
  startSkillEvalRun(r: SkillEvalRunStart): Promise<SkillEvalRun>;
  /** Sets the final status once; false when the run is unknown or already finished. */
  finishSkillEvalRun(id: string, status: Exclude<SkillEvalRunStatus, "running">): Promise<boolean>;
  /**
   * One verdict per run, case and replay number (none counts as 0), with what its replay gave; a second record for the
   * same three keeps the first.
   */
  recordSkillEvalReplay(r: Omit<SkillEvalReplay, "recorded_at">): Promise<SkillEvalReplay>;
  listSkillEvalReplays(run_id: string): Promise<SkillEvalReplay[]>;
  /** The owner's label on one judged check; a second label on the same run, case, replay and check keeps the first, which is returned. */
  recordSkillEvalLabel(l: Omit<SkillEvalLabel, "created_at">): Promise<SkillEvalLabel>;
  /** The labels on the runs of every suite of `skill_ref`, oldest first. */
  listSkillEvalLabels(skill_ref: string): Promise<SkillEvalLabel[]>;
  /** The runs of every suite of `skill_ref`, newest first (start time, then id). */
  listSkillEvalRuns(skill_ref: string): Promise<SkillEvalRun[]>;
  /** One run by id with its figures (as listSkillEvalRuns reads it), whatever its skill; null for an unknown id. */
  getSkillEvalRun(id: string): Promise<SkillEvalRun | null>;
  /** Writes a finished run's figures once; false when the run is unknown, still running or already has them. */
  recordSkillEvalRunFigures(id: string, f: SkillEvalRunFigures): Promise<boolean>;
  /**
   * Writes the ref's next version with its gate row in `pending`, in one transaction, when `folder_hash` differs from
   * its latest version's (none: version 1). Null when the hash is unchanged, or when another worker wrote that version
   * first (the unique key).
   */
  recordSkillVersion(v: Omit<SkillVersion, "version" | "created_at">): Promise<SkillVersion | null>;
  /** A ref's versions, oldest first. */
  listSkillVersions(ref_id: string): Promise<SkillVersion[]>;
  /**
   * The ref's current version: its newest version (below `before` when given) whose gate is passed or that has no gate
   * row; a pending, running, held or rejected version is not current. Null when there is none.
   */
  currentSkillVersion(ref_id: string, before?: number): Promise<SkillVersion | null>;
  /** The gates a pass may take at `now`: pending, or running with its lease ended; oldest first (ref, then version). */
  listDueSkillVersionGates(now: Timestamp): Promise<SkillVersionGate[]>;
  /**
   * Takes a gate by one conditional update: running, with the new token and lease end, only while it is pending or
   * running with its lease ended at `now`. False when another holder has it or it is finished.
   */
  takeSkillVersionGate(t: SkillVersionGateTake): Promise<boolean>;
  /** Writes a gate's end only while it is running under `lease_token`; false (nothing written) for a late holder. */
  finishSkillVersionGate(f: SkillVersionGateFinish): Promise<boolean>;
  getSkillVersionGate(ref_id: string, version: number): Promise<SkillVersionGate | null>;
  /** The held gates of every ref, newest first (created, then version), at most `limit`. */
  listHeldSkillVersionGates(limit: number): Promise<SkillVersionGate[]>;
  /**
   * The owner's settle of a held gate by one conditional update: `passed` (it may become current) or `rejected` (it never
   * does), with `by` (a user ID) in its detail, only while it is held. False when it is not held (settled already, or never held).
   */
  settleSkillVersionGate(ref_id: string, version: number, state: "passed" | "rejected", by: UserId): Promise<boolean>;
}
