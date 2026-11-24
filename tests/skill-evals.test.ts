// The skill-eval engine (src/runtime/skill-evals/): the replay shared with golden (replayInSandbox), the judge's
// plain completion shared with LlmJudge (judgeCompletion), the all-yes pass rule, and the skill version per run.
// Every runner, sandbox and LLM provider here is a fake: no test calls a model.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmJudge, judgeCompletion, parseCheckAnswers, skillJudge } from "../src/core/scorer.js";
import type { UserId } from "../src/core/types.js";
import { type GoldenRunDeps, runCases } from "../src/golden.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { skillVersion } from "../src/runtime/capabilities/capabilities.js";
import { RoleCatalog, type SkillEvalEngineDeps, type SkillJudgeFn, type SkillReplay, runSkillEval, skillEvalReplay } from "../src/runtime/index.js";
import * as replayModule from "../src/runtime/skill-evals/replay.js";
import reviewRole from "../src/worker/roles/review.role.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { type SkillEvalWiring, improveWiring, runFigures, runSkillEvalFor, scratchRunFor, skillImproveWiring } from "../src/skill-evals.js";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import type { Loaded } from "../src/load-config.js";
import { REGISTRY, withPlugin } from "../src/plugins.js";
import { readFile } from "node:fs/promises";

vi.mock("../src/runtime/skill-evals/replay.js", async (load) => {
  const m = await load<typeof import("../src/runtime/skill-evals/replay.js")>();
  return { ...m, replayInSandbox: vi.fn(m.replayInSandbox) };
});

const OWNER = "local:owner" as UserId;
const JUDGE_PROMPT = readFileSync(join(import.meta.dirname, "..", "prompts", "skill-judge.md"), "utf8");
const REPO = { path: config.repo.path, base_branch: config.repo.base_branch };
const REPLAY_OPTS = {
  repo: REPO, role: "implement", system_prompt: "SKILL", env_allowlist: {}, deny_paths: [".env"], model_class: "standard" as const, timeout_ms: 1000,
  skill: { folder: "/host/skills/tests-first", name: "tests-first" }, sandbox_plugin: "local", root: "/host",
};

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "skill-evals-"));
  vi.mocked(replayModule.replayInSandbox).mockClear();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** An LLM that records its requests and answers each with `answer`. */
class FakeLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: (req: LLMRequest) => LLMResponse | Promise<LLMResponse>) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return this.answer(req);
  }
}

const json = (parsed: unknown): LLMResponse => ({ text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } });
const yesNo = (...answers: ("yes" | "no")[]) => json({ answers: answers.map((answer, i) => ({ answer, reason: `check ${i + 1} ${answer}` })) });

/** A store with one suite and its cases (each case's `expected` is its rubric). */
async function suiteWith(cases: Record<string, { input: unknown; expected: unknown }>) {
  const { store } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/tests-first", title: "Tests first", created_by: OWNER });
  for (const [id, c] of Object.entries(cases)) await store.addSkillEvalCase({ id, suite_id: "s1", ...c });
  return store;
}

const signal = () => new AbortController().signal;

