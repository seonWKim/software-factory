// A skill-eval run's figures over its replays (design 06-measurement, repeats): pass@1, pass^k and the 95% Wilson
// interval, computed from the stored verdicts; and the paired compare of two runs (design 06-measurement, compare):
// each case's pass rate, the exact sign test and the paired 95% t interval. Pure functions: no store, no clock. A run
// replays each case k times (`eval run --replays k`); a run stored before replay numbers has one replay per case, so
// its k is 1.

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

/** Each case's pass rate over its replays (passes ÷ replays; an errored replay does not pass), by case id. */
export function caseRates(verdicts: readonly StatVerdict[]): Map<string, number> {
  return new Map([...byCase(verdicts)].map(([id, vs]) => [id, vs.filter((v) => v === "pass").length / vs.length]));
}

/** ln(n!) by summing logs: exact enough for the case counts a suite has. */
function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * The exact two-sided sign test over the non-tied cases: with n = wins + losses and X ~ Binomial(n, ½),
 * p = min(1, 2 × P(X ≤ min(wins, losses))); 1 when n is 0.
 */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const lnN = logFactorial(n), half = n * Math.log(0.5);
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k++) tail += Math.exp(lnN - logFactorial(k) - logFactorial(n - k) + half);
  return Math.min(1, 2 * tail);
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the regularized incomplete beta function (modified Lentz). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    for (const num of [(m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)), (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + num * d;
      d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b), 0 ≤ x ≤ 1. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** P(T ≤ t) for Student's t with `df` degrees of freedom. */
function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** The t value with P(T ≤ t) = `p` (0.5 < p < 1) for `df` degrees of freedom, by bisection on the CDF. */
export function studentTQuantile(p: number, df: number): number {
  let low = 0, high = 1;
  while (studentTCdf(high, df) < p) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-12; i++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * The mean of the paired differences and its 95% interval: mean ± t × sd ÷ √n, with the sample sd and Student's t
 * at n − 1 degrees of freedom. The mean is null with no difference, the interval null with fewer than two.
 */
export function pairedInterval(diffs: readonly number[]): { mean: number | null; interval: { low: number; high: number } | null } {
  const n = diffs.length;
  if (n === 0) return { mean: null, interval: null };
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  if (n < 2) return { mean, interval: null };
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1));
  const half = studentTQuantile(0.975, n - 1) * (sd / Math.sqrt(n));
  return { mean, interval: { low: mean - half, high: mean + half } };
}
