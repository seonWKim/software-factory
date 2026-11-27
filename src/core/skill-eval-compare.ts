// Grid and compare over stored skill-eval runs (design 06-measurement), pure: `factory eval results <skill> --by
// version,model`, `factory eval compare` and GET /api/v1/evals/<skill>/grid and /compare all use these, so the
// grouping and the paired compare live once. The per-version read and the version diff (GET /api/v1/evals/<skill>/versions
// and /diff) link runs to skill versions by folder hash here too, and the diff read tallies the two versions' cases
// (caseResults, through caseTally) by the same verdict rule as compare (pairedVerdict). Nothing here reads or writes the store. Main.ts passes them to the CLI
// through the command call (CommandCall.skillEvalReads); the routes import them.

import type { SkillEvalRun, SkillVersionGateState } from "../interfaces/skill-eval-store.js";
import { caseRates, pairedInterval, signTestP, type StatVerdict } from "./skill-eval-stats.js";

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

/** Run b against run a on their paired cases: better, worse or within noise. */
export type SkillEvalVerdict = "better" | "worse" | "within noise";

/**
 * Two runs side by side, paired case by case: each case's pass rate in a and in b (passes ÷ its replays), the cases
 * where b is higher (wins), lower (losses) or equal (ties), the exact sign-test p over the non-tied cases, the mean
 * case difference (b − a) with its paired 95% interval, and the verdict. Cases in only one run are left out. Not
 * comparable (with the reason, and every figure null) when they ran on different suite or judge versions, or one has
 * none recorded; with no paired case the mean, the interval and the verdict are null.
 */
export interface SkillEvalComparison {
  a: SkillEvalRunSummary;
  b: SkillEvalRunSummary;
  comparable: boolean;
  /** Why the runs are not comparable; null when they are. */
  reason: string | null;
  /** Cases with replays in both runs. */
  paired: number | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  p_value: number | null;
  mean_difference: number | null;
  /** The paired 95% interval of mean_difference; null with fewer than two paired cases. */
  interval: { low: number; high: number } | null;
  verdict: SkillEvalVerdict | null;
}

/** The stored replay verdicts of the two runs compared, as listSkillEvalReplays reads them. */
export interface ComparedReplays {
  a: readonly StatVerdict[];
  b: readonly StatVerdict[];
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

type Versioned = Pick<SkillEvalRun, "suite_id" | "suite_version" | "judge_version">;

/** Why two runs cannot be set side by side, or null when they can: the same suite and suite version, the same judge version. */
export function notComparableReason(a: Versioned, b: Versioned): string | null {
  if ([a, b].some((r) => r.suite_version === null || r.judge_version === null)) return "one run has no version recorded";
  if (a.suite_id !== b.suite_id || a.suite_version !== b.suite_version) return "the suite versions differ";
  if (a.judge_version !== b.judge_version) return "the judge versions differ";
  return null;
}

/** Better when p < 0.05 and the interval is above zero, worse when p < 0.05 and it is below zero, else within noise. */
export function pairedVerdict(p: number, interval: { low: number; high: number } | null): SkillEvalVerdict {
  if (p < 0.05 && interval !== null && interval.low > 0) return "better";
  if (p < 0.05 && interval !== null && interval.high < 0) return "worse";
  return "within noise";
}

/**
 * Compares run b against run a on the cases both ran (see SkillEvalComparison). Runs notComparableReason names get
 * no figures. Reads nothing: the caller passes both runs' stored replays.
 */
export function compareSkillEvalRuns(a: SkillEvalRun, b: SkillEvalRun, replays: ComparedReplays): SkillEvalComparison {
  const head = { a: summary(a), b: summary(b) };
  const reason = notComparableReason(a, b);
  if (reason !== null) {
    return { ...head, comparable: false, reason, paired: null, wins: null, losses: null, ties: null, p_value: null, mean_difference: null, interval: null, verdict: null };
  }
  const ra = caseRates(replays.a), rb = caseRates(replays.b);
  const diffs = [...ra].filter(([id]) => rb.has(id)).map(([id, rate]) => rb.get(id)! - rate);
  const wins = diffs.filter((d) => d > 0).length, losses = diffs.filter((d) => d < 0).length;
  const p_value = signTestP(wins, losses);
  const { mean, interval } = pairedInterval(diffs);
  return {
    ...head, comparable: true, reason: null, paired: diffs.length, wins, losses, ties: diffs.length - wins - losses, p_value,
    mean_difference: mean, interval, verdict: diffs.length === 0 ? null : pairedVerdict(p_value, interval),
  };
}

/** One skill version as the per-version read takes it (an `ext_skill_versions` row; the text is not needed). */
export interface VersionOf {
  version: number;
  folder_hash: string;
  created_at: string;
  /** Its gate's state (design 07-self-improvement); absent or null: recorded before the gate, with no gate row. */
  gate?: SkillVersionGateState | null;
}

/** A run as the per-version read links it: by its stored folder hash. */
type LinkedRun = Pick<SkillEvalRun, "id" | "started_at" | "skill_version" | "pass_rate">;

/** One version with its latest linked run's pass rate, the change since the previous version and the current mark. */
export interface SkillVersionRow extends VersionOf {
  /** Its gate's state; null: no gate row. */
  gate: SkillVersionGateState | null;
  /** The gate's current version: the newest whose gate passed or that has no gate (as currentSkillVersion reads it). */
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
  const current = ordered.findLast((v) => v.gate == null || v.gate === "passed")?.version;
  const rows = ordered.map((v): SkillVersionRow => {
    const run = latestLinkedRun(runs, v.folder_hash);
    return {
      version: v.version, folder_hash: v.folder_hash, created_at: v.created_at, gate: v.gate ?? null, current: v.version === current,
      run_id: run?.id ?? null, pass_rate: run?.pass_rate ?? null, change: null,
    };
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


/** The second version against the first over their case results: wins, losses, ties and the paired verdict. */
export interface CaseTally {
  wins: number;
  losses: number;
  ties: number;
  /** pairedVerdict of the counted cases; null when no case is counted. */
  verdict: SkillEvalVerdict | null;
}

const passOrFail = (v: string | null): boolean => v === "pass" || v === "fail";

/**
 * Tallies `cases` (caseResults of the first version a and the second b): a case counts only when both have a pass or
 * a fail. A win when b passed and a did not, a loss in the reverse case, a tie when both gave the same result. The
 * verdict is pairedVerdict over the sign test of wins and losses and the paired interval of the differences (1, 0 or −1).
 */
export function caseTally(cases: readonly CaseResult[]): CaseTally {
  const diffs = cases.filter((c) => passOrFail(c.a) && passOrFail(c.b)).map((c) => Number(c.b === "pass") - Number(c.a === "pass"));
  const wins = diffs.filter((d) => d > 0).length, losses = diffs.filter((d) => d < 0).length;
  return { wins, losses, ties: diffs.length - wins - losses, verdict: diffs.length === 0 ? null : pairedVerdict(signTestP(wins, losses), pairedInterval(diffs).interval) };
}

/** The per-case results of two runs' replays, by case id, with their tally (caseTally). */
export function caseResults(a: readonly { case_id: string; verdict: string }[], b: readonly { case_id: string; verdict: string }[]): CaseTally & { cases: CaseResult[] } {
  const ids = [...new Set([...a, ...b].map((r) => r.case_id))].sort();
  const of = (list: typeof a, id: string) => list.find((r) => r.case_id === id)?.verdict ?? null;
  const cases = ids.map((case_id) => ({ case_id, a: of(a, case_id), b: of(b, case_id) }));
  return { cases, ...caseTally(cases) };
}
