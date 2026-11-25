import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { newStore } from "./helpers/store.js";

// The skill-eval store's run list and figures: a skill's runs over its suites only, newest first, and a finished
// run's figures written once.

const OWNER = "local:owner" as UserId;
const FIGURES = { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0.5, errored: 1 };

async function twoSkills() {
  const { store, clock } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "A", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/a", title: "A again", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s3", skill_ref: "skills/b", title: "B", created_by: OWNER });
  return { store, clock };
}

describe("listSkillEvalRuns", () => {
  it("lists the skill's runs over all its suites, newest first, and no other skill's", async () => {
    const { store, clock } = await twoSkills();
    await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
    clock.advance(1000);
    await store.startSkillEvalRun({ id: "other", suite_id: "s3", created_by: OWNER });
    clock.advance(1000);
    await store.startSkillEvalRun({ id: "new", suite_id: "s2", created_by: OWNER, skill_version: "v2" });
    const runs = await store.listSkillEvalRuns("skills/a");
    expect(runs.map((r) => r.id)).toEqual(["new", "old"]);
    expect(runs[0]).toMatchObject({ suite_id: "s2", status: "running", skill_version: "v2", model_class: null, replays: null });
    expect(await store.listSkillEvalRuns("skills/none")).toEqual([]);
  });
});

describe("getSkillEvalRun", () => {
  it("reads one run by id with its figures, whatever its skill; null for an unknown id", async () => {
    const { store } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s3", created_by: OWNER, skill_version: "v1" });
    await store.finishSkillEvalRun("r1", "failed");
    await store.recordSkillEvalRunFigures("r1", FIGURES);
    expect(await store.getSkillEvalRun("r1")).toEqual((await store.listSkillEvalRuns("skills/b"))[0]);
    expect(await store.getSkillEvalRun("r1")).toMatchObject({ id: "r1", suite_id: "s3", skill_version: "v1", ...FIGURES });
    expect(await store.getSkillEvalRun("nope")).toBeNull();
  });
});

describe("recordSkillEvalRunFigures", () => {
  it("writes a finished run's figures once, and reads them back", async () => {
    const { store } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    await store.finishSkillEvalRun("r1", "failed");
    expect(await store.recordSkillEvalRunFigures("r1", FIGURES)).toBe(true);
    expect(await store.recordSkillEvalRunFigures("r1", { ...FIGURES, replays: 9 })).toBe(false);
    const [run] = await store.listSkillEvalRuns("skills/a");
    expect(run).toMatchObject({ id: "r1", status: "failed", ...FIGURES });
  });

  it("keeps a null pass rate, and refuses a running or unknown run", async () => {
    const { store } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    expect(await store.recordSkillEvalRunFigures("r1", FIGURES)).toBe(false);
    expect(await store.recordSkillEvalRunFigures("nope", FIGURES)).toBe(false);
    await store.finishSkillEvalRun("r1", "errored");
    expect(await store.recordSkillEvalRunFigures("r1", { ...FIGURES, replays: 0, pass_rate: null, errored: 0 })).toBe(true);
    expect((await store.listSkillEvalRuns("skills/a"))[0]).toMatchObject({ replays: 0, pass_rate: null, errored: 0 });
  });
});

describe("recordSkillEvalReplay: replay numbers", () => {
  it("stores one verdict per run, case and replay number, keeps the first of each, and reads the number back", async () => {
    const { store } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    const put = (replay: number | undefined, verdict: string) => store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", verdict, detail: {}, ...(replay !== undefined ? { replay } : {}) });
    expect(await put(1, "pass")).toMatchObject({ replay: 1, verdict: "pass" });
    expect(await put(2, "fail")).toMatchObject({ replay: 2, verdict: "fail" });
    expect(await put(1, "fail")).toMatchObject({ replay: 1, verdict: "pass" });
    // None counts as 0: its own key, kept first too.
    expect(await put(undefined, "errored")).toMatchObject({ replay: null, verdict: "errored" });
    expect(await put(undefined, "pass")).toMatchObject({ replay: null, verdict: "errored" });
    const stored = await store.listSkillEvalReplays("r1");
    expect(stored.map((r) => [r.replay, r.verdict])).toEqual(expect.arrayContaining([[1, "pass"], [2, "fail"], [null, "errored"]]));
    expect(stored).toHaveLength(3);
  });
});

describe("recordSkillEvalLabel and listSkillEvalLabels: the owner's labels on the judge", () => {
  it("stores a right or wrong label on a judged check with its run, case, replay number, check and owner ID", async () => {
    const { store } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    const right = { run_id: "r1", case_id: "c1", replay: 1, check: "cites the source", verdict: "right" as const, owner_id: OWNER };
    const wrong = { ...right, replay: 2, verdict: "wrong" as const };
    expect(await store.recordSkillEvalLabel(right)).toEqual({ ...right, created_at: expect.any(String) });
    expect(await store.recordSkillEvalLabel(wrong)).toEqual({ ...wrong, created_at: expect.any(String) });
    const rows = await store.db.all("SELECT run_id, case_id, replay, check_text, verdict, owner_id FROM controller_skill_eval_labels ORDER BY replay");
    expect(rows).toEqual([
      { run_id: "r1", case_id: "c1", replay: 1, check_text: "cites the source", verdict: "right", owner_id: OWNER },
      { run_id: "r1", case_id: "c1", replay: 2, check_text: "cites the source", verdict: "wrong", owner_id: OWNER },
    ]);
  });

  it("a second label on the same run, case, replay and check keeps the first", async () => {
    const { store, clock } = await twoSkills();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    const first = await store.recordSkillEvalLabel({ run_id: "r1", case_id: "c1", replay: 1, check: "k", verdict: "right", owner_id: OWNER });
    clock.advance(1000);
    expect(await store.recordSkillEvalLabel({ ...first, verdict: "wrong", owner_id: "local:other" as UserId })).toEqual(first);
    expect(await store.listSkillEvalLabels("skills/a")).toEqual([first]);
  });

  it("lists the labels on the runs of every suite of the skill, and no other skill's", async () => {
    const { store, clock } = await twoSkills();
    await store.startSkillEvalRun({ id: "a1", suite_id: "s1", created_by: OWNER });
    await store.startSkillEvalRun({ id: "a2", suite_id: "s2", created_by: OWNER });
    await store.startSkillEvalRun({ id: "b1", suite_id: "s3", created_by: OWNER });
    for (const run_id of ["a1", "b1", "a2"]) {
      await store.recordSkillEvalLabel({ run_id, case_id: "c1", replay: 0, check: "k", verdict: "right", owner_id: OWNER });
      clock.advance(1000);
    }
    expect((await store.listSkillEvalLabels("skills/a")).map((l) => l.run_id)).toEqual(["a1", "a2"]);
    expect((await store.listSkillEvalLabels("skills/b")).map((l) => l.run_id)).toEqual(["b1"]);
    expect(await store.listSkillEvalLabels("skills/none")).toEqual([]);
  });
});
