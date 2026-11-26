// POST /api/v1/evals/write and GET /api/v1/evals/<skill>/suite (src/ui/evals-write-api.ts, evals-api.ts): the dashboard's
// skill-eval writes behind the request guards (Origin, Content-Type, CSRF token, body) and the approve_spec owner check,
// through the CLI's authoring and import rules; import and try use the eval source the `integrations` entry names, else
// plugins.eval_source, built for each call. The eval source and the try are fakes: no replay or CLI runs here.

import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { addSkillEvalCase, addSkillEvalSuite, caseFromRun, deleteSkillEvalSuite, editSkillEvalCase, renameSkillEvalSuite } from "../src/runtime/index.js";
import { type ImportSource, importSkillEvalCases } from "../src/runtime/skill-evals/import.js";
import { EVALS_WRITE_PATH, type UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:alice" as UserId;
const OTHER = "local:bob" as UserId;
const SKILL = "skills/tests-first";
const RUBRIC = ["names the failing test"];
/** Flags any text holding LEAK. */
const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

/** A source with one case, `G-1`; `none` is off. */
const fakeSource: ImportSource = { enabled: true, listCases: async () => [{ id: "G-1", input: "write a test", expected: RUBRIC }] };
const noSource: ImportSource = { enabled: false, listCases: async () => [] };

async function setup(opts: { configured?: string; user?: UserId; scanner?: EgressScanner } = {}) {
  const clock = new FakeClock("2026-11-24T08:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => opts.user ?? OWNER,
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: silent,
  };
  let n = 0;
  const newId = () => `id${++n}`;
  const tries: string[] = [];
  const opened: string[] = [];
  const registered = ["none", "fake"];
  const open = async (name: string) => (opened.push(name), name === "fake" ? fakeSource : noSource);
  const evals: UiEvals = {
    authoring: {
      // As main.ts's importCases: `source` is the name the switch chose.
      importCases: (s, r) => importSkillEvalCases({ store: s, selected: undefined, registered, open, scanner: async () => cleanScanner }, r),
      addSuite: (s, r) => addSkillEvalSuite({ store: s, newId }, r),
      renameSuite: renameSkillEvalSuite,
      deleteSuite: deleteSkillEvalSuite,
      addCase: (s, skill, f) => addSkillEvalCase({ store: s, newId }, skill, f),
      editCase: editSkillEvalCase,
      caseFromRun,
    },
    tryCase: async (_s, r) => (tries.push(r.case_id), { value: { verdict: "pass", checks: [{ check: RUBRIC[0]!, answer: "yes", reason: "ok" }], error: null } }),
    source: {
      configured: opts.configured,
      registered,
      settings: new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent }),
      open,
    },
  };
  const d = { store, clock, scanner: opts.scanner ?? cleanScanner, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const write = async (body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, { method: "POST", url: EVALS_WRITE_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const read = async (skill = SKILL) => {
    const r = await respond(d, { method: "GET", url: `/api/v1/evals/${encodeURIComponent(skill)}/suite`, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) as { suite: Record<string, unknown> | null; cases: Record<string, unknown>[] } };
  };
  const switchTo = (value: unknown) => store.setSettingOverride({ key: "integrations", project: "", value: JSON.stringify(value), actor: OWNER });
  /** Every row of the eval tables, to show a refusal wrote nothing. */
  const tables = () => Promise.all(["runs", "suites", "cases", "replays"].map((t) => store.db.all(`SELECT * FROM controller_skill_eval_${t}`)));
  return { d, store, clock, token, write, read, switchTo, tables, tries, opened };
}

/** A suite for SKILL with one case `c1`. */
async function seeded(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  await s.store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "Tests first", created_by: OWNER });
  await s.store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "first", expected: RUBRIC });
  return s;
}

