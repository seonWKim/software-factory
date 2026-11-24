import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { SkillEvalRunFn as RunFn } from "../src/cli/command.js";
import { compareSkillEvalRuns, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Loaded } from "../src/load-config.js";
import { skillEvalAuthoring } from "../src/skill-evals.js";
import { newStore } from "./helpers/store.js";

// `factory eval run <skill>` and `factory eval results <skill> --json` over a test store. The run function is the
// command call's (main.ts passes src/skill-evals.ts skillEvalRun); here it is a fake that stores a run as the wiring
// does, so no model is called. The grid and compare are the real ones (src/core/skill-eval-compare.ts), as main.ts
// passes them.

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const ENV = async () => ({ gitEmail: "owner@example.com", osUser: null });
const READS = { grid: skillEvalGrid, compare: compareSkillEvalRuns };

afterEach(() => vi.restoreAllMocks());

/** Runs the real `eval` command over `store` (kept open after it), with `runSkillEval` (and the grid and compare) on the call. */
async function evalCommand(store: FactoryStore, args: string[], runSkillEval?: RunFn, reads: typeof READS | null = READS) {
  const dir = mkdtempSync(join(tmpdir(), "sf-eval-"));
  const loaded = { root: dir, stateDir: dir, file: {}, config: {} } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  const cmd = (await loadCommands()).get("eval")!;
  const code = await cmd.run(args, { name: "eval", authoring: skillEvalAuthoring, usage: "", load: async () => loaded, environment: ENV, openStore: async () => kept, ...(runSkillEval ? { runSkillEval } : {}), ...(reads ? { skillEvalReads: reads } : {}) });
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

/** A finished run of suite s1 with its skill version and figures. */
async function storedRun(store: FactoryStore, id: string, f: { version: string; model: string; pass_rate: number | null; replays: number; judge_version?: string }) {
  await store.startSkillEvalRun({ id, suite_id: "s1", created_by: OWNER, skill_version: f.version, judge_version: f.judge_version ?? "j1" });
  await store.finishSkillEvalRun(id, "failed");
  await store.recordSkillEvalRunFigures(id, { model_class: f.model, judge_model_class: f.model === "strong" ? "standard" : "strong", replays: f.replays, pass_rate: f.pass_rate, errored: 0 });
}

describe("factory eval run options", () => {
  it("passes --model, --judge-model and --replays to the run; with none it passes none, so the run keeps its defaults", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const run = vi.fn(fakeRun("r1", "passed"));
    await evalCommand(store, ["run", SKILL, "--model", "strong", "--judge-model", "standard", "--replays", "1"], run);
    expect(run.mock.calls[0]![2]).toMatchObject({ skill: SKILL, model_class: "strong", judge_model_class: "standard", replays: 1 });
    const plain = vi.fn(fakeRun("r2", "passed"));
    await evalCommand(store, ["run", SKILL], plain);
    expect(Object.keys(plain.mock.calls[0]![2]).sort()).toEqual(["created_by", "signal", "skill"]);
  });

  it("prints the run's refusal of an option and exits 1; a --replays that is no whole number or a valueless flag is a usage error", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const refusing: RunFn = async () => ({ refused: "--replays 3: a run stores one verdict per case, so it replays each case once: nothing run" });
    const r = await evalCommand(store, ["run", SKILL, "--replays", "3"], refusing);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("one verdict per case");
    const run = vi.fn(fakeRun("r1", "passed"));
    for (const bad of [["--replays", "two"], ["--replays", "0"], ["--model"], ["--judge-model", "--json"], ["--other", "x"]]) {
      expect((await evalCommand(store, ["run", SKILL, ...bad], run)).code).toBe(1);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("factory eval results --by version,model", () => {
  async function seeded() {
    const { store, clock } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "no-figures", suite_id: "s1", created_by: OWNER });
    clock.advance(1000);
    await storedRun(store, "v1-std-old", { version: "v1", model: "standard", pass_rate: 0.25, replays: 4 });
    clock.advance(1000);
    await storedRun(store, "v1-std", { version: "v1", model: "standard", pass_rate: 0.5, replays: 4 });
    clock.advance(1000);
    await storedRun(store, "v1-cheap", { version: "v1", model: "cheap", pass_rate: 0.75, replays: 4 });
    clock.advance(1000);
    await storedRun(store, "v2-std", { version: "v2", model: "standard", pass_rate: 1, replays: 4 });
    return store;
  }

  it("--json prints one row per skill version and model class with its newest run's pass rate; runs without figures are left out", async () => {
    const store = await seeded();
    const r = await evalCommand(store, ["results", SKILL, "--by", "version,model", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out.join("\n")) as Record<string, unknown>[];
    expect(rows.map((x) => [x.skill_version, x.model_class, x.run_id, x.pass_rate])).toEqual([["v2", "standard", "v2-std", 1], ["v1", "cheap", "v1-cheap", 0.75], ["v1", "standard", "v1-std", 0.5]]);
    expect(rows).toEqual(JSON.parse(JSON.stringify(skillEvalGrid(await store.listSkillEvalRuns(SKILL)))));
  });

  it("prints the same rows as lines without --json; refuses another --by and a call without the grid", async () => {
    const store = await seeded();
    const r = await evalCommand(store, ["results", SKILL, "--by", "version,model"]);
    expect(r.out[0]).toMatch(/skill version v2 {2}model standard {2}pass rate 1\.00 {2}replays 4 {2}\(run v2-std, /);
    expect(r.out.filter((l) => l.includes("no-figures"))).toEqual([]);
    expect((await evalCommand(store, ["results", SKILL, "--by", "model"])).code).toBe(1);
    expect((await evalCommand(store, ["results", SKILL, "--by", "version,model"], undefined, null)).code).toBe(1);
  });
});

describe("factory eval compare", () => {
  async function two(a: number | null, b: number | null) {
    const { store, clock } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await storedRun(store, "ra", { version: "v1", model: "standard", pass_rate: a, replays: a === null ? 0 : 4 });
    clock.advance(1000);
    await storedRun(store, "rb", { version: "v2", model: "standard", pass_rate: b, replays: b === null ? 0 : 4 });
    return store;
  }

  it("--json prints both pass rates, the gap, the noise band and whether it is within noise", async () => {
    const store = await two(0.5, 0.75);
    const r = await evalCommand(store, ["compare", "ra", "rb", "--json"]);
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out.join("\n")) as Record<string, unknown>;
    expect(c).toEqual(JSON.parse(JSON.stringify(compareSkillEvalRuns((await store.getSkillEvalRun("ra"))!, (await store.getSkillEvalRun("rb"))!))));
    expect(c).toMatchObject({ a: { run_id: "ra", pass_rate: 0.5 }, b: { run_id: "rb", pass_rate: 0.75 }, within_noise: true });
    expect(c.gap).toBeCloseTo(0.25, 12);
  });

  it("prints the gap and the band as lines; a null pass rate gives no comparison", async () => {
    const r = await evalCommand(await two(0.5, 0.75), ["compare", "ra", "rb"]);
    expect(r.out.join("\n")).toMatch(/gap \+0\.25, noise band 0\.\d\d: within noise/);
    const none = await evalCommand(await two(null, 0.75), ["compare", "ra", "rb"]);
    expect(none.code).toBe(0);
    expect(none.out.join("\n")).toContain("no comparison");
    expect(JSON.parse((await evalCommand(await two(null, 0.75), ["compare", "ra", "rb", "--json"])).out.join("\n"))).toMatchObject({ gap: null, noise_band: null, within_noise: null });
  });

  it("prints not comparable, with the reason and no gap, when the runs' judge versions differ", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await storedRun(store, "ra", { version: "v1", model: "standard", pass_rate: 0.5, replays: 4 });
    await storedRun(store, "rb", { version: "v1", model: "standard", pass_rate: 0.75, replays: 4, judge_version: "j2" });
    const r = await evalCommand(store, ["compare", "ra", "rb"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("not comparable: the judge versions differ");
    expect(r.out.join("\n")).not.toContain("gap");
    expect(JSON.parse((await evalCommand(store, ["compare", "ra", "rb", "--json"])).out.join("\n"))).toMatchObject({
      comparable: false, reason: "the judge versions differ", gap: null, noise_band: null, within_noise: null,
    });
  });

  it("exits 1 naming an unknown run, and on a missing run id; it writes nothing", async () => {
    const store = await two(0.5, 0.75);
    const before = await store.db.all("SELECT * FROM controller_skill_eval_runs");
    const r = await evalCommand(store, ["compare", "ra", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("nope");
    expect((await evalCommand(store, ["compare", "ra"])).code).toBe(1);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_runs")).toEqual(before);
  });
});

describe("factory eval usage", () => {
  it("lists the suite and case commands on a bad argument", async () => {
    const { store } = await newStore();
    const r = await evalCommand(store, ["other"]);
    expect(r.code).toBe(1);
    const text = r.err.join("\n");
    expect(text).toContain("eval suite list|add|rename|delete");
    expect(text).toContain("eval case list|add|edit|delete|try");
  });
});
