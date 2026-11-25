import { describe, expect, it } from "vitest";
import { passAt1, passHatK, runStats, wilsonInterval } from "../src/core/skill-eval-stats.js";

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
