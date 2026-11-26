import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { compareSkillEvalRuns, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { UserId } from "../src/core/types.js";
import { skillStarter } from "../src/core/skill-eval-starter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { LLMProvider, LLMRequest } from "../src/interfaces/llm-provider.js";
import { addSkillEvalCase, addSkillEvalSuite, validateCase } from "../src/runtime/skill-evals/authoring.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { EVALS_WRITE_PATH, type UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { readApi } from "../src/ui/read-routes.js";
import { type ServerDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, silent } from "./helpers/fakes/config.js";
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

// The owner's labels on the judge (design 06-measurement, judge labels; 09-dashboard-evals, Judge checks):
// POST /api/v1/evals/write op label.set behind the request guards and the approve_spec owner check, and
// GET /api/v1/evals/<skill>/calibration.

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const ENC = encodeURIComponent(SKILL);
/** A judged yes/no answer, a deterministic one (never listed) and a rubric answer, as the engine stores them. */
const answers = (yes: string) => [
  { check: yes, answer: "yes", reason: "ok", kind: "yes/no", weight: 1, must: false, value: 1 },
  { check: "contains: hello", answer: "no", reason: "missing", kind: "contains", weight: 1, must: false, value: 0 },
  { check: "Explains why", answer: "no", reason: "thin", kind: "rubric", weight: 1, must: false, value: 0.25, score: 2 },
];

/** seeded() with replays on the newest finished run ("new"), a running run newer than it, and the owner check wired. */
async function labelled(opts: { user?: UserId; scanner?: EgressScanner } = {}) {
  const store = await seeded();
  await store.claimOwner(OWNER);
  await store.recordSkillEvalReplay({ run_id: "new", case_id: "c1", replay: 1, verdict: "pass", detail: { answers: answers("Names a test") } });
  await store.recordSkillEvalReplay({ run_id: "new", case_id: "c2", replay: 1, verdict: "fail", detail: { answers: answers("Says LEAK") } });
  await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", verdict: "pass", detail: { answers: answers("Names a test") } });
  await store.startSkillEvalRun({ id: "busy", suite_id: "s1", created_by: OWNER });
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => opts.user ?? OWNER,
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: silent,
  };
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const evals = { authoring: {}, tryCase: async () => ({ refused: "unused" }), source: {} } as unknown as UiEvals;
  const d = { store, clock, scanner: opts.scanner ?? CLEAN, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const write = async (body: unknown) => {
    const r = await respond(d, { method: "POST", url: EVALS_WRITE_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const calibration = async () => JSON.parse((await respond(d, { method: "GET", url: `/api/v1/evals/${ENC}/calibration`, host: HOST })).body) as Calibration;
  const labels = () => store.db.all("SELECT * FROM controller_skill_eval_labels");
  return { store, write, calibration, labels };
}

interface Calibration {
  labels: number;
  agreement: number | null;
  calibrated: boolean;
  run: string | null;
  checks: { case_id: string; replay: number; check: string; answer: string; label: string | null }[];
}

const LABEL = { op: "label.set", run: "new", case: "c1", replay: 1, check: "Names a test", label: "right" };

describe("POST /api/v1/evals/write: label.set", () => {
  it("stores one label with the page's factory user as owner_id, and a second label on the same check keeps the first", async () => {
    const s = await labelled();
    const r = await s.write(LABEL);
    expect(r).toEqual({ status: 200, value: { op: "label.set", run: "new", case: "c1", replay: 1, check: "Names a test", label: "right" } });
    const again = await s.write({ ...LABEL, label: "wrong" });
    expect(again.value).toMatchObject({ label: "right" });
    const rows = await s.labels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: "new", case_id: "c1", replay: 1, check_text: "Names a test", verdict: "right", owner_id: OWNER });
  });

  it("labels a judged rubric check and a replay stored with no number as replay 0", async () => {
    const s = await labelled();
    expect((await s.write({ ...LABEL, check: "Explains why", label: "wrong" })).status).toBe(200);
    expect((await s.write({ ...LABEL, run: "old", replay: 0 })).status).toBe(200);
    expect((await s.store.listSkillEvalLabels(SKILL)).map((l) => [l.run_id, l.replay, l.check, l.verdict])).toEqual([["new", 1, "Explains why", "wrong"], ["old", 0, "Names a test", "right"]]);
  });

  it.each([
    [{ label: "maybe" }, "label must be right or wrong"],
    [{ label: undefined }, "label must be right or wrong"],
    [{ replay: -1 }, "replay must be a whole number from 0"],
    [{ replay: 1.5 }, "replay must be a whole number from 0"],
    [{ replay: "1" }, "replay must be a whole number from 0"],
    [{ check: " " }, "check must be a non-empty string"],
    [{ run: "" }, "run must be a non-empty string"],
    [{ case: undefined }, "case must be a non-empty string"],
  ])("is a 400 for %o and writes nothing", async (over, error) => {
    const s = await labelled();
    const r = await s.write({ ...LABEL, ...over });
    expect(r.status).toBe(400);
    expect(String(r.value.error)).toContain(error);
    expect(await s.labels()).toEqual([]);
  });

  it.each([
    [{ run: "nope" }, "There is no eval run nope"],
    [{ case: "c9" }, "has no replay in that run"],
    [{ replay: 2 }, "That run has no replay 2"],
    [{ check: "contains: hello" }, "The judge did not answer that check"],
    [{ check: "Never asked" }, "The judge did not answer that check"],
  ])("is a 409 in plain words for %o and writes nothing", async (over, error) => {
    const s = await labelled();
    const r = await s.write({ ...LABEL, ...over });
    expect(r.status).toBe(409);
    expect(String(r.value.error)).toContain(error);
    expect(String(r.value.error)).toContain("nothing was labelled");
    expect(await s.labels()).toEqual([]);
  });

  it("is a 403 without approve_spec, the same owner check as the other evals writes, and writes nothing", async () => {
    const s = await labelled({ user: "local:bob" as UserId });
    const r = await s.write(LABEL);
    expect(r.status).toBe(403);
    expect(String(r.value.error)).toContain("approve_spec");
    expect(await s.labels()).toEqual([]);
  });
});

describe("GET /api/v1/evals/<skill>/calibration", () => {
  it("with no labels: no agreement, not calibrated, and the newest finished run's judged checks unlabelled, writing nothing", async () => {
    const s = await labelled();
    const before = await tables(s.store);
    const c = await s.calibration();
    expect(c).toMatchObject({ labels: 0, agreement: null, calibrated: false, run: "new" });
    expect(c.checks).toEqual([
      { case_id: "c1", replay: 1, check: "Names a test", answer: "yes", reason: "ok", label: null },
      { case_id: "c1", replay: 1, check: "Explains why", answer: "no", reason: "thin", label: null },
      { case_id: "c2", replay: 1, check: "Says LEAK", answer: "yes", reason: "ok", label: null },
      { case_id: "c2", replay: 1, check: "Explains why", answer: "no", reason: "thin", label: null },
    ]);
    expect(await tables(s.store)).toEqual(before);
  });

  it("answers agreement as right labels over all of the skill's labels, judgeCalibrated's verdict, and each check's label", async () => {
    const s = await labelled();
    await s.write(LABEL);
    await s.write({ ...LABEL, check: "Explains why", label: "wrong" });
    await s.write({ ...LABEL, run: "old", replay: 0 });
    const c = await s.calibration();
    expect(c).toMatchObject({ labels: 3, agreement: 2 / 3, calibrated: false });
    expect(c.checks.filter((x) => x.case_id === "c1").map((x) => x.label)).toEqual(["right", "wrong"]);
    for (const check of ["Names a test", "Explains why"]) await s.write({ ...LABEL, case: "c2", check: check === "Names a test" ? "Says LEAK" : check });
    for (const check of ["a", "b"]) await s.store.recordSkillEvalLabel({ run_id: "old", case_id: "c1", replay: 0, check, verdict: "right", owner_id: OWNER });
    expect(await s.calibration()).toMatchObject({ labels: 7, agreement: 6 / 7, calibrated: true });
  });

  it("has no run and no checks when the skill has no finished run", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "busy", suite_id: "s1", created_by: OWNER });
    const r = await get(store, CLEAN, `/api/v1/evals/${ENC}/calibration`);
    expect(r.value).toEqual({ labels: 0, agreement: null, calibrated: false, run: null, checks: [] });
  });

  it("withholds a flagged string", async () => {
    const s = await labelled({ scanner: FLAGGING });
    const c = await s.calibration();
    expect(JSON.stringify(c)).not.toContain("LEAK");
    expect(c.checks.map((x) => x.check)).toContain("[withheld: test_rule]");
  });
});

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
