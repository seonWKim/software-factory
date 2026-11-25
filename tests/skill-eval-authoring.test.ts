import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { SkillEvalTryFn } from "../src/cli/command.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { skillEvalAuthoring, tryCaseFor, type SkillEvalWiring } from "../src/skill-evals.js";
import type { Loaded } from "../src/load-config.js";
import { type SkillJudgeFn, type SkillReplay, tryCase } from "../src/runtime/index.js";
import { newStore } from "./helpers/store.js";

// Suites and cases from the CLI: the store's update and delete, the authoring rules and `case try`, over a test
// store with a fake replay and a fake judge. No test calls a model.

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const ENV = async () => ({ gitEmail: "owner@example.com", osUser: null });
const dir = mkdtempSync(join(tmpdir(), "sf-authoring-"));

afterEach(() => vi.restoreAllMocks());

async function evalCommand(store: FactoryStore, args: string[], trySkillEvalCase?: SkillEvalTryFn) {
  const loaded = { root: dir, stateDir: dir, file: {}, config: {} } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  const cmd = (await loadCommands()).get("eval")!;
  const code = await cmd.run(args, { name: "eval", usage: "", load: async () => loaded, environment: ENV, authoring: skillEvalAuthoring, openStore: async () => kept, ...(trySkillEvalCase ? { trySkillEvalCase } : {}) });
  vi.restoreAllMocks();
  return { code, out, err };
}

async function withSuite() {
  const { store, clock } = await newStore();
  expect((await evalCommand(store, ["suite", "add", SKILL])).code).toBe(0);
  const [suite] = await store.listSkillEvalSuites();
  return { store, clock, suite: suite! };
}

const rows = (store: Awaited<ReturnType<typeof newStore>>["store"], table: string) => store.db.all(`SELECT * FROM ${table}`);

