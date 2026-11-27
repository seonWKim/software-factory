import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { SkillEvalRunFn as RunFn } from "../src/cli/command.js";
import { compareSkillEvalRuns, skillEvalGrid } from "../src/core/skill-eval-compare.js";
import { runStats } from "../src/core/skill-eval-stats.js";
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
const READS = { grid: skillEvalGrid, compare: compareSkillEvalRuns, stats: runStats };

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

/** A fake run function that replays each of cases c1 and c2 `--replays` times and stores the verdicts `verdict` gives. */
function repeatingRun(id: string, verdict: (case_id: string, replay: number) => string): RunFn {
  return async (store, _loaded, r) => {
    const suite = (await store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill)!;
    await store.startSkillEvalRun({ id, suite_id: suite.id, created_by: r.created_by, skill_version: "v1" });
    const n = r.replays ?? 1;
    const verdicts: string[] = [];
    for (let replay = 1; replay <= n; replay++) {
      for (const case_id of ["c1", "c2"]) {
        verdicts.push(verdict(case_id, replay));
        await store.recordSkillEvalReplay({ run_id: id, case_id, replay, verdict: verdicts.at(-1)!, detail: {} });
      }
    }
    await store.finishSkillEvalRun(id, "failed");
    const passes = verdicts.filter((v) => v === "pass").length;
    await store.recordSkillEvalRunFigures(id, { model_class: "standard", judge_model_class: "strong", replays: verdicts.length, pass_rate: passes / verdicts.length, errored: 0 });
    return { run: (await store.getSkillEvalRun(id))! };
  };
}

