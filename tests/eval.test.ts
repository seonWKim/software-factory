import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { SkillEvalRunFn as RunFn } from "../src/cli/command.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Loaded } from "../src/load-config.js";
import { newStore } from "./helpers/store.js";

// `factory eval run <skill>` and `factory eval results <skill> --json` over a test store. The run function is the
// command call's (main.ts passes src/skill-evals.ts skillEvalRun); here it is a fake that stores a run as the wiring
// does, so no model is called.

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const ENV = async () => ({ gitEmail: "owner@example.com", osUser: null });

afterEach(() => vi.restoreAllMocks());

/** Runs the real `eval` command over `store` (kept open after it), with `runSkillEval` on the call. */
async function evalCommand(store: FactoryStore, args: string[], runSkillEval?: RunFn) {
  const dir = mkdtempSync(join(tmpdir(), "sf-eval-"));
  const loaded = { root: dir, stateDir: dir, file: {}, config: {} } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  const cmd = (await loadCommands()).get("eval")!;
  const code = await cmd.run(args, { name: "eval", usage: "", load: async () => loaded, environment: ENV, openStore: async () => kept, ...(runSkillEval ? { runSkillEval } : {}) });
  vi.restoreAllMocks();
  return { code, out, err };
}

/** A fake run function: stores one finished run of the skill's suite with figures, as the wiring does. */
function fakeRun(id: string, status: "passed" | "failed"): RunFn {
  return async (store, _loaded, r) => {
    const suite = (await store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill);
    if (!suite) return { refused: `no skill eval suite for ${r.skill}: nothing run` };
    await store.startSkillEvalRun({ id, suite_id: suite.id, created_by: r.created_by, skill_version: "v1" });
    await store.finishSkillEvalRun(id, status);
    await store.recordSkillEvalRunFigures(id, { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: status === "passed" ? 1 : 0.5, errored: 0 });
    return { run: (await store.listSkillEvalRuns(r.skill)).find((x) => x.id === id)! };
  };
}

describe("factory eval run", () => {
  it("stores one run through the call's run function, as the CLI identity, and prints its figures", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const run = vi.fn(fakeRun("r1", "passed"));
    const r = await evalCommand(store, ["run", SKILL], run);
    expect(r.code).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ skill: SKILL, created_by: "local:owner@example.com" }));
    expect(r.out.join("\n")).toMatch(/r1 {2}passed {2}replays 2, pass rate 1\.00, errored 0 {2}\(model standard, judge strong, skill version v1\)/);
    const runs = await store.listSkillEvalRuns(SKILL);
    expect(runs).toEqual([expect.objectContaining({ id: "r1", skill_version: "v1", model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 1, errored: 0 })]);
  });

  it("exits 1 on a failed run", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    expect((await evalCommand(store, ["run", SKILL], fakeRun("r1", "failed"))).code).toBe(1);
  });

  it("refuses, naming the skill, when no suite exists for it, and writes no run", async () => {
    const { store } = await newStore();
    const r = await evalCommand(store, ["run", SKILL], fakeRun("r1", "passed"));
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain(SKILL);
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });

  it("refuses with no run function on the call, and on a bad argument", async () => {
    const { store } = await newStore();
    expect((await evalCommand(store, ["run", SKILL])).code).toBe(1);
    expect((await evalCommand(store, ["run"], fakeRun("r1", "passed"))).code).toBe(1);
    expect((await evalCommand(store, ["other", SKILL], fakeRun("r1", "passed"))).code).toBe(1);
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });
});

describe("factory eval results", () => {
  it("--json prints the skill's runs newest first with their figures; an older run's figures are null", async () => {
    const { store, clock } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
    await store.finishSkillEvalRun("old", "passed");
    clock.advance(1000);
    await evalCommand(store, ["run", SKILL], fakeRun("new", "failed"));

    const r = await evalCommand(store, ["results", SKILL, "--json"]);
    expect(r.code).toBe(0);
    const runs = JSON.parse(r.out.join("\n")) as Record<string, unknown>[];
    expect(runs.map((x) => x.id)).toEqual(["new", "old"]);
    expect(runs[0]).toMatchObject({ status: "failed", skill_version: "v1", model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0.5, errored: 0 });
    expect(runs[1]).toMatchObject({ skill_version: null, model_class: null, judge_model_class: null, replays: null, pass_rate: null, errored: null });
    expect(runs).toEqual(await store.listSkillEvalRuns(SKILL));
  });

  it("prints one line per run without --json, and says when there is none", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    expect((await evalCommand(store, ["results", SKILL])).out).toEqual([`no eval runs for ${SKILL}`]);
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    expect((await evalCommand(store, ["results", SKILL])).out[0]).toMatch(/r1 {2}running {2}replays -, pass rate -, errored -/);
  });
});
