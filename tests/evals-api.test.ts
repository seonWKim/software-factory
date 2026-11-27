import { describe, expect, it } from "vitest";
import { compareSkillEvalRuns, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { CLEAN, FLAGGING, OWNER, SKILL, get, seeded, tables } from "./helpers/evals-api-fixtures.js";
import { newStore } from "./helpers/store.js";

// GET /api/v1/evals/<skill>/runs, /grid and /compare (src/ui/evals-api.ts) through the read route chain: the same
// fields as `factory eval results <skill> [--by version,model] --json` and `factory eval compare --json` (the same
// listSkillEvalRuns, skillEvalGrid and compareSkillEvalRuns), read-only, every stored string through the Withholder.

/** The store behind a proxy that records every method the route calls. */
function watched(store: FactoryStore) {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get: (t, k) => {
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? (...a: unknown[]) => (calls.push(String(k)), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
    },
  });
  return { proxy, calls };
}


describe("GET /api/v1/evals/<skill>/runs", () => {
  it("returns the skill's runs newest first with the same fields as eval results, and calls only the list read", async () => {
    const store = await seeded();
    const { proxy, calls } = watched(store);
    const r = await get(proxy, CLEAN, `/api/v1/evals/${encodeURIComponent(SKILL)}/runs`);
    expect(r.status).toBe(200);
    const listed = JSON.parse(JSON.stringify(await store.listSkillEvalRuns(SKILL)));
    expect(r.value).toEqual({ runs: listed });
    expect((r.value as { runs: { id: string }[] }).runs.map((x) => x.id)).toEqual(["new", "old"]);
    expect((r.value as { runs: unknown[] }).runs[1]).toMatchObject({ skill_version: null, model_class: null, replays: null, pass_rate: null, errored: null });
    expect(calls).toEqual(["listSkillEvalRuns"]);
  });

  it("withholds a stored string the egress scan flags, keeping the other fields", async () => {
    const r = await get(await seeded(), FLAGGING, `/api/v1/evals/${encodeURIComponent(SKILL)}/runs`);
    const [first] = (r.value as { runs: Record<string, unknown>[] }).runs;
    expect(first).toMatchObject({ id: "new", skill_version: "[withheld: test_rule]", model_class: "standard", replays: 2, pass_rate: 0.5 });
    expect(JSON.stringify(r.value)).not.toContain("LEAK");
  });

  it("an unknown skill lists no runs; a broken encoding is a 400", async () => {
    const store = await seeded();
    expect((await get(store, CLEAN, "/api/v1/evals/skills%2Fnone/runs")).value).toEqual({ runs: [] });
    expect((await get(store, CLEAN, "/api/v1/evals/%E0%A4%A/runs")).status).toBe(400);
  });
});

describe("GET /api/v1/evals/<skill>/grid", () => {
  it("returns the CLI --by version,model rows, reading only the run list and writing nothing", async () => {
    const store = await seeded();
    const before = await tables(store);
    const { proxy, calls } = watched(store);
    const r = await get(proxy, CLEAN, `/api/v1/evals/${encodeURIComponent(SKILL)}/grid`);
    expect(r.status).toBe(200);
    expect(r.value).toEqual({ rows: JSON.parse(JSON.stringify(skillEvalGrid(await store.listSkillEvalRuns(SKILL)))) });
    expect((r.value as { rows: { run_id: string }[] }).rows.map((x) => x.run_id)).toEqual(["new"]);
    expect(calls).toEqual(["listSkillEvalRuns"]);
    expect(await tables(store)).toEqual(before);
  });

  it("withholds a flagged string", async () => {
    const r = await get(await seeded(), FLAGGING, `/api/v1/evals/${encodeURIComponent(SKILL)}/grid`);
    expect((r.value as { rows: unknown[] }).rows[0]).toMatchObject({ run_id: "new", skill_version: "[withheld: test_rule]", pass_rate: 0.5 });
  });
});

describe("GET /api/v1/evals/<skill>/compare", () => {
  const path = (a: string, b: string, skill = SKILL) => `/api/v1/evals/${encodeURIComponent(skill)}/compare?a=${a}&b=${b}`;

  it("returns the CLI compare --json fields, the runs and their replays read by id, writing nothing", async () => {
    const store = await seeded();
    const before = await tables(store);
    const { proxy, calls } = watched(store);
    const r = await get(proxy, CLEAN, path("old", "new"));
    expect(r.status).toBe(200);
    const replays = { a: await store.listSkillEvalReplays("old"), b: await store.listSkillEvalReplays("new") };
    expect(r.value).toEqual(JSON.parse(JSON.stringify(compareSkillEvalRuns((await store.getSkillEvalRun("old"))!, (await store.getSkillEvalRun("new"))!, replays))));
    expect(r.value).toMatchObject({ a: { run_id: "old", pass_rate: null }, b: { run_id: "new", pass_rate: 0.5 }, verdict: null });
    for (const k of ["gap", "noise_band", "within_noise"]) expect(r.value).not.toHaveProperty(k);
    expect(calls.filter((c) => c === "listSkillEvalReplays")).toHaveLength(2);
    expect(await tables(store)).toEqual(before);
  });

  it("pairs both runs' stored replays case by case", async () => {
    const store = await seeded();
    for (const id of ["pa", "pb"]) await store.startSkillEvalRun({ id, suite_id: "s1", created_by: OWNER, judge_version: "j1" });
    for (const [run_id, case_id, verdict] of [["pa", "c1", "fail"], ["pa", "c2", "pass"], ["pb", "c1", "pass"], ["pb", "c2", "pass"], ["pb", "c3", "fail"]] as const) {
      await store.recordSkillEvalReplay({ run_id, case_id, replay: 1, verdict, detail: {} });
    }
    const r = await get(store, CLEAN, path("pa", "pb"));
    expect(r.value).toMatchObject({ comparable: true, paired: 2, wins: 1, losses: 0, ties: 1, p_value: 1, mean_difference: 0.5, verdict: "within noise" });
  });

  it("is a 404 for an unknown run or one of another skill, and a 400 without both runs", async () => {
    const store = await seeded();
    expect((await get(store, CLEAN, path("old", "nope"))).status).toBe(404);
    expect((await get(store, CLEAN, path("old", "elsewhere"))).status).toBe(404);
    expect((await get(store, CLEAN, `/api/v1/evals/${encodeURIComponent(SKILL)}/compare?a=old`)).status).toBe(400);
  });
});

describe("GET /api/v1/evals", () => {
  it("lists the distinct skill_refs of every suite, sorted, and no held version when none is held, and writes nothing", async () => {
    const store = await seeded();
    await store.createSkillEvalSuite({ id: "s3", skill_ref: SKILL, title: "again", created_by: OWNER });
    const { proxy, calls } = watched(store);
    const r = await get(proxy, CLEAN, "/api/v1/evals");
    expect(r.status).toBe(200);
    expect(r.value).toMatchObject({ skills: ["skills/other", SKILL], held: [] });
    expect(calls).toEqual(["listSkillEvalSuites", "listHeldSkillVersionGates"]);
  });

  it("withholds a flagged ref", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/LEAK", title: "t", created_by: OWNER });
    const r = await get(store, FLAGGING, "/api/v1/evals");
    expect(JSON.stringify(r.value)).not.toContain("LEAK");
    expect((r.value as { skills: string[] }).skills[0]).toMatch(/^\[withheld: /);
  });
});