describe("replayInSandbox, shared by the golden and the skill-eval replay", () => {
  it("the skill-eval replay runs in a fresh detached sandbox, cleaned first, with the tools its skill names (none here), no session and no doc index, and destroys it", async () => {
    const sandbox = new FakeSandbox();
    const runner = new FakeRunner({ implement: () => ({ output: { done: true } }) });
    const replay = skillEvalReplay({ sandbox, runner }, REPLAY_OPTS);

    expect((await replay({ run_id: "r1", case_id: "c1", input: "do it" }, signal())).output).toBe('{"done":true}');
    expect((await replay({ run_id: "r1", case_id: "c2", input: "again" }, signal())).output).toBe('{"done":true}');

    expect(replayModule.replayInSandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.created).toEqual([
      { repo: REPO.path, branch: null, base_ref: REPO.base_branch },
      { repo: REPO.path, branch: null, base_ref: REPO.base_branch },
    ]);
    expect(sandbox.destroyedIds).toEqual(["sbx1", "sbx2"]);
    expect(sandbox.commands.filter((c) => c.startsWith("sh -c set -e"))).toHaveLength(2); // the clean-up, once per sandbox
    const spec = runner.specs[0]!;
    expect(spec).toMatchObject({ run_id: "skill_eval_r1_c1", system_prompt: "SKILL", prompt: "do it", tools: [], tool_grants: [], writable_paths: [], lease_token: 0 });
    expect(spec.sandbox).toMatchObject({ id: "sbx1" });
    expect(spec).not.toHaveProperty("session");
    expect(Object.keys(spec).filter((k) => /doc/i.test(k))).toEqual([]);
  });

  it("destroys the sandbox when the run throws, and a run that does not complete fails the replay", async () => {
    const sandbox = new FakeSandbox();
    const throwing = skillEvalReplay({ sandbox, runner: new FakeRunner({}) }, REPLAY_OPTS);
    await expect(throwing({ run_id: "r1", case_id: "c1", input: "x" }, signal())).rejects.toThrow();
    const timedOut = skillEvalReplay({ sandbox, runner: new FakeRunner({ implement: () => ({ status: "timed_out" }) }) }, REPLAY_OPTS);
    await expect(timedOut({ run_id: "r1", case_id: "c2", input: "x" }, signal())).rejects.toThrow(/timed_out/);
    expect(sandbox.destroyed).toBe(2);
    expect(sandbox.live.size).toBe(0);
  });

  it("the golden replay goes through the same function, keeping its role's tools", async () => {
    const rolesDir = join(tmp, "roles");
    const dir = join(rolesDir, "review", "golden", "1");
    await mkdir(join(dir, "environment"), { recursive: true });
    await writeFile(join(dir, "environment", "diff.patch"), "+ x\n");
    await writeFile(join(dir, "instruction.md"), "spec for 1");
    await writeFile(join(dir, "case.json"), JSON.stringify({ expect: "should_pass" }));
    const sandbox = new FakeSandbox();
    const runner = new FakeRunner({ review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "ok" } }) });
    const deps: GoldenRunDeps = {
      rolesDir, roles: new RoleCatalog([{ file: "worker/roles/review.role.ts", descriptor: reviewRole }]),
      prompt: async () => prompts.review, resultsDir: join(tmp, "results"), sandbox, runner, scanner: cleanScanner,
      clock: new FakeClock(new Date("2026-11-23T12:00:00.000Z")), config,
    };

    const report = await runCases(deps, { role: "review" });

    expect(report.cases.map((c) => c.verdict)).toEqual(["pass"]);
    expect(replayModule.replayInSandbox).toHaveBeenCalledTimes(1);
    expect(runner.specs[0]!.tools.map((t) => t.name)).toEqual(reviewRole.tools);
    expect(runner.specs[0]).not.toHaveProperty("session");
    expect(sandbox.created).toEqual([{ repo: config.repo.path, branch: null, base_ref: config.repo.base_branch }]);
    expect(sandbox.destroyed).toBe(1);
  });
});