describe("eval suite", () => {
  it("adds one suite per skill (title defaults to the skill), lists, renames", async () => {
    const { store, suite } = await withSuite();
    expect(suite).toMatchObject({ skill_ref: SKILL, title: SKILL, created_by: "local:owner@example.com" });
    const again = await evalCommand(store, ["suite", "add", SKILL, "--title", "x"]);
    expect(again.code).toBe(1);
    expect(await store.listSkillEvalSuites()).toHaveLength(1);
    expect((await evalCommand(store, ["suite", "rename", SKILL, "Renamed"])).code).toBe(0);
    expect((await evalCommand(store, ["suite", "list"])).out).toEqual([`${SKILL}  Renamed`]);
    expect((await evalCommand(store, ["suite", "rename", "skills/none", "t"])).code).toBe(1);
  });

  it("refuses a delete, writing nothing, while a run is running", async () => {
    const { store, suite } = await withSuite();
    await evalCommand(store, ["case", "add", SKILL, "--input", "hi", "--check", "says hi"]);
    await store.startSkillEvalRun({ id: "r1", suite_id: suite.id, created_by: OWNER });
    const r = await evalCommand(store, ["suite", "delete", SKILL]);
    expect(r.code).toBe(1);
    expect(await store.listSkillEvalSuites()).toHaveLength(1);
    expect(await store.listSkillEvalCases(suite.id)).toHaveLength(1);
  });

  it("says how many runs keep their history, deletes the suite and its cases, and keeps the runs", async () => {
    const { store, suite } = await withSuite();
    await evalCommand(store, ["case", "add", SKILL, "--input", "hi", "--check", "says hi"]);
    await store.startSkillEvalRun({ id: "r1", suite_id: suite.id, created_by: OWNER });
    await store.finishSkillEvalRun("r1", "passed");
    const r = await evalCommand(store, ["suite", "delete", SKILL]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("1 run keep their history");
    expect(await store.listSkillEvalSuites()).toEqual([]);
    expect(await rows(store, "controller_skill_eval_cases")).toEqual([]);
    expect(await rows(store, "controller_skill_eval_runs")).toHaveLength(1);
  });

  it("refuses a delete in the store when a run is running, deleting nothing", async () => {
    const { store, suite } = await withSuite();
    await store.startSkillEvalRun({ id: "r1", suite_id: suite.id, created_by: OWNER });
    expect(await store.deleteSkillEvalSuite(suite.id)).toBe("running");
    expect(await store.deleteSkillEvalSuite("nope")).toBe("unknown");
    expect(await store.listSkillEvalSuites()).toHaveLength(1);
  });
});

describe("eval case", () => {
  it("adds from flags and from --file, lists, edits (unset fields keep their value) and deletes", async () => {
    const { store, suite } = await withSuite();
    expect((await evalCommand(store, ["case", "add", SKILL, "--input", "hi", "--check", "a", "--check", "b"])).code).toBe(0);
    const file = join(dir, "case.json");
    writeFileSync(file, JSON.stringify({ input: { q: 1 }, expected: { checks: ["c"] } }));
    expect((await evalCommand(store, ["case", "add", SKILL, "--file", file])).code).toBe(0);
    const all = await store.listSkillEvalCases(suite.id);
    const c1 = all.find((c) => c.input === "hi")!, c2 = all.find((c) => c.input !== "hi")!;
    expect(c1).toMatchObject({ input: "hi", expected: ["a", "b"] });
    expect(c2).toMatchObject({ input: { q: 1 }, expected: { checks: ["c"] } });
    expect((await evalCommand(store, ["case", "list", SKILL])).out).toHaveLength(2);

    expect((await evalCommand(store, ["case", "edit", c1!.id, "--check", "z"])).code).toBe(0);
    expect(await store.getSkillEvalCase(c1!.id)).toMatchObject({ input: "hi", expected: ["z"] });
    expect((await evalCommand(store, ["case", "edit", c1!.id, "--input", "new"])).code).toBe(0);
    expect(await store.getSkillEvalCase(c1!.id)).toMatchObject({ input: "new", expected: ["z"] });

    expect((await evalCommand(store, ["case", "delete", c1!.id])).code).toBe(0);
    expect(await store.getSkillEvalCase(c1!.id)).toBeNull();
    expect((await evalCommand(store, ["case", "delete", c1!.id])).code).toBe(1);
  });

  it("refuses a case whose expected is not rubric checks, writing nothing", async () => {
    const { store, suite } = await withSuite();
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ input: "x", expected: "just text" }));
    expect((await evalCommand(store, ["case", "add", SKILL, "--file", file])).code).toBe(1);
    expect((await evalCommand(store, ["case", "add", SKILL, "--input", "x"])).code).toBe(1);
    expect(await store.listSkillEvalCases(suite.id)).toEqual([]);
    await evalCommand(store, ["case", "add", SKILL, "--input", "x", "--check", "ok"]);
    const [c] = await store.listSkillEvalCases(suite.id);
    writeFileSync(file, JSON.stringify({ expected: [] }));
    expect((await evalCommand(store, ["case", "edit", c!.id, "--file", file])).code).toBe(1);
    expect((await store.getSkillEvalCase(c!.id))!.expected).toEqual(["ok"]);
  });

  it("refuses a check of an unknown kind, a rubric with a missing anchor and a weight below 0, writing nothing; takes well-formed check objects", async () => {
    const { store, suite } = await withSuite();
    const file = join(dir, "kinds.json");
    const anchors = { "1": "none", "2": "little", "3": "some", "4": "most", "5": "all" };
    const { "3": _missing, ...noThree } = anchors;
    const refused = async (expected: unknown) => {
      writeFileSync(file, JSON.stringify({ input: "x", expected }));
      const r = await evalCommand(store, ["case", "add", SKILL, "--file", file]);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("nothing written");
      return r.err.join("\n");
    };
    expect(await refused([{ kind: "sounds nice" }])).toContain("unknown check kind");
    expect(await refused([{ kind: "rubric", criterion: "clear", anchors: noThree }])).toContain("no anchor for level 3");
    expect(await refused([{ kind: "contains", value: "hi", weight: -1 }])).toContain("weight");
    expect(await refused({ checks: ["ok"], threshold: 2 })).toContain("threshold");
    expect(await store.listSkillEvalCases(suite.id)).toEqual([]);

    const good = { checks: ["says hi", { kind: "contains", value: "hi" }, { kind: "rubric", criterion: "clear", anchors, weight: 2 }, { kind: "pairwise", criterion: "better" }], threshold: 0.5 };
    writeFileSync(file, JSON.stringify({ input: "x", expected: good }));
    expect((await evalCommand(store, ["case", "add", SKILL, "--file", file])).code).toBe(0);
    const [c] = await store.listSkillEvalCases(suite.id);
    expect(c!.expected).toEqual(good);
    writeFileSync(file, JSON.stringify({ expected: [{ kind: "regex", pattern: "(" }] }));
    expect((await evalCommand(store, ["case", "edit", c!.id, "--file", file])).code).toBe(1);
    expect((await store.getSkillEvalCase(c!.id))!.expected).toEqual(good);
  });
});

