// Grid and compare over stored skill-eval runs (design 06-measurement), pure: `factory eval results <skill> --by
// version,model`, `factory eval compare` and GET /api/v1/evals/<skill>/grid and /compare all use these, so the
// grouping and the noise rule live once. The per-version read and the version diff (GET /api/v1/evals/<skill>/versions
// and /diff) link runs to skill versions by folder hash here too. Nothing here reads or writes the store. Main.ts passes them to the CLI
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

const newestFirst = (x: Pick<SkillEvalRun, "id" | "started_at">, y: Pick<SkillEvalRun, "id" | "started_at">) => (x.started_at === y.started_at ? (x.id < y.id ? 1 : -1) : x.started_at < y.started_at ? 1 : -1);

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

/** One skill version as the per-version read takes it (an `ext_skill_versions` row; the text is not needed). */
export interface VersionOf {
  version: number;
  folder_hash: string;
  created_at: string;
}

/** A run as the per-version read links it: by its stored folder hash. */
type LinkedRun = Pick<SkillEvalRun, "id" | "started_at" | "skill_version" | "pass_rate">;

/** One version with its latest linked run's pass rate, the change since the previous version and the current mark. */
export interface SkillVersionRow extends VersionOf {
  /** The newest version is the current one. */
  current: boolean;
  /** The newest run with a pass rate whose skill_version is this version's folder hash; null when none. */
  run_id: string | null;
  pass_rate: number | null;
  /** pass_rate − the previous version's; null when either has none or this is the first version. */
  change: number | null;
}

/** The newest run (start time, then id) with a pass rate whose stored hash is `folder_hash`; undefined when none. */
export function latestLinkedRun<R extends LinkedRun>(runs: readonly R[], folder_hash: string): R | undefined {
  return [...runs].sort(newestFirst).find((r) => r.skill_version === folder_hash && r.pass_rate !== null);
}

/**
 * One row per version (`versions` oldest first), newest version first. A run is linked to the version whose folder
 * hash it stored; a run with no hash, or a hash no version has, links to none and is never backfilled.
 */
export function skillVersionRows(versions: readonly VersionOf[], runs: readonly LinkedRun[]): SkillVersionRow[] {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const rows = ordered.map((v, i): SkillVersionRow => {
    const run = latestLinkedRun(runs, v.folder_hash);
    return { version: v.version, folder_hash: v.folder_hash, created_at: v.created_at, current: i === ordered.length - 1, run_id: run?.id ?? null, pass_rate: run?.pass_rate ?? null, change: null };
  });
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.change = prev && prev.pass_rate !== null && r.pass_rate !== null ? r.pass_rate - prev.pass_rate : null;
  });
  return rows.reverse();
}

/** The runs whose stored hash is no version's (or none at all): unlinked. */
export function unlinkedRuns<R extends Pick<SkillEvalRun, "skill_version">>(versions: readonly Pick<VersionOf, "folder_hash">[], runs: readonly R[]): R[] {
  const hashes = new Set(versions.map((v) => v.folder_hash));
  return runs.filter((r) => r.skill_version === null || r.skill_version === "" || !hashes.has(r.skill_version));
}

/** One line of a unified (one column) diff. */
export interface DiffLine {
  op: "same" | "removed" | "added";
  text: string;
}

/** The unified line diff from `a` to `b` (longest common subsequence): at each change, removed lines come before added ones. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const lines = (t: string) => t.replace(/\r?\n$/, "").split(/\r?\n/);
  const x = lines(a), y = lines(b);
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: "same", text: x[i++]! });
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: "removed", text: x[i++]! });
    else out.push({ op: "added", text: y[j++]! });
  }
  return out;
}

/** One case's verdict in each of two runs; null where that run recorded none. */
export interface CaseResult {
  case_id: string;
  a: string | null;
  b: string | null;
}

/** The per-case results of two runs' replays, by case id. */
export function caseResults(a: readonly { case_id: string; verdict: string }[], b: readonly { case_id: string; verdict: string }[]): CaseResult[] {
  const ids = [...new Set([...a, ...b].map((r) => r.case_id))].sort();
  const of = (list: typeof a, id: string) => list.find((r) => r.case_id === id)?.verdict ?? null;
  return ids.map((case_id) => ({ case_id, a: of(a, case_id), b: of(b, case_id) }));
}