describe("the skill judge, sharing LlmJudge's plain completion", () => {
  it("sends one plain completion with prompts/skill-judge.md as the system prompt, the checks in order, on another class", async () => {
    const llm = new FakeLLM(() => yesNo("yes", "no"));
    const answers = await skillJudge(llm, JUDGE_PROMPT, "standard")({ input: "the input", output: "the output", checks: ["writes a test", "runs it"] }, signal());

    expect(answers).toEqual([{ answer: "yes", reason: "check 1 yes" }, { answer: "no", reason: "check 2 no" }]);
    const req = llm.requests[0]!;
    expect(req).toMatchObject({ model_class: "strong", system: JUDGE_PROMPT, data_env: "test" });
    expect(req.messages).toHaveLength(1);
    const text = req.messages[0]!.content;
    expect(text.indexOf("1. writes a test")).toBeLessThan(text.indexOf("2. runs it"));
    expect(text).toContain("the input");
    expect(text).toContain("the output");
  });

  it("LlmJudge and the skill judge build their request in the one shared function", async () => {
    const graded = new FakeLLM(() => json({ score: 4, reason: "fine" }));
    await new LlmJudge(graded, "GRADE").grade({ kind: "triage", title: "t", output: "o", producer: "standard" }, signal());
    const judged = new FakeLLM(() => yesNo("yes"));
    await skillJudge(judged, "JUDGE", "standard")({ input: "i", output: "o", checks: ["c"] }, signal());
    const direct = new FakeLLM(() => json({}));
    await judgeCompletion(direct, { model_class: "strong", system: "S", content: "C", output_schema: {}, max_tokens: 10, signal: signal() });

    const shape = (r: LLMRequest) => Object.keys(r).sort();
    expect(shape(graded.requests[0]!)).toEqual(shape(direct.requests[0]!));
    expect(shape(judged.requests[0]!)).toEqual(shape(direct.requests[0]!));
  });

  it("gives no answer for a failed call, a cut answer, or an answer count that is not one per check", async () => {
    const subject = { input: "i", output: "o", checks: ["a", "b"] };
    expect(await skillJudge(new FakeLLM(() => yesNo("yes")), "J", "cheap")(subject, signal())).toBeNull();
    expect(await skillJudge(new FakeLLM(() => ({ ...yesNo("yes", "yes"), stop_reason: "max_tokens" })), "J", "cheap")(subject, signal())).toBeNull();
    expect(await skillJudge(new FakeLLM(() => { throw new Error("down"); }), "J", "cheap")(subject, signal())).toBeNull();
    expect(parseCheckAnswers({ answers: [{ answer: "maybe", reason: "r" }] }, 1)).toBeNull();
    expect(parseCheckAnswers({ answers: [{ answer: "yes", reason: "r" }], extra: 1 }, 1)).toBeNull();
  });
});

