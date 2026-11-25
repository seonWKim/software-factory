import { describe, expect, it } from "vitest";
import { compareSkillEvalRuns, pairedVerdict, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { UserId } from "../src/core/types.js";
import type { SkillEvalRun } from "../src/interfaces/skill-eval-store.js";

// The pure grid and compare over stored skill-eval runs (src/core/skill-eval-compare.ts), shared by the CLI and the
// read routes: one row per (skill version, model class) from its newest run, and the paired compare.

const run = (id: string, started_at: string, o: Partial<SkillEvalRun> = {}): SkillEvalRun => ({
  id, suite_id: "s1", status: "passed", started_at: started_at as SkillEvalRun["started_at"], finished_at: null, created_by: "local:owner" as UserId,
  skill_version: "v1", suite_version: 1, judge_version: "j1", factory_version: "dev", model_class: "standard", judge_model_class: "strong", replays: 4, pass_rate: 0.5, errored: 0, ...o,
});

describe("skillEvalGrid", () => {
  it("keeps the newest run of each skill version and model class, newest row first", () => {
    const runs = [
      run("old-v1-std", "2026-11-01T00:00:00Z", { pass_rate: 0.25 }),
      run("v2-std", "2026-11-03T00:00:00Z", { skill_version: "v2", pass_rate: 1 }),
      run("new-v1-std", "2026-11-02T00:00:00Z", { pass_rate: 0.75 }),
      run("v1-cheap", "2026-11-02T00:00:00Z", { model_class: "cheap", judge_model_class: "strong", pass_rate: null, replays: 0 }),
    ];
    const rows = skillEvalGrid(runs);
    expect(rows.map((r) => r.run_id)).toEqual(["v2-std", "v1-cheap", "new-v1-std"]);
    expect(rows.find((r) => r.run_id === "new-v1-std")).toEqual({
      skill_version: "v1", suite_version: 1, judge_version: "j1", factory_version: "dev", model_class: "standard", judge_model_class: "strong", run_id: "new-v1-std", started_at: "2026-11-02T00:00:00Z", status: "passed", replays: 4, pass_rate: 0.75, errored: 0,
    });
    expect(rows.find((r) => r.run_id === "v1-cheap")).toMatchObject({ pass_rate: null, replays: 0 });
  });

  it("leaves out runs with no recorded figures (no model class)", () => {
    const rows = skillEvalGrid([run("figures", "2026-11-01T00:00:00Z"), run("before-figures", "2026-11-02T00:00:00Z", { model_class: null, judge_model_class: null, replays: null, pass_rate: null, errored: null, skill_version: null })]);
    expect(rows.map((r) => r.run_id)).toEqual(["figures"]);
    expect(skillEvalGrid([])).toEqual([]);
  });
});

/** Replays of `case_id`, one per verdict. */
const v = (case_id: string, ...verdicts: string[]) => verdicts.map((verdict) => ({ case_id, verdict }));
/** `n` cases c0.. each with one replay of `verdict`. */
const cases = (n: number, verdict: string, from = 0) => Array.from({ length: n }, (_, i) => v(`c${from + i}`, verdict)).flat();
const NONE = { a: [], b: [] };

describe("the paired compare", () => {
  it("pairs cases by id on their pass rates and counts wins, losses and ties, leaving out cases in only one run", () => {
    const c = compareSkillEvalRuns(run("a", "x"), run("b", "y"), {
      a: [...v("up", "fail", "pass"), ...v("down", "pass", "pass"), ...v("same", "pass", "errored"), ...v("only-a", "pass")],
      b: [...v("up", "pass", "pass"), ...v("down", "pass", "fail"), ...v("same", "fail", "pass"), ...v("only-b", "fail")],
    });
    expect(c).toMatchObject({ comparable: true, reason: null, paired: 3, wins: 1, losses: 1, ties: 1, p_value: 1, verdict: "within noise" });
    expect(c.mean_difference).toBeCloseTo(0, 12);
    expect(c.interval!.low).toBeLessThan(0);
    expect(c.interval!.high).toBeGreaterThan(0);
    expect(c.a).toEqual({ run_id: "a", started_at: "x", status: "passed", skill_version: "v1", suite_version: 1, judge_version: "j1", factory_version: "dev", model_class: "standard", judge_model_class: "strong", replays: 4, pass_rate: 0.5, errored: 0 });
  });

  it("is better when every one of six cases improves (p = 2/64, interval above zero), worse the other way", () => {
    const better = compareSkillEvalRuns(run("a", "x"), run("b", "y"), { a: cases(6, "fail"), b: cases(6, "pass") });
    expect(better).toMatchObject({ wins: 6, losses: 0, ties: 0, mean_difference: 1, interval: { low: 1, high: 1 }, verdict: "better" });
    expect(better.p_value).toBeCloseTo(2 / 64, 12);
    expect(compareSkillEvalRuns(run("a", "x"), run("b", "y"), { a: cases(6, "pass"), b: cases(6, "errored") })).toMatchObject({ wins: 0, losses: 6, verdict: "worse" });
  });

  it("five wins of five is within noise: p = 2/32 is not under 0.05", () => {
    const c = compareSkillEvalRuns(run("a", "x"), run("b", "y"), { a: cases(5, "fail"), b: cases(5, "pass") });
    expect(c.p_value).toBeCloseTo(2 / 32, 12);
    expect(c.verdict).toBe("within noise");
  });

  it("the verdict needs p under 0.05 and the interval past zero in that direction", () => {
    expect(pairedVerdict(0.01, { low: 0.1, high: 0.3 })).toBe("better");
    expect(pairedVerdict(0.01, { low: -0.3, high: -0.1 })).toBe("worse");
    expect(pairedVerdict(0.01, { low: -0.1, high: 0.3 })).toBe("within noise");
    expect(pairedVerdict(0.01, { low: 0, high: 0.3 })).toBe("within noise");
    expect(pairedVerdict(0.05, { low: 0.1, high: 0.3 })).toBe("within noise");
    expect(pairedVerdict(0.01, null)).toBe("within noise");
  });

  it("one paired case has no interval; none paired has no mean, interval or verdict", () => {
    expect(compareSkillEvalRuns(run("a", "x"), run("b", "y"), { a: v("c", "fail"), b: v("c", "pass") })).toMatchObject({ paired: 1, wins: 1, p_value: 1, mean_difference: 1, interval: null, verdict: "within noise" });
    expect(compareSkillEvalRuns(run("a", "x"), run("b", "y"), { a: v("c", "fail"), b: v("d", "pass") })).toMatchObject({ paired: 0, wins: 0, losses: 0, ties: 0, p_value: 1, mean_difference: null, interval: null, verdict: null });
    expect(compareSkillEvalRuns(run("a", "x", { pass_rate: null, replays: 0 }), run("b", "y"), NONE)).toMatchObject({ comparable: true, paired: 0, verdict: null });
  });

  it("carries no noise band", () => {
    const c = compareSkillEvalRuns(run("a", "x"), run("b", "y"), NONE) as unknown as Record<string, unknown>;
    for (const k of ["gap", "noise_band", "within_noise"]) expect(c).not.toHaveProperty(k);
  });
});

describe("comparable runs (same suite and judge versions)", () => {
  const notComparable = (reason: string) => ({ comparable: false, reason, paired: null, wins: null, losses: null, ties: null, p_value: null, mean_difference: null, interval: null, verdict: null });
  const a = run("a", "x", { pass_rate: 0, replays: 100 });

  it("compares runs on the same suite, suite version and judge version, whatever their skill or factory version", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { pass_rate: 1, replays: 100, skill_version: "v2", factory_version: "abc" }), NONE)).toMatchObject({ comparable: true, reason: null, paired: 0 });
  });

  it("refuses runs whose suite versions differ, or that ran on another suite", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { suite_version: 2 }), NONE)).toMatchObject(notComparable("the suite versions differ"));
    expect(compareSkillEvalRuns(a, run("b", "y", { suite_id: "s2" }), NONE)).toMatchObject(notComparable("the suite versions differ"));
  });

  it("refuses runs whose judge versions differ", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { judge_version: "j2" }), NONE)).toMatchObject(notComparable("the judge versions differ"));
  });

  it("refuses when either run has no version recorded (a run stored before versions)", () => {
    expect(compareSkillEvalRuns(run("old", "x", { suite_version: null, judge_version: null }), a, NONE)).toMatchObject(notComparable("one run has no version recorded"));
    expect(compareSkillEvalRuns(a, run("b", "y", { judge_version: null }), NONE)).toMatchObject(notComparable("one run has no version recorded"));
    const old = compareSkillEvalRuns(a, run("b", "y", { suite_version: null }), NONE);
    expect(old).toMatchObject(notComparable("one run has no version recorded"));
    expect(old.a.pass_rate).toBe(0);
  });
});
