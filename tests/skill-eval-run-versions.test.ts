import { describe, expect, it } from "vitest";
import { OWNER } from "./helpers/classifier.js";
import { newStore } from "./helpers/store.js";

// its skill version and figures; a case add, edit or delete gives the suite its next version in the same transaction,
// and a run keeps the suite version it started with. A run stored before keeps null: no backfill.

const FIGURES = { model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate: 1, errored: 0 };

type Store = Awaited<ReturnType<typeof newStore>>["store"];
const suiteVersion = async (store: Store, id: string) => Number((await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = ?", [id]))[0]!.version);

async function withSuite() {
  const { store } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/a", title: "A", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/b", title: "B", created_by: OWNER });
  return store;
}

describe("a run's versions", () => {
  it("stores suite_version, judge_version and factory_version beside skill_version, model_class and judge_model_class", async () => {
    const store = await withSuite();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "sk1", judge_version: "j1", factory_version: "rev1" });
    await store.finishSkillEvalRun("r1", "passed");
    await store.recordSkillEvalRunFigures("r1", FIGURES);
    expect(await store.getSkillEvalRun("r1")).toMatchObject({
      skill_version: "sk1", suite_version: await suiteVersion(store, "s1"), judge_version: "j1", factory_version: "rev1", model_class: "standard", judge_model_class: "strong",
    });
    expect((await store.listSkillEvalRuns("skills/a"))[0]).toMatchObject({ suite_version: await suiteVersion(store, "s1"), judge_version: "j1", factory_version: "rev1" });
  });

  it("keeps null in each version on a run stored before them, with no backfill", async () => {
    const store = await withSuite();
    await store.db.run("INSERT INTO controller_skill_eval_runs (id, suite_id, status, started_at, created_by) VALUES ('old', 's1', 'passed', 't', ?)", [OWNER]);
    await store.startSkillEvalRun({ id: "new", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await store.getSkillEvalRun("old")).toMatchObject({ suite_version: null, judge_version: null, factory_version: null });
  });
});

describe("a suite's version", () => {
  it("goes to the next version on each case add, edit and delete, and only for that case's suite", async () => {
    const store = await withSuite();
    const start = await suiteVersion(store, "s1");
    const other = await suiteVersion(store, "s2");
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await suiteVersion(store, "s1")).toBe(start + 1);
    await store.updateSkillEvalCase("c1", { input: "x2", expected: "y2" });
    expect(await suiteVersion(store, "s1")).toBe(start + 2);
    expect(await store.deleteSkillEvalCase("c1")).toBe(true);
    expect(await suiteVersion(store, "s1")).toBe(start + 3);
    expect(await suiteVersion(store, "s2")).toBe(other);
  });

  it("is unchanged by a repeated add, or an edit or delete of an unknown case", async () => {
    const store = await withSuite();
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    const v = await suiteVersion(store, "s1");
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    expect(await store.updateSkillEvalCase("nope", { input: 1, expected: 2 })).toBeNull();
    expect(await store.deleteSkillEvalCase("nope")).toBe(false);
    expect(await suiteVersion(store, "s1")).toBe(v);
  });

  it("a run keeps the suite version it started with after a case changes", async () => {
    const store = await withSuite();
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: "y" });
    const before = await suiteVersion(store, "s1");
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.updateSkillEvalCase("c1", { input: "x2", expected: "y" });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    await store.startSkillEvalRun({ id: "r2", suite_id: "s1", created_by: OWNER, judge_version: "j1", factory_version: "dev" });
    expect((await store.getSkillEvalRun("r1"))!.suite_version).toBe(before);
    expect((await store.getSkillEvalRun("r2"))!.suite_version).toBe(before + 1);
  });
});
