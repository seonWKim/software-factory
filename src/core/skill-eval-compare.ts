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
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/** Two runs side by side: b − a, the noise band and whether the gap is inside it; all three null without two pass rates. */
export interface SkillEvalComparison {
  a: SkillEvalRunSummary;
  b: SkillEvalRunSummary;
  gap: number | null;
  noise_band: number | null;
  within_noise: boolean | null;
}

const summary = (r: SkillEvalRun): SkillEvalRunSummary => ({
  run_id: r.id, started_at: r.started_at, status: r.status, skill_version: r.skill_version, model_class: r.model_class,
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

/** Compares run b against run a: within noise when |b − a| is no more than the noise band. */
export function compareSkillEvalRuns(a: SkillEvalRun, b: SkillEvalRun): SkillEvalComparison {
  if (!measured(a) || !measured(b)) return { a: summary(a), b: summary(b), gap: null, noise_band: null, within_noise: null };
  const gap = b.pass_rate - a.pass_rate;
  const noise_band = noiseBand(a, b);
  return { a: summary(a), b: summary(b), gap, noise_band, within_noise: Math.abs(gap) <= noise_band };
}