describe("runSkillEval", () => {
  /** Engine deps over the store, a replay that echoes its input, and the skill judge on a fake LLM. */
  function deps(store: SkillEvalEngineDeps["store"], llm: LLMProvider, replay: SkillReplay = async (c) => ({ output: `out:${c.input}` })): SkillEvalEngineDeps {
    return { store, replay, judge: skillJudge(llm, JUDGE_PROMPT, "standard"), scan: async () => [] };
  }

  it("passes a case only when every check is yes; one no fails it and the run", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a", "b"] }, c2: { input: "bad", expected: { checks: ["a", "b", "c"] } } });
    const llm = new FakeLLM((req) => (req.messages[0]!.content.includes("out:good") ? yesNo("yes", "yes") : yesNo("yes", "no", "yes")));

    const outcome = await runSkillEval(deps(store, llm), { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v1" }, signal());

    expect(outcome.status).toBe("failed");
    expect(outcome.verdicts).toEqual(expect.arrayContaining([{ case_id: "c1", verdict: "pass" }, { case_id: "c2", verdict: "fail" }]));
    const replays = await store.listSkillEvalReplays("r1");
    expect(replays.find((r) => r.case_id === "c2")!.detail).toEqual({
      answers: [
        { check: "a", answer: "yes", reason: "check 1 yes" },
        { check: "b", answer: "no", reason: "check 2 no" },
        { check: "c", answer: "yes", reason: "check 3 yes" },
      ],
    });
    expect(await store.finishSkillEvalRun("r1", "passed")).toBe(false); // the final status is already set
  });

  it("a run whose every case passes is passed; a failed replay or judge, or a case with no rubric, is errored", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    expect((await runSkillEval(deps(store, new FakeLLM(() => yesNo("yes"))), { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal())).status).toBe("passed");

    const failing: SkillReplay = async () => {
      throw new Error("sandbox down");
    };
    const r2 = await runSkillEval(deps(store, new FakeLLM(() => yesNo("yes")), failing), { id: "r2", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(r2).toMatchObject({ status: "errored", verdicts: [{ case_id: "c1", verdict: "errored" }] });

    const r3 = await runSkillEval(deps(store, new FakeLLM(() => json({ answers: [] }))), { id: "r3", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(r3).toMatchObject({ status: "errored", verdicts: [{ case_id: "c1", verdict: "errored" }] });

    const bare = await suiteWith({ c1: { input: "x", expected: "no list" } });
    expect((await runSkillEval(deps(bare, new FakeLLM(() => yesNo("yes"))), { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal())).status).toBe("errored");
  });

  it("withholds a judge reason the egress scan flags", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const judge: SkillJudgeFn = async () => [{ answer: "yes", reason: "leaks a token" }];
    await runSkillEval({ store, replay: async () => ({ output: "o" }), judge, scan: async (t) => (t.includes("token") ? ["known_secret"] : []) }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(JSON.stringify((await store.listSkillEvalReplays("r1"))[0]!.detail)).not.toContain("token");
  });

  it("is safe to run twice: a finished run is left as it is and nothing is replayed again", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const replay = vi.fn<SkillReplay>(async () => ({ output: "o" }));
    const d = { store, replay, judge: (async () => [{ answer: "yes", reason: "ok" }]) as SkillJudgeFn, scan: async () => [] };
    await runSkillEval(d, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    const again = await runSkillEval(d, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(again).toEqual({ run_id: "r1", status: null, verdicts: [{ case_id: "c1", verdict: "pass" }] });
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("a second run after the skill folder changes stores a second version; the first run and its replays are unchanged", async () => {
    const skill = join(tmp, "skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: tests-first\n---\nWrite the test first.\n");
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const d = deps(store, new FakeLLM(() => yesNo("yes")));
    const runs = () => store.db.all("SELECT id, status, started_at, finished_at, created_by, skill_version FROM controller_skill_eval_runs ORDER BY id");

    const v1 = await skillVersion(skill);
    await runSkillEval(d, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: v1 }, signal());
    const firstRun = (await runs()).find((r) => r.id === "r1");
    const firstReplays = await store.listSkillEvalReplays("r1");

    await writeFile(join(skill, "SKILL.md"), "---\nname: tests-first\n---\nWrite the test first, then run it.\n");
    const v2 = await skillVersion(skill);
    await runSkillEval(d, { id: "r2", suite_id: "s1", created_by: OWNER, skill_version: v2 }, signal());

    expect(v2).not.toBe(v1);
    const after = await runs();
    expect(after.find((r) => r.id === "r1")).toEqual(firstRun);
    expect(firstRun).toMatchObject({ skill_version: v1, status: "passed" });
    expect(after.find((r) => r.id === "r2")).toMatchObject({ skill_version: v2, status: "passed" });
    expect(await store.listSkillEvalReplays("r1")).toEqual(firstReplays);
    expect(await store.listSkillEvalReplays("r2")).toEqual([expect.objectContaining({ case_id: "c1", verdict: "pass" })]);
  });
});

describe("the eval wiring (runSkillEvalFor)", () => {
  /** The wiring over `store`, a skill folder `skills/tests-first` under tmp, a fake sandbox, runner and judge LLM. */
  async function wiring(store: SkillEvalWiring["store"], llm: LLMProvider, o: { skillFile?: boolean } = {}) {
    const folder = join(tmp, "skills", "tests-first");
    await mkdir(folder, { recursive: true });
    if (o.skillFile !== false) await writeFile(join(folder, "SKILL.md"), "Write the test first.");
    const sandbox = new FakeSandbox();
    const runner = new FakeRunner({ implement: (spec) => ({ output: `did ${spec.prompt}` }) });
    const plugins = vi.fn(async () => ({ sandbox, runner, llm, scanner: cleanScanner }));
    const d: SkillEvalWiring = {
      store, root: tmp, judgePrompt: async () => JUDGE_PROMPT, plugins, repo: REPO, deny_paths: [".env"], timeout_ms: 1000, newId: () => "run1", sandbox_plugin: "local",
    };
    return { d, folder, runner, plugins };
  }

  it("runs the skill's suite once and stores the run with its version, classes, replays, pass rate and errored count", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] }, c2: { input: "bad", expected: ["a"] }, c3: { input: "x", expected: "no rubric" } });
    const llm = new FakeLLM((req) => (req.messages[0]!.content.includes("did good") ? yesNo("yes") : yesNo("no")));
    const { d, folder, runner } = await wiring(store, llm);

    const r = await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });

    expect(r).toEqual({ run: expect.objectContaining({
      id: "run1", suite_id: "s1", status: "failed", created_by: OWNER, skill_version: await skillVersion(folder),
      model_class: "standard", judge_model_class: "strong", replays: 3, pass_rate: 1 / 3, errored: 1,
    }) });
    expect(runner.specs[0]).toMatchObject({ system_prompt: "Write the test first.", model_class: "standard", tools: [] });
    expect(llm.requests[0]).toMatchObject({ model_class: "strong", system: JUDGE_PROMPT });
    expect((await store.listSkillEvalRuns("skills/tests-first")).map((x) => x.id)).toEqual(["run1"]);
  });

  it("stores the suite's version, the judge prompt's SHA-256 and the factory version at the run's start (absent: dev)", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const { d } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const [suite] = await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = 's1'");
    const judge_version = createHash("sha256").update(JUDGE_PROMPT).digest("hex");
    const r = await runSkillEvalFor({ ...d, factory_version: "rev-abc" }, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(r).toEqual({ run: expect.objectContaining({ suite_version: Number(suite!.version), judge_version, factory_version: "rev-abc" }) });
    const dev = await runSkillEvalFor({ ...d, newId: () => "run2" }, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(dev).toEqual({ run: expect.objectContaining({ id: "run2", judge_version, factory_version: "dev" }) });
  });

  it("refuses, naming the skill, when no suite exists for it, and writes no run nor builds a plugin", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const { d, plugins } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const r = await runSkillEvalFor(d, { skill: "skills/missing", created_by: OWNER, signal: signal() });
    expect(r).toEqual({ refused: expect.stringContaining("skills/missing") });
    expect(plugins).not.toHaveBeenCalled();
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });

  it("refuses when the skill's SKILL.md cannot be read, and writes no run", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const { d } = await wiring(store, new FakeLLM(() => yesNo("yes")), { skillFile: false });
    expect(await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal() })).toEqual({ refused: expect.stringContaining("skills/tests-first") });
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });

  it("runs on --model's class with the judge on judgeClass of it; --judge-model may name that class", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const llm = new FakeLLM(() => yesNo("yes"));
    const { d, runner } = await wiring(store, llm);
    const r = await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal(), model_class: "strong", judge_model_class: "standard", replays: 1 });
    expect(r).toEqual({ run: expect.objectContaining({ id: "run1", status: "passed", model_class: "strong", judge_model_class: "standard", replays: 1, pass_rate: 1 }) });
    expect(runner.specs[0]).toMatchObject({ model_class: "strong" });
    expect(llm.requests[0]).toMatchObject({ model_class: "standard" });
  });

  it("refuses an unknown --model class, another --judge-model class and --replays above 1, writing no run nor building a plugin", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const { d, plugins } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const go = (o: { model_class?: string; judge_model_class?: string; replays?: number }) => runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal(), ...o });
    expect(await go({ model_class: "huge" })).toEqual({ refused: expect.stringMatching(/huge.*cheap, standard, strong/) });
    expect(await go({ judge_model_class: "standard" })).toEqual({ refused: expect.stringMatching(/--judge-model standard.*strong/) });
    expect(await go({ model_class: "cheap", judge_model_class: "cheap" })).toEqual({ refused: expect.stringMatching(/--judge-model cheap.*strong/) });
    expect(await go({ replays: 3 })).toEqual({ refused: expect.stringMatching(/--replays 3.*one verdict per case/) });
    expect(plugins).not.toHaveBeenCalled();
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });

  it("figures: one replay per case, a null pass rate with no replays, the judge on judgeClass of the replay's class", () => {
    expect(runFigures("standard", [])).toEqual({ model_class: "standard", judge_model_class: "strong", replays: 0, pass_rate: null, errored: 0 });
    expect(runFigures("strong", [{ verdict: "pass" }, { verdict: "errored" }])).toEqual({ model_class: "strong", judge_model_class: "standard", replays: 2, pass_rate: 0.5, errored: 1 });
  });

  it("a scratch run replays each case with the draft as the skill's system prompt, judges it with skill-judge.md and stores it; SKILL.md is unchanged", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] }, c2: { input: "bad", expected: ["a"] } });
    const llm = new FakeLLM((req) => (req.messages[0]!.content.includes("did good") ? yesNo("yes") : yesNo("no")));
    const { d, folder, runner } = await wiring(store, llm);

    const run = await scratchRunFor(d, { skill_ref: "skills/tests-first", system_prompt: "DRAFT TEXT", run_id: "scratch1", skill_version: "draft:d1", model_class: "standard", created_by: OWNER }, signal());

    expect(run).toMatchObject({ id: "scratch1", skill_version: "draft:d1", model_class: "standard", replays: 2, pass_rate: 0.5 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual(["DRAFT TEXT", "DRAFT TEXT"]);
    expect(llm.requests.map((r) => r.system)).toEqual([JUDGE_PROMPT, JUDGE_PROMPT]);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("Write the test first.");
    expect(await scratchRunFor(d, { skill_ref: "skills/none", system_prompt: "x", run_id: "s2", skill_version: "draft:d2", model_class: "standard", created_by: OWNER }, signal())).toBeNull();
  });

  it("the improve wiring reads, versions and writes SKILL.md in the skill folder and re-runs the suite as it is now", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const { d, folder, runner } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const w = improveWiring(d, SKILL_IMPROVE_DEFAULTS, [join(tmp, "skills")], async () => "PROMPT");

    expect(w.folderOf("skills/tests-first")).toBe(folder);
    expect(w.folderOf("skills/../../x")).toBe(join(tmp, "..", "x"));
    expect(w.skill_folders).toEqual([join(tmp, "skills")]);
    expect(await w.readSkill(folder)).toBe("Write the test first.");
    expect(await w.version(folder)).toBe(await skillVersion(folder));
    await w.writeSkill(folder, "NEW TEXT");
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("NEW TEXT");
    expect(await w.rerun({ skill_ref: "skills/tests-first", model_class: "standard", created_by: OWNER }, signal())).toMatchObject({ id: "run1", pass_rate: 1 });
    expect(runner.specs[0]).toMatchObject({ system_prompt: "NEW TEXT" });
    expect(await w.readSkill(join(tmp, "nowhere"))).toBeNull();
  });

  it("with capabilities.skill_folders absent or empty there is no skill improvement wiring, and nothing is built", async () => {
    const { store } = await newStore();
    const plugins = { sandbox: new FakeSandbox(), runner: new FakeRunner({}), llm: new FakeLLM(() => yesNo("yes")), scanner: cleanScanner };
    expect(skillImproveWiring(store, { file: {} } as unknown as Loaded, plugins)).toBeUndefined();
    expect(skillImproveWiring(store, { file: { capabilities: { skill_folders: [] } } } as unknown as Loaded, plugins)).toBeUndefined();
  });

  it("the improve wiring's replays store their wall time from the configured Clock, though the composition root passes none", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const { folder } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    let t = 0;
    const registry = withPlugin(REGISTRY, "clock", "stepping", () => ({ now: () => new Date((t += 250)), sleep: async () => {} }));
    const loaded = {
      root: tmp, codeRoot: join(import.meta.dirname, ".."), file: { capabilities: { skill_folders: ["skills"] } },
      config: { repo: { owner: "o", name: "r", ...REPO }, deny_paths: [".env"], run_timeout_ms: 1000 },
      registry, plugins: { clock: "stepping", sandbox: "local" },
    } as unknown as Loaded;
    const plugins = { sandbox: new FakeSandbox(), runner: new FakeRunner({ implement: () => ({ output: "did it" }) }), llm: new FakeLLM(() => yesNo("yes")), scanner: cleanScanner };

    const run = await skillImproveWiring(store, loaded, plugins)!.rerun({ skill_ref: "skills/tests-first", model_class: "standard", created_by: OWNER }, signal());

    expect(folder).toBe(join(tmp, "skills", "tests-first"));
    expect(await store.listSkillEvalReplays(run!.id)).toEqual([expect.objectContaining({ case_id: "c1", wall_ms: 250 })]);
  });
});
