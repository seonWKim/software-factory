// Grid and compare over stored skill-eval runs (design 06-measurement), pure: `factory eval results <skill> --by
// version,model`, `factory eval compare` and GET /api/v1/evals/<skill>/grid and /compare all use these, so the
// grouping and the noise rule live once. Nothing here reads or writes the store. Main.ts passes them to the CLI
// through the command call (CommandCall.skillEvalReads); the routes import them.

import type { SkillEvalRun } from "../interfaces/skill-eval-store.js";

/** One run as the grid and compare show it: which run, on what, and its figures (null where none was recorded). */
export interface SkillEvalRunSummary {
  run_id: string;
  started_at: string;
  status: string;
  skill_version: string | null;
  suite_version: number | null;
  judge_version: string | null;
  factory_version: string | null;
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/**
 * Two runs side by side: b − a, the noise band and whether the gap is inside it. Not comparable (with the reason, and
 * the three null) when they ran on different suite or judge versions, or one has none recorded; the three are also
 * null without two pass rates.
 */
export interface SkillEvalComparison {
  a: SkillEvalRunSummary;
  b: SkillEvalRunSummary;
  comparable: boolean;
  /** Why the runs are not comparable; null when they are. */
  reason: string | null;
  gap: number | null;
  noise_band: number | null;
  within_noise: boolean | null;
}

const summary = (r: SkillEvalRun): SkillEvalRunSummary => ({
  run_id: r.id, started_at: r.started_at, status: r.status, skill_version: r.skill_version, suite_version: r.suite_version,
  judge_version: r.judge_version, factory_version: r.factory_version, model_class: r.model_class,
  judge_model_class: r.judge_model_class, replays: r.replays, pass_rate: r.pass_rate, errored: r.errored,
});

const newestFirst = (x: SkillEvalRun, y: SkillEvalRun) => (x.started_at === y.started_at ? (x.id < y.id ? 1 : -1) : x.started_at < y.started_at ? 1 : -1);

/**
 * One row per (skill version, model class): its newest run (start time, then id), newest row first. A run with no
 * recorded figures has no model class and is left out; nothing is backfilled.
 */
export function skillEvalGrid(runs: readonly SkillEvalRun[]): SkillEvalRunSummary[] {
  const seen = new Set<string>();
  const rows: SkillEvalRunSummary[] = [];
  for (const r of [...runs].sort(newestFirst)) {
    if (r.model_class === null) continue;
    const key = JSON.stringify([r.skill_version, r.model_class]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(summary(r));
  }
  return rows;
}

/** A pass rate over its replays, or null when either is missing or there were none. */
type Measured = Pick<SkillEvalRun, "pass_rate" | "replays">;
const measured = (r: Measured): r is { pass_rate: number; replays: number } => r.pass_rate !== null && r.replays !== null && r.replays > 0;

/** The noise rule's band: 2 × sqrt(sd_a² + sd_b²), with sd = sqrt(p × (1 − p) ÷ replays). */
export function noiseBand(a: { pass_rate: number; replays: number }, b: { pass_rate: number; replays: number }): number {
  const variance = (r: { pass_rate: number; replays: number }) => (r.pass_rate * (1 - r.pass_rate)) / r.replays;
  return 2 * Math.sqrt(variance(a) + variance(b));
}

type Versioned = Pick<SkillEvalRun, "suite_id" | "suite_version" | "judge_version">;

/** Why two runs cannot be set side by side, or null when they can: the same suite and suite version, the same judge version. */
export function notComparableReason(a: Versioned, b: Versioned): string | null {
  if ([a, b].some((r) => r.suite_version === null || r.judge_version === null)) return "one run has no version recorded";
  if (a.suite_id !== b.suite_id || a.suite_version !== b.suite_version) return "the suite versions differ";
  if (a.judge_version !== b.judge_version) return "the judge versions differ";
  return null;
}

/**
 * Compares run b against run a: within noise when |b − a| is no more than the noise band. Runs notComparableReason
 * names get no gap, noise band or within-noise figure.
 */
export function compareSkillEvalRuns(a: SkillEvalRun, b: SkillEvalRun): SkillEvalComparison {
  const reason = notComparableReason(a, b);
  const none = { gap: null, noise_band: null, within_noise: null };
  if (reason !== null) return { a: summary(a), b: summary(b), comparable: false, reason, ...none };
  if (!measured(a) || !measured(b)) return { a: summary(a), b: summary(b), comparable: true, reason: null, ...none };
  const gap = b.pass_rate - a.pass_rate;
  const noise_band = noiseBand(a, b);
  return { a: summary(a), b: summary(b), comparable: true, reason: null, gap, noise_band, within_noise: Math.abs(gap) <= noise_band };
}