describe("POST /api/v1/evals/write: suites", () => {
  it("adds a suite as the page's user, then renames it", async () => {
    const s = await setup();
    const added = await s.write({ op: "suite.add", skill: SKILL, title: "TF" });
    expect(added.status).toBe(200);
    expect(added.value).toMatchObject({ op: "suite.add", suite: { skill_ref: SKILL, title: "TF" } });
    expect((await s.store.listSkillEvalSuites()).map((x) => [x.skill_ref, x.title, x.created_by])).toEqual([[SKILL, "TF", OWNER]]);
    const renamed = await s.write({ op: "suite.rename", skill: SKILL, title: "Tests first" });
    expect(renamed).toMatchObject({ status: 200, value: { op: "suite.rename", suite: { title: "Tests first" } } });
  });

  it("refuses a second suite for the skill with a 409, writing nothing", async () => {
    const s = await seeded();
    const before = await s.tables();
    const r = await s.write({ op: "suite.add", skill: SKILL });
    expect(r.status).toBe(409);
    expect(r.value.error).toMatch(/already has a suite/);
    expect(await s.tables()).toEqual(before);
  });

  it("refuses to delete a suite while one of its runs is running, writing nothing", async () => {
    const s = await seeded();
    await s.store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    const before = await s.tables();
    const r = await s.write({ op: "suite.delete", skill: SKILL });
    expect(r.status).toBe(409);
    expect(r.value.error).toMatch(/running/);
    expect(await s.tables()).toEqual(before);
  });

  it("deletes a suite with no running run: reports the runs that keep their history, removes the suite and its cases, keeps the runs unlisted", async () => {
    const s = await seeded();
    for (const id of ["r1", "r2"]) {
      await s.store.startSkillEvalRun({ id, suite_id: "s1", created_by: OWNER });
      await s.store.finishSkillEvalRun(id, "passed");
    }
    const r = await s.write({ op: "suite.delete", skill: SKILL });
    expect(r).toEqual({ status: 200, value: { op: "suite.delete", skill: SKILL, runs: 2 } });
    expect(await s.store.listSkillEvalSuites()).toEqual([]);
    expect(await s.store.getSkillEvalCase("c1")).toBeNull();
    expect(await s.store.listSkillEvalRuns(SKILL)).toEqual([]);
    expect((await s.store.getSkillEvalRun("r1"))?.id).toBe("r1");
    expect((await s.store.getSkillEvalRun("r2"))?.id).toBe("r2");
  });
});

describe("POST /api/v1/evals/write: cases", () => {
  it("adds, edits and deletes a case through the CLI's rules", async () => {
    const s = await seeded();
    const added = await s.write({ op: "case.add", skill: SKILL, input: "second", expected: RUBRIC });
    expect(added).toMatchObject({ status: 200, value: { op: "case.add", case: { suite_id: "s1", input: "second", expected: RUBRIC } } });
    const id = (added.value.case as { id: string }).id;
    const edited = await s.write({ op: "case.edit", case: id, input: "changed" });
    expect(edited).toMatchObject({ status: 200, value: { op: "case.edit", case: { id, input: "changed", expected: RUBRIC } } });
    expect(await s.write({ op: "case.delete", case: id })).toEqual({ status: 200, value: { op: "case.delete", case: id } });
    expect(await s.store.getSkillEvalCase(id)).toBeNull();
    expect((await s.write({ op: "case.delete", case: id })).status).toBe(409);
  });

  it("refuses a case whose expected value is no rubric, writing nothing", async () => {
    const s = await seeded();
    const before = await s.tables();
    const r = await s.write({ op: "case.add", skill: SKILL, input: "x", expected: 42 });
    expect(r.status).toBe(409);
    expect(await s.tables()).toEqual(before);
  });

  it("answers 400 for an unknown op or a missing field, before any write", async () => {
    const s = await seeded();
    const before = await s.tables();
    expect((await s.write({ op: "suite.explode", skill: SKILL })).status).toBe(400);
    expect((await s.write({ op: "suite.rename", skill: SKILL })).status).toBe(400);
    expect((await s.write({ op: "case.edit" })).status).toBe(400);
    expect((await s.write(["suite.add"])).status).toBe(400);
    expect(await s.tables()).toEqual(before);
  });
});