describe("factory eval run --replays N: pass@1, pass^k and the 95% Wilson interval", () => {
  it("prints pass@1 over the replays, pass^k with k = N and the interval, on eval run and on eval results", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    // c1 passes all 3 replays; c2 fails its second: pass@1 5/6, pass^3 1/2.
    const run = vi.fn(repeatingRun("r1", (c, n) => (c === "c2" && n === 2 ? "fail" : "pass")));
    const r = await evalCommand(store, ["run", SKILL, "--replays", "3"], run);
    expect(run.mock.calls[0]![2]).toMatchObject({ replays: 3 });
    const w = runStats([...Array(5).fill({ case_id: "c", verdict: "pass" }), { case_id: "c", verdict: "fail" }]).interval!;
    const shown = `replays 6, pass rate 0.83, errored 0  (model standard, judge strong, skill version v1)  pass@1 0.83, pass^3 0.50, 95% interval ${w.low.toFixed(2)}-${w.high.toFixed(2)}`;
    expect(r.out.join("\n")).toContain(shown);
    expect((await evalCommand(store, ["results", SKILL])).out[0]).toContain(shown);
  });

  it("accepts 1 to 10; any other --replays exits 1, prints the usage and writes no run and no replay", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const run = vi.fn(repeatingRun("r10", () => "pass"));
    expect((await evalCommand(store, ["run", SKILL, "--replays", "10"], run)).code).toBe(1); // the fake run is stored failed
    expect(run.mock.calls[0]![2]).toMatchObject({ replays: 10 });
    expect((await store.listSkillEvalReplays("r10")).map((x) => x.replay)).toEqual(expect.arrayContaining([1, 10]));
    const refused = vi.fn(repeatingRun("bad", () => "pass"));
    for (const bad of ["0", "11", "100", "-1", "2.5", "01", "ten"]) {
      const r = await evalCommand(store, ["run", SKILL, "--replays", bad], refused);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("usage:");
    }
    expect(refused).not.toHaveBeenCalled();
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs WHERE id = 'bad'")).toEqual([]);
    expect(await store.listSkillEvalReplays("bad")).toEqual([]);
  });

  it("a run stored before replay numbers shows k 1 and pass^1 equal to pass@1", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
    await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", verdict: "pass", detail: {} });
    await store.recordSkillEvalReplay({ run_id: "old", case_id: "c2", verdict: "fail", detail: {} });
    expect((await evalCommand(store, ["results", SKILL])).out[0]).toMatch(/pass@1 0\.50, pass\^1 0\.50, 95% interval 0\.\d\d-0\.\d\d$/);
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

  it("--baseline is a flag with no value passed as baseline: true; without it the run gets no baseline key", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const run = vi.fn(fakeRun("r1", "passed"));
    await evalCommand(store, ["run", SKILL, "--baseline", "--replays", "2"], run);
    expect(run.mock.calls[0]![2]).toMatchObject({ skill: SKILL, baseline: true, replays: 2 });
    const plain = vi.fn(fakeRun("r2", "passed"));
    await evalCommand(store, ["run", SKILL, "--replays", "2"], plain);
    expect(plain.mock.calls[0]![2]).not.toHaveProperty("baseline");
    const results = vi.fn(fakeRun("r3", "passed"));
    expect((await evalCommand(store, ["results", SKILL, "--baseline"], results)).code).toBe(1); // run only
    expect((await evalCommand(store, ["run", "--baseline"], results)).code).toBe(1); // no skill: --baseline takes no value
    expect(results).not.toHaveBeenCalled();
  });

  it("prints the run's refusal of an option and exits 1; a --replays that is no whole number or a valueless flag is a usage error", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    const refusing: RunFn = async () => ({ refused: "--model huge: no such model class; use one of cheap, standard, strong: nothing run" });
    const r = await evalCommand(store, ["run", SKILL, "--model", "huge"], refusing);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("no such model class");
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
  /** Runs ra and rb on suite s1, each case's replays given as its verdicts in `a` and `b`. */
  async function two(a: Record<string, string[]>, b: Record<string, string[]>) {
    const { store, clock } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    for (const [id, cases] of [["ra", a], ["rb", b]] as const) {
      const verdicts = Object.values(cases).flat();
      await storedRun(store, id, { version: id === "ra" ? "v1" : "v2", model: "standard", pass_rate: verdicts.length === 0 ? null : verdicts.filter((v) => v === "pass").length / verdicts.length, replays: verdicts.length });
      for (const [case_id, vs] of Object.entries(cases)) for (const [i, verdict] of vs.entries()) await store.recordSkillEvalReplay({ run_id: id, case_id, replay: i + 1, verdict, detail: {} });
      clock.advance(1000);
    }
    return store;
  }
  const six = (verdict: string) => Object.fromEntries(["c1", "c2", "c3", "c4", "c5", "c6"].map((c) => [c, [verdict, verdict]]));

  it("--json pairs the runs' stored replays: wins, losses, ties, p, the interval and the verdict, and no noise band", async () => {
    const store = await two({ ...six("fail"), "only-a": ["pass"] }, { ...six("pass"), "only-b": ["fail"] });
    const r = await evalCommand(store, ["compare", "ra", "rb", "--json"]);
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out.join("\n")) as Record<string, unknown>;
    const replays = { a: await store.listSkillEvalReplays("ra"), b: await store.listSkillEvalReplays("rb") };
    expect(c).toEqual(JSON.parse(JSON.stringify(compareSkillEvalRuns((await store.getSkillEvalRun("ra"))!, (await store.getSkillEvalRun("rb"))!, replays))));
    expect(c).toMatchObject({ a: { run_id: "ra" }, b: { run_id: "rb" }, paired: 6, wins: 6, losses: 0, ties: 0, mean_difference: 1, interval: { low: 1, high: 1 }, verdict: "better" });
    expect(c.p_value).toBeCloseTo(2 / 64, 12);
    for (const k of ["gap", "noise_band", "within_noise"]) expect(c).not.toHaveProperty(k);
  });

  it("prints wins, losses, ties, p, the interval and the verdict as lines; no case in both runs gives no comparison", async () => {
    const r = await evalCommand(await two({ c1: ["pass", "fail"], c2: ["pass"], c3: ["fail"] }, { c1: ["pass", "pass"], c2: ["fail"], c3: ["fail"] }), ["compare", "ra", "rb"]);
    const out = r.out.join("\n");
    expect(out).toContain("paired cases 3: wins 1, losses 1, ties 1");
    expect(out).toMatch(/sign test p 1\.000, mean difference -0\.17, 95% interval -\d\.\d\d to \+\d\.\d\d: within noise/);
    expect(out).not.toContain("noise band");
    const none = await evalCommand(await two({ c1: ["pass"] }, { c2: ["pass"] }), ["compare", "ra", "rb"]);
    expect(none.code).toBe(0);
    expect(none.out.join("\n")).toContain("no comparison");
    expect(JSON.parse((await evalCommand(await two({}, { c1: ["pass"] }), ["compare", "ra", "rb", "--json"])).out.join("\n"))).toMatchObject({ paired: 0, mean_difference: null, interval: null, verdict: null });
  });

  it("prints not comparable, with the reason and no gap, when the runs' judge versions differ", async () => {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await storedRun(store, "ra", { version: "v1", model: "standard", pass_rate: 0.5, replays: 4 });
    await storedRun(store, "rb", { version: "v1", model: "standard", pass_rate: 0.75, replays: 4, judge_version: "j2" });
    const r = await evalCommand(store, ["compare", "ra", "rb"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("not comparable: the judge versions differ");
    expect(r.out.join("\n")).not.toContain("paired cases");
    expect(JSON.parse((await evalCommand(store, ["compare", "ra", "rb", "--json"])).out.join("\n"))).toMatchObject({
      comparable: false, reason: "the judge versions differ", paired: null, wins: null, p_value: null, interval: null, verdict: null,
    });
  });

  it("exits 1 naming an unknown run, and on a missing run id; it writes nothing", async () => {
    const store = await two({ c1: ["pass"] }, { c1: ["fail"] });
    const before = await store.db.all("SELECT * FROM controller_skill_eval_runs");
    const r = await evalCommand(store, ["compare", "ra", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("nope");
    expect((await evalCommand(store, ["compare", "ra"])).code).toBe(1);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_runs")).toEqual(before);
  });
});

describe("factory eval case split and case from-run", () => {
  /** A suite with case c1 (seed and MCP servers set) and run r1, in which c1 failed once and c2 passed. */
  async function withFailedRun() {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: { prompt: "in" }, expected: ["a"], seed: "seeds/one", mcp: ["files"], split: "held-out" });
    await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "other", expected: ["b"] });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v1" });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", replay: 1, verdict: "pass", detail: {} });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", replay: 2, verdict: "fail", detail: {} });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c2", replay: 1, verdict: "pass", detail: {} });
    await store.finishSkillEvalRun("r1", "failed");
    return store;
  }
  const suiteVersion = async (store: FactoryStore & { db: { all(q: string): Promise<Record<string, unknown>[]> } }) =>
    (await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = 's1'"))[0]!.version;

  it("case split sets one case's split and bumps no suite version; case list shows each case's split", async () => {
    const store = await withFailedRun();
    const v = await suiteVersion(store);
    const r = await evalCommand(store, ["case", "split", "c2", "held-out"]);
    expect(r.code).toBe(0);
    expect(await store.getSkillEvalCase("c2")).toMatchObject({ split: "held-out" });
    expect((await evalCommand(store, ["case", "split", "c2", "dev"])).code).toBe(0);
    expect(await store.getSkillEvalCase("c2")).toMatchObject({ split: "dev" });
    expect(await suiteVersion(store)).toBe(v);
    expect((await evalCommand(store, ["case", "list", SKILL])).out).toEqual([expect.stringMatching(/^c1 {2}held-out /), expect.stringMatching(/^c2 {2}dev /)]);
  });

  it("case split refuses an unknown case and a value other than dev or held-out, changing nothing", async () => {
    const store = await withFailedRun();
    const before = await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id");
    const unknown = await evalCommand(store, ["case", "split", "nope", "dev"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err.join("\n")).toContain("nope");
    expect((await evalCommand(store, ["case", "split", "c2", "test"])).code).toBe(1);
    expect((await evalCommand(store, ["case", "split", "c2"])).code).toBe(1);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id")).toEqual(before);
  });

  it("case from-run adds one new dev case with an id from the run and the case, copying the failed case's input, expected, seed and MCP servers", async () => {
    const store = await withFailedRun();
    const r = await evalCommand(store, ["case", "from-run", "r1", "c1"]);
    expect(r.code).toBe(0);
    const added = (await store.listSkillEvalCases("s1")).filter((c) => c.id !== "c1" && c.id !== "c2");
    expect(added).toEqual([expect.objectContaining({ suite_id: "s1", input: { prompt: "in" }, expected: ["a"], seed: "seeds/one", mcp: ["files"], split: "dev" })]);
    expect(r.out).toEqual([`added case ${added[0]!.id} (dev) from case c1 of eval run r1`]);
    expect(await store.getSkillEvalCase("c1")).toMatchObject({ split: "held-out" });
    const before = await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id");
    const again = await evalCommand(store, ["case", "from-run", "r1", "c1"]);
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toContain(added[0]!.id);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id")).toEqual(before);
  });

  it("case from-run is refused, writing nothing, unless the case has a failed replay in the run", async () => {
    const store = await withFailedRun();
    const before = await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id");
    for (const args of [["r1", "c2"], ["r-none", "c1"], ["r1", "c-none"]]) {
      const r = await evalCommand(store, ["case", "from-run", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toEqual(["That case has no failed replay in that run: nothing written."]);
    }
    expect((await evalCommand(store, ["case", "from-run", "r1"])).code).toBe(1);
    expect(await store.db.all("SELECT * FROM controller_skill_eval_cases ORDER BY id")).toEqual(before);
  });
});

describe("factory eval usage", () => {
  it("lists the suite and case commands on a bad argument", async () => {
    const { store } = await newStore();
    const r = await evalCommand(store, ["other"]);
    expect(r.code).toBe(1);
    const text = r.err.join("\n");
    expect(text).toContain("eval suite list|add|rename|delete");
    expect(text).toContain("eval case list|add|edit|delete|try|split|from-run");
  });
});
