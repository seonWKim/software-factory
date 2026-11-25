// A skill-eval run's figures over its replays (design 06-measurement, repeats): pass@1, pass^k and the 95% Wilson
// interval, computed from the stored verdicts. Pure functions: no store, no clock. A run replays each case k times
// (`eval run --replays k`); a run stored before replay numbers has one replay per case, so its k is 1.

/** The z of a two-sided 95% interval. */
export const Z_95 = 1.96;

/** One stored verdict of a run: its case and verdict (`pass`, `fail` or `errored`). */
export interface StatVerdict {
  case_id: string;
  verdict: string;
}

/** A run's figures over its replays; each rate null when the run has no replay. */
export interface RunStats {
  /** Replays the run made: cases × k when every replay finished. */
  replays: number;
  /** Replays per case: the most replays any one case has (1 for a run stored before replay numbers). */
  k: number;
  /** Passes ÷ replays. */
  pass_at_1: number | null;
  /** Share of cases that pass all k replays; a case with fewer than k replays does not. */
  pass_hat_k: number | null;
  /** The 95% Wilson interval of pass@1 over the replays. */
  interval: { low: number; high: number } | null;
}

/** Passes ÷ trials; null with no trial. */
export function passAt1(verdicts: readonly StatVerdict[]): number | null {
  return verdicts.length === 0 ? null : verdicts.filter((v) => v.verdict === "pass").length / verdicts.length;
}

/** Each case's verdicts, in the order first seen. */
function byCase(verdicts: readonly StatVerdict[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const v of verdicts) out.set(v.case_id, [...(out.get(v.case_id) ?? []), v.verdict]);
  return out;
}

/** Share of cases that pass all `k` replays; null with no case. */
export function passHatK(verdicts: readonly StatVerdict[], k: number): number | null {
  const cases = [...byCase(verdicts).values()];
  if (cases.length === 0) return null;
  return cases.filter((vs) => vs.length >= k && vs.every((v) => v === "pass")).length / cases.length;
}

/** The Wilson score interval of `passes` in `n` trials at `z` (default 95%), clamped to 0..1; null with no trial. */
export function wilsonInterval(passes: number, n: number, z = Z_95): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = passes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { low: Math.max(0, (centre - spread) / denom), high: Math.min(1, (centre + spread) / denom) };
}

/** A run's pass@1, pass^k (k = the most replays of one case) and 95% Wilson interval, from its stored verdicts. */
export function runStats(verdicts: readonly StatVerdict[]): RunStats {
  const k = Math.max(1, ...[...byCase(verdicts).values()].map((vs) => vs.length));
  const passes = verdicts.filter((v) => v.verdict === "pass").length;
  return { replays: verdicts.length, k, pass_at_1: passAt1(verdicts), pass_hat_k: passHatK(verdicts, k), interval: wilsonInterval(passes, verdicts.length) };
}
