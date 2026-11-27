import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { skillStarter } from "../src/core/skill-eval-starter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { LLMProvider, LLMRequest } from "../src/interfaces/llm-provider.js";
import { addSkillEvalCase, addSkillEvalSuite, validateCase } from "../src/runtime/skill-evals/authoring.js";
import { EVALS_WRITE_PATH, type UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { CLEAN, HOST, ORIGIN, OWNER, SKILL, tables } from "./ui-api-fixtures.js";

// Starter drafts (design 07-self-improvement): POST /api/v1/evals/write ops starter.draft and starter.accept, and
// GET /api/v1/evals's `starter`, over a fake model, the CLI's authoring rules and the owner check.

const rubricCheck = (n: number) => ({ kind: "rubric", criterion: `criterion ${n}`, anchors: { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" } });
const starterSet = () => ["edge", "refuse", "typical", "typical", "typical"].map((kind, i) => ({ kind, title: `t${i}`, input: `input ${i}`, expected: { checks: [rubricCheck(i)] } }));

async function starterServer(o: { llm?: LLMProvider | null; cases?: boolean; suite?: boolean; wired?: boolean } = {}) {
  const { store } = await newStore();
  await store.claimOwner(OWNER);
  if (o.suite !== false) await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
  if (o.cases) await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: ["ok"] });
  const calls: LLMRequest[] = [];
  const llm: LLMProvider = { complete: async (req) => (calls.push(req), { text: JSON.stringify({ cases: starterSet() }), stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } }) };
  let n = 0;
  const newId = () => `id${++n}`;
  const authoring = { addSuite: (s: never, r: never) => addSkillEvalSuite({ store: s, newId }, r), addCase: (s: never, skill: string, f: never) => addSkillEvalCase({ store: s, newId }, skill, f) };
  const starter = skillStarter({ llm: o.llm === undefined ? llm : o.llm, scanner: CLEAN, validate: validateCase, prompt: async () => "prompt", readSkill: async () => "# skill" });
  const evals = { authoring, tryCase: async () => ({ refused: "unused" }), source: {}, ...(o.wired !== false && { starter }) } as unknown as UiEvals;
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = { principal: async () => OWNER, authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }), csrfToken: token, log: silent };
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const d = { store, clock, scanner: CLEAN, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const write = async (body: unknown) => {
    const r = await respond(d, { method: "POST", url: EVALS_WRITE_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const list = async () => JSON.parse((await respond(d, { method: "GET", url: "/api/v1/evals", host: HOST })).body) as { starter?: string | null };
  return { store, write, list, calls, tables: () => tables(store as never) };
}

describe("POST /api/v1/evals/write: starter.draft and starter.accept", () => {
  it("drafts the set with one model call and writes nothing", async () => {
    const s = await starterServer();
    const before = await s.tables();
    const r = await s.write({ op: "starter.draft", skill: SKILL });
    expect(r.status).toBe(200);
    expect((r.value.cases as { kind: string }[]).map((c) => c.kind)).toEqual(starterSet().map((c) => c.kind));
    expect(s.calls).toHaveLength(1);
    expect(await s.tables()).toEqual(before);
  });

  it("accepts the whole set in one op, creating the test set first when there is none", async () => {
    const s = await starterServer({ suite: false });
    const r = await s.write({ op: "starter.accept", skill: SKILL, cases: starterSet() });
    expect(r.status).toBe(200);
    const suite = (await s.store.listSkillEvalSuites()).find((x) => x.skill_ref === SKILL)!;
    expect(suite).toBeDefined();
    const cases = await s.store.listSkillEvalCases(suite.id);
    expect(cases.map((c) => c.input)).toEqual(starterSet().map((c) => c.input));
    expect(r.value.added).toEqual(cases.map((c) => c.id));
    expect(s.calls).toEqual([]);
  });

  it("adds the set to an existing empty test set", async () => {
    const s = await starterServer();
    expect((await s.write({ op: "starter.accept", skill: SKILL, cases: starterSet() })).status).toBe(200);
    expect((await s.store.listSkillEvalCases("s1")).map((c) => c.input)).toEqual(starterSet().map((c) => c.input));
  });

  it("refuses a set that breaks a rule and writes nothing, not even the test set", async () => {
    const s = await starterServer({ suite: false });
    const before = await s.tables();
    const noEdge = starterSet().map((c) => ({ ...c, kind: c.kind === "edge" ? "typical" : c.kind }));
    const bad = starterSet().map((c, i) => (i === 2 ? { ...c, expected: [] } : c));
    for (const cases of [noEdge, bad, starterSet().slice(0, 3)]) {
      const r = await s.write({ op: "starter.accept", skill: SKILL, cases });
      expect(r.status).toBe(409);
      expect(String(r.value.error)).toContain("nothing is shown or saved");
    }
    expect(await s.tables()).toEqual(before);
    expect((await s.write({ op: "starter.accept", skill: SKILL })).status).toBe(400);
  });

  it("refuses both for a skill that has cases already", async () => {
    const s = await starterServer({ cases: true });
    for (const op of ["starter.draft", "starter.accept"]) {
      const r = await s.write({ op, skill: SKILL, cases: starterSet() });
      expect(r.status).toBe(409);
      expect(String(r.value.error)).toContain("has cases already");
    }
    expect(s.calls).toEqual([]);
  });

  it("is off with a reason with no model, or with no starter wired; GET /api/v1/evals says why", async () => {
    const on = await starterServer();
    expect((await on.list()).starter).toBeNull();
    const noModel = await starterServer({ llm: null });
    expect((await noModel.list()).starter).toMatch(/^No model is set up/);
    expect((await noModel.write({ op: "starter.draft", skill: SKILL })).status).toBe(409);
    const unwired = await starterServer({ wired: false });
    expect((await unwired.list()).starter).toContain("Add test set still works");
    expect((await unwired.write({ op: "starter.draft", skill: SKILL })).status).toBe(409);
  });
});
