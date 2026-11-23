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