describe("eval case try", () => {
  const replay: SkillReplay = async () => ({ output: "output" });
  const yesNo: SkillJudgeFn = async (s) => s.checks.map((c, i) => ({ answer: i === 0 ? "yes" : "no", reason: `because ${c}` }));

  it("prints each check and the verdict, and writes no run and no replay", async () => {
    const { store, suite } = await withSuite();
    await evalCommand(store, ["case", "add", SKILL, "--input", "hi", "--check", "one", "--check", "two"]);
    const [c] = await store.listSkillEvalCases(suite.id);
    const call: SkillEvalTryFn = async (s, _l, r) => tryCase({ store: s, replay, judge: yesNo, scan: async () => [] }, r.case_id, r.signal);
    const fn = vi.fn(call);
    const r = await evalCommand(store, ["case", "try", c!.id, "--model", "cheap"], fn);
    expect(fn).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ case_id: c!.id, model_class: "cheap" }));
    expect(r.out).toEqual(["yes  one  because one", "no  two  because two", "score: 0.50 (threshold 1)", "verdict: fail"]);
    expect(r.code).toBe(1);
    expect(await rows(store, "controller_skill_eval_runs")).toEqual([]);
    expect(await rows(store, "controller_skill_eval_replays")).toEqual([]);
    await evalCommand(store, ["case", "try", c!.id], fn);
    expect(fn).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ model_class: "standard" }));
  });

  it("exits 0 on pass, withholds a flagged reason, reports errored, and refuses an unknown case or model", async () => {
    const { store, suite } = await withSuite();
    await evalCommand(store, ["case", "add", SKILL, "--input", "hi", "--check", "one"]);
    const [c] = await store.listSkillEvalCases(suite.id);
    const pass = (scan: boolean, judge: SkillJudgeFn = async (s) => s.checks.map(() => ({ answer: "yes" as const, reason: "r" }))): SkillEvalTryFn => async (s, _l, r) => tryCase({ store: s, replay, judge, scan: async () => (scan ? [] : ["known_secret"]) }, r.case_id, r.signal);
    const ok = await evalCommand(store, ["case", "try", c!.id], pass(true));
    expect(ok.code).toBe(0);
    expect(ok.out.at(-1)).toBe("verdict: pass");
    expect((await evalCommand(store, ["case", "try", c!.id], pass(false))).out[0]).toContain("(withheld by the egress scan)");
    const errored = await evalCommand(store, ["case", "try", c!.id], pass(true, async () => null));
    expect(errored.out.at(-1)).toBe("verdict: errored");
    expect(errored.code).toBe(1);
    expect((await evalCommand(store, ["case", "try", "nope"], pass(true))).code).toBe(1);
    const wiring = { store } as unknown as SkillEvalWiring;
    expect(await tryCaseFor(wiring, { case_id: c!.id, model_class: "huge", signal: new AbortController().signal })).toEqual({ refused: expect.stringContaining("--model") });
    expect((await evalCommand(store, ["case", "try", c!.id])).code).toBe(1);
  });
});
