import { describe, expect, it } from "vitest";
import { compareSkillEvalRuns, noiseBand, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { UserId } from "../src/core/types.js";
import type { SkillEvalRun } from "../src/interfaces/skill-eval-store.js";

// The pure grid and compare over stored skill-eval runs (src/core/skill-eval-compare.ts), shared by the CLI and the
// read routes: one row per (skill version, model class) from its newest run, and the noise rule.

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

describe("the noise rule", () => {
  it("is 2 × sqrt(sd_a² + sd_b²) with sd = sqrt(p × (1 − p) ÷ replays)", () => {
    const sd = (p: number, n: number) => Math.sqrt((p * (1 - p)) / n);
    expect(noiseBand({ pass_rate: 0.5, replays: 4 }, { pass_rate: 0.75, replays: 8 })).toBeCloseTo(2 * Math.sqrt(sd(0.5, 4) ** 2 + sd(0.75, 8) ** 2), 12);
    expect(noiseBand({ pass_rate: 1, replays: 3 }, { pass_rate: 0, replays: 3 })).toBe(0);
  });

  it("calls a gap within the band within noise, and a wider one not", () => {
    const a = run("a", "2026-11-01T00:00:00Z", { pass_rate: 0.5, replays: 4 });
    const near = compareSkillEvalRuns(a, run("b", "2026-11-02T00:00:00Z", { pass_rate: 0.75, replays: 4 }));
    expect(near.gap).toBeCloseTo(0.25, 12);
    expect(near.noise_band).toBeCloseTo(2 * Math.sqrt(0.0625 + 0.046875), 12);
    expect(near.within_noise).toBe(true);
    const far = compareSkillEvalRuns(run("a", "x", { pass_rate: 0, replays: 100 }), run("b", "y", { pass_rate: 1, replays: 100 }));
    expect(far).toMatchObject({ gap: 1, noise_band: 0, within_noise: false });
    expect(far.a).toEqual({ run_id: "a", started_at: "x", status: "passed", skill_version: "v1", suite_version: 1, judge_version: "j1", factory_version: "dev", model_class: "standard", judge_model_class: "strong", replays: 100, pass_rate: 0, errored: 0 });
  });

  it("a gap exactly on the band is within noise", () => {
    expect(compareSkillEvalRuns(run("a", "x", { pass_rate: 1, replays: 2 }), run("b", "y", { pass_rate: 1, replays: 2 }))).toMatchObject({ gap: 0, noise_band: 0, within_noise: true });
  });

  it("a null pass rate (or no replays) gives no comparison", () => {
    const none = compareSkillEvalRuns(run("a", "x", { pass_rate: null, replays: 0 }), run("b", "y"));
    expect(none).toMatchObject({ gap: null, noise_band: null, within_noise: null });
    expect(none.a.pass_rate).toBeNull();
    expect(compareSkillEvalRuns(run("a", "x"), run("b", "y", { pass_rate: null, replays: null, model_class: null }))).toMatchObject({ gap: null, noise_band: null, within_noise: null });
    expect(none).toMatchObject({ comparable: true, reason: null });
  });
});

describe("comparable runs (same suite and judge versions)", () => {
  const notComparable = (reason: string) => ({ comparable: false, reason, gap: null, noise_band: null, within_noise: null });
  const a = run("a", "x", { pass_rate: 0, replays: 100 });

  it("compares runs on the same suite, suite version and judge version, whatever their skill or factory version", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { pass_rate: 1, replays: 100, skill_version: "v2", factory_version: "abc" }))).toMatchObject({ comparable: true, reason: null, gap: 1 });
  });

  it("refuses runs whose suite versions differ, or that ran on another suite", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { suite_version: 2 }))).toMatchObject(notComparable("the suite versions differ"));
    expect(compareSkillEvalRuns(a, run("b", "y", { suite_id: "s2" }))).toMatchObject(notComparable("the suite versions differ"));
  });

  it("refuses runs whose judge versions differ", () => {
    expect(compareSkillEvalRuns(a, run("b", "y", { judge_version: "j2" }))).toMatchObject(notComparable("the judge versions differ"));
  });

  it("refuses when either run has no version recorded (a run stored before versions)", () => {
    expect(compareSkillEvalRuns(run("old", "x", { suite_version: null, judge_version: null }), a)).toMatchObject(notComparable("one run has no version recorded"));
    expect(compareSkillEvalRuns(a, run("b", "y", { judge_version: null }))).toMatchObject(notComparable("one run has no version recorded"));
    const old = compareSkillEvalRuns(a, run("b", "y", { suite_version: null }));
    expect(old).toMatchObject(notComparable("one run has no version recorded"));
    expect(old.a.pass_rate).toBe(0);
  });
});
