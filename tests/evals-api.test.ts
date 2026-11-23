import { describe, expect, it } from "vitest";
import { compareSkillEvalRuns, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { UserId } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { readApi } from "../src/ui/read-routes.js";
import type { ServerDeps, UiRequest } from "../src/ui/server.js";
import { newStore } from "./helpers/store.js";

// GET /api/v1/evals/<skill>/runs, /grid and /compare (src/ui/evals-api.ts) through the read route chain: the same
// fields as `factory eval results <skill> [--by version,model] --json` and `factory eval compare --json` (the same
// listSkillEvalRuns, skillEvalGrid and compareSkillEvalRuns), read-only, every stored string through the Withholder.

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const REQ: UiRequest = { method: "GET", url: undefined, host: "127.0.0.1" };
const CLEAN: EgressScanner = { scan: async () => ({ clean: true }) };
/** Flags any text holding LEAK. */
const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

async function seeded() {
  const { store, clock } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/other", title: "o", created_by: OWNER });
  await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
  await store.finishSkillEvalRun("old", "passed");
  clock.advance(1000);
  await store.startSkillEvalRun({ id: "elsewhere", suite_id: "s2", created_by: OWNER });
  clock.advance(1000);
  await store.startSkillEvalRun({ id: "new", suite_id: "s1", created_by: OWNER, skill_version: "LEAK-v2" });
  await store.finishSkillEvalRun("new", "failed");
  await store.recordSkillEvalRunFigures("new", { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0.5, errored: 1 });
  return store;
}

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

const get = (store: FactoryStore, scanner: EgressScanner, path: string) =>
  readApi({ store, scanner } as unknown as ServerDeps, new URL(`http://127.0.0.1${path}`), REQ);

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

/** Every row of the eval tables, to show a read wrote nothing. */
const tables = async (store: Awaited<ReturnType<typeof seeded>>) =>
  Promise.all(["runs", "suites", "cases", "replays"].map((t) => store.db.all(`SELECT * FROM controller_skill_eval_${t}`)));

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

  it("returns the CLI compare --json fields, read by id, writing nothing", async () => {
    const store = await seeded();
    const before = await tables(store);
    const r = await get(store, CLEAN, path("old", "new"));
    expect(r.status).toBe(200);
    expect(r.value).toEqual(JSON.parse(JSON.stringify(compareSkillEvalRuns((await store.getSkillEvalRun("old"))!, (await store.getSkillEvalRun("new"))!))));
    expect(r.value).toMatchObject({ a: { run_id: "old", pass_rate: null }, b: { run_id: "new", pass_rate: 0.5 }, gap: null, noise_band: null, within_noise: null });
    expect(await tables(store)).toEqual(before);
  });

  it("is a 404 for an unknown run or one of another skill, and a 400 without both runs", async () => {
    const store = await seeded();
    expect((await get(store, CLEAN, path("old", "nope"))).status).toBe(404);
    expect((await get(store, CLEAN, path("old", "elsewhere"))).status).toBe(404);
    expect((await get(store, CLEAN, `/api/v1/evals/${encodeURIComponent(SKILL)}/compare?a=old`)).status).toBe(400);
  });
});