describe("POST /api/v1/evals/write: case.from_run", () => {
  const REFUSAL = "That case has no failed replay in that run: nothing written.";
  /** c1 (seed and MCP servers set) failed once in run r1; c2 passed. */
  async function failedRun(o: Parameters<typeof setup>[0] = {}) {
    const s = await seeded(o);
    await s.store.addSkillEvalCase({ id: "c1x", suite_id: "s1", input: { prompt: "in" }, expected: RUBRIC, seed: "seeds/one", mcp: ["files"], split: "held-out" });
    await s.store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "other", expected: RUBRIC });
    await s.store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    await s.store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1x", replay: 1, verdict: "fail", detail: {} });
    await s.store.recordSkillEvalReplay({ run_id: "r1", case_id: "c2", replay: 1, verdict: "pass", detail: {} });
    await s.store.finishSkillEvalRun("r1", "failed");
    return s;
  }
  const others = async (s: Awaited<ReturnType<typeof setup>>) => (await s.store.listSkillEvalCases("s1")).filter((c) => !["c1", "c1x", "c2"].includes(c.id));

  it("adds one dev case copying a failed case's input, expected, seed and MCP servers, answering its id", async () => {
    const s = await failedRun();
    const r = await s.write({ op: "case.from_run", run: "r1", case: "c1x" });
    expect(r.status).toBe(200);
    const added = await others(s);
    expect(added).toEqual([expect.objectContaining({ suite_id: "s1", input: { prompt: "in" }, expected: RUBRIC, seed: "seeds/one", mcp: ["files"], split: "dev" })]);
    expect(r.value).toMatchObject({ op: "case.from_run", case: { id: added[0]!.id } });
  });

  it("is safe to run twice: the repeat writes nothing and answers the same case id", async () => {
    const s = await failedRun();
    const first = await s.write({ op: "case.from_run", run: "r1", case: "c1x" });
    const before = await s.tables();
    const again = await s.write({ op: "case.from_run", run: "r1", case: "c1x" });
    expect(again.status).toBe(200);
    expect((again.value.case as { id: string }).id).toBe((first.value.case as { id: string }).id);
    expect(await s.tables()).toEqual(before);
  });

  it("refuses a passed case, an unknown run and an unknown case with a 409 in plain words, writing nothing", async () => {
    const s = await failedRun();
    const before = await s.tables();
    for (const [run, c] of [["r1", "c2"], ["r-none", "c1x"], ["r1", "c-none"]]) {
      const r = await s.write({ op: "case.from_run", run, case: c });
      expect(r.status, `${run} ${c}`).toBe(409);
      expect(r.value.error).toBe(REFUSAL);
    }
    expect(await s.tables()).toEqual(before);
  });

  it("answers 400 without a run or a case, before any write", async () => {
    const s = await failedRun();
    const before = await s.tables();
    for (const body of [{ op: "case.from_run", case: "c1x" }, { op: "case.from_run", run: "r1" }, { op: "case.from_run", run: " ", case: "c1x" }]) {
      expect((await s.write(body)).status).toBe(400);
    }
    expect(await s.tables()).toEqual(before);
  });

  it("passes every string it answers through the Withholder, the refusal too", async () => {
    const s = await failedRun({ scanner: { scan: async (channel, t) => (t.includes("LEAK") || t.includes("failed replay") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) } });
    await s.store.addSkillEvalCase({ id: "c3", suite_id: "s1", input: "LEAK in", expected: RUBRIC });
    await s.store.recordSkillEvalReplay({ run_id: "r1", case_id: "c3", replay: 1, verdict: "fail", detail: {} });
    const ok = await s.write({ op: "case.from_run", run: "r1", case: "c3" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.value)).not.toContain("LEAK");
    const refused = await s.write({ op: "case.from_run", run: "r1", case: "c2" });
    expect(refused).toMatchObject({ status: 409, value: { error: "[withheld: test_rule]" } });
  });
});

describe("POST /api/v1/evals/write: the guards and the owner check", () => {
  const every = [
    { op: "suite.add", skill: "skills/new" }, { op: "suite.rename", skill: SKILL, title: "T" }, { op: "suite.delete", skill: SKILL },
    { op: "case.add", skill: SKILL, input: "x", expected: RUBRIC }, { op: "case.edit", case: "c1", input: "y" }, { op: "case.delete", case: "c1" },
    { op: "case.try", case: "c1" }, { op: "import", skill: SKILL }, { op: "case.from_run", run: "r1", case: "c1" },
  ];

  it("refuses every op without the CSRF token, or with a stale one, and writes nothing", async () => {
    const s = await seeded({ configured: "fake" });
    const before = await s.tables();
    for (const body of every) {
      for (const csrfToken of [undefined, newCsrfToken()]) {
        const r = await s.write(body, { csrfToken });
        expect(r.status, `${String(body.op)} ${String(csrfToken)}`).toBe(403);
        expect(r.value.code).toBe("stale_csrf");
      }
    }
    expect(await s.tables()).toEqual(before);
    expect(s.tries).toEqual([]);
    expect(s.opened).toEqual([]);
  });

  it("refuses another origin and another content type before the token", async () => {
    const s = await seeded();
    const before = await s.tables();
    expect((await s.write(every[0], { origin: "http://evil.example" })).status).toBe(403);
    expect((await s.write(every[0], { contentType: "text/plain" })).status).toBe(415);
    expect(await s.tables()).toEqual(before);
  });

  it("refuses every op with 403 for a page whose factory user lacks approve_spec, and writes nothing", async () => {
    const s = await seeded({ configured: "fake", user: OTHER });
    const before = await s.tables();
    for (const body of every) {
      const r = await s.write(body);
      expect(r.status, String(body.op)).toBe(403);
      expect(r.value.error).toMatch(/approve_spec/);
    }
    expect(await s.tables()).toEqual(before);
    expect(s.tries).toEqual([]);
    expect(s.opened).toEqual([]);
  });
});

