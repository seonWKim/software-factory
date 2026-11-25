import { describe, expect, it } from "vitest";
import { caseRates, pairedInterval, passAt1, passHatK, runStats, signTestP, studentTQuantile, wilsonInterval } from "../src/core/skill-eval-stats.js";

// A run shows pass@1 (passes over its replays), pass^k (share of cases that pass all k replays, k = N) and a 95%
// Wilson interval over its replays (design 06-measurement, repeats).

const v = (case_id: string, ...verdicts: string[]) => verdicts.map((verdict) => ({ case_id, verdict }));

describe("skill-eval stats", () => {
  it("pass@1 is passes over the run's replays", () => {
    expect(passAt1([...v("a", "pass", "pass", "fail"), ...v("b", "pass", "errored", "pass")])).toBeCloseTo(4 / 6);
    expect(passAt1([])).toBeNull();
  });

  it("pass^k is the share of cases that pass all k replays", () => {
    const verdicts = [...v("a", "pass", "pass", "pass"), ...v("b", "pass", "fail", "pass"), ...v("c", "pass", "pass", "pass"), ...v("d", "errored", "errored", "errored")];
    expect(passHatK(verdicts, 3)).toBe(0.5);
    // A case with fewer than k replays does not pass all k.
    expect(passHatK(v("a", "pass", "pass"), 3)).toBe(0);
    expect(passHatK([], 3)).toBeNull();
  });

  it("the 95% Wilson interval matches the closed form and stays inside 0..1", () => {
    const w = wilsonInterval(8, 10)!;
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
    const none = wilsonInterval(0, 5)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.4345, 3);
    const all = wilsonInterval(5, 5)!;
    expect(all.high).toBeCloseTo(1, 10);
    expect(all.low).toBeCloseTo(0.5655, 3);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("runStats reads k from the replays per case and gives all three figures", () => {
    const verdicts = [...v("a", "pass", "pass"), ...v("b", "pass", "fail")];
    const s = runStats(verdicts);
    expect(s).toMatchObject({ replays: 4, k: 2, pass_at_1: 0.75, pass_hat_k: 0.5 });
    expect(s.interval).toEqual(wilsonInterval(3, 4));
  });

  it("a run stored before replay numbers (one replay per case) has k 1, and pass^1 equals pass@1", () => {
    const s = runStats([...v("a", "pass"), ...v("b", "fail")]);
    expect(s).toMatchObject({ k: 1, pass_at_1: 0.5, pass_hat_k: 0.5 });
    expect(runStats([])).toEqual({ replays: 0, k: 1, pass_at_1: null, pass_hat_k: null, interval: null });
  });
});

describe("paired compare stats", () => {
  it("a case's pass rate is its passes over its replays, an errored replay not passing", () => {
    const rates = caseRates([...v("a", "pass", "errored", "pass", "fail"), ...v("b", "pass")]);
    expect(rates.get("a")).toBe(0.5);
    expect(rates.get("b")).toBe(1);
  });

  it("the sign test is the exact two-sided binomial p over the non-tied cases", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(5, 0)).toBeCloseTo(2 / 32, 12);
    expect(signTestP(0, 6)).toBeCloseTo(2 / 64, 12);
    expect(signTestP(8, 2)).toBeCloseTo((2 * (1 + 10 + 45)) / 1024, 12);
    expect(signTestP(3, 3)).toBe(1);
    expect(signTestP(1, 0)).toBe(1);
    // Many cases stay finite: 2 × P(X ≤ 400) for n = 1000 is tiny but above zero.
    const big = signTestP(600, 400);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(1e-9);
  });

  it("the t value at 97.5% matches the table for n − 1 degrees of freedom", () => {
    for (const [df, t] of [[1, 12.7062], [2, 4.3027], [5, 2.5706], [10, 2.2281], [30, 2.0423]] as const) expect(studentTQuantile(0.975, df)).toBeCloseTo(t, 3);
  });

  it("the paired interval is mean ± t × sd ÷ √n; none with fewer than two differences", () => {
    expect(pairedInterval([])).toEqual({ mean: null, interval: null });
    expect(pairedInterval([0.5])).toEqual({ mean: 0.5, interval: null });
    const r = pairedInterval([0, 0.5, 1, 0.5]);
    const sd = Math.sqrt((0.25 + 0 + 0.25 + 0) / 3);
    expect(r.mean).toBeCloseTo(0.5, 12);
    expect(r.interval!.low).toBeCloseTo(0.5 - 3.1824 * (sd / 2), 3);
    expect(r.interval!.high).toBeCloseTo(0.5 + 3.1824 * (sd / 2), 3);
    // Equal differences have no spread: the interval is the mean.
    expect(pairedInterval([1, 1, 1])).toEqual({ mean: 1, interval: { low: 1, high: 1 } });
  });
});