describe("POST /api/v1/evals/write: import and try use the eval source switch", () => {
  it("with no integrations entry and no plugins.eval_source, import and try refuse and write nothing", async () => {
    const s = await seeded();
    const before = await s.tables();
    for (const body of [{ op: "import", skill: SKILL }, { op: "case.try", case: "c1" }]) {
      const r = await s.write(body);
      expect(r.status).toBe(409);
      expect(r.value.error).toMatch(/no eval source is on/);
    }
    expect(await s.tables()).toEqual(before);
    expect(s.tries).toEqual([]);
  });

  it("refuses when the source in force is `none`", async () => {
    const s = await seeded({ configured: "none" });
    const before = await s.tables();
    expect((await s.write({ op: "import", skill: SKILL })).value.error).toMatch(/no eval source is on/);
    expect(await s.tables()).toEqual(before);
  });

  it("uses plugins.eval_source with no entry", async () => {
    const s = await seeded({ configured: "fake" });
    const r = await s.write({ op: "import", skill: SKILL });
    expect(r).toEqual({ status: 200, value: { op: "import", skill: SKILL, source: "fake", added: [`import:fake:${SKILL}:G-1`], kept: [] } });
    expect(await s.store.getSkillEvalCase(`import:fake:${SKILL}:G-1`)).toMatchObject({ input: "write a test", expected: RUBRIC });
    const tried = await s.write({ op: "case.try", case: "c1" });
    expect(tried).toMatchObject({ status: 200, value: { op: "case.try", case: "c1", source: "fake", tried: { verdict: "pass" } } });
    expect(s.tries).toEqual(["c1"]);
  });

  it("the integrations entry wins over plugins.eval_source", async () => {
    const s = await seeded({ configured: "none" });
    await s.switchTo({ eval_source: "fake" });
    expect((await s.write({ op: "import", skill: SKILL })).value.source).toBe("fake");
  });

  it("applies a switch on the next import or try, with no restart", async () => {
    const s = await seeded();
    expect((await s.write({ op: "import", skill: SKILL })).status).toBe(409);
    await s.switchTo({ eval_source: "fake" });
    expect((await s.write({ op: "case.try", case: "c1" })).status).toBe(200);
    expect((await s.write({ op: "import", skill: SKILL })).status).toBe(200);
    await s.switchTo({ eval_source: "none" });
    expect((await s.write({ op: "case.try", case: "c1" })).status).toBe(409);
    expect(s.opened).toEqual(["fake", "fake", "fake", "none"]);
  });

  it("refuses a stored name the registry does not hold, writing nothing", async () => {
    const s = await seeded();
    await s.switchTo({ eval_source: "gone" });
    const before = await s.tables();
    const r = await s.write({ op: "import", skill: SKILL });
    expect(r.status).toBe(409);
    expect(r.value.error).toMatch(/unknown eval source "gone"/);
    expect(await s.tables()).toEqual(before);
  });
});

describe("GET /api/v1/evals/<skill>/suite", () => {
  it("returns the skill's suite and its cases, and writes nothing", async () => {
    const s = await seeded();
    const before = await s.tables();
    const r = await s.read();
    expect(r.status).toBe(200);
    expect(r.value.suite).toMatchObject({ id: "s1", skill_ref: SKILL, title: "Tests first" });
    expect(r.value.cases.map((c) => [c.id, c.input, c.expected])).toEqual([["c1", "first", RUBRIC]]);
    expect(await s.tables()).toEqual(before);
  });

  it("is a null suite with no cases for a skill with none", async () => {
    const s = await seeded();
    expect((await s.read("skills/none")).value).toEqual({ suite: null, cases: [] });
  });

  it("passes every string through the Withholder", async () => {
    const s = await seeded({ scanner: FLAGGING });
    await s.store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: { prompt: "LEAK here" }, expected: ["LEAK check"] });
    const r = await s.read();
    expect(JSON.stringify(r.value)).not.toContain("LEAK");
    expect(r.value.cases.find((c) => c.id === "c2")).toMatchObject({ input: { prompt: "[withheld: test_rule]" }, expected: ["[withheld: test_rule]"] });
  });
});
