// The skill-eval engine (src/runtime/skill-evals/): the replay shared with golden (replayInSandbox), the judge's
// plain completion shared with LlmJudge (judgeCompletion), the pass rule for check texts (every must-have yes, threshold
// 1), the judge version over both judge prompts, and the skill version per run.
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
import { type SkillEvalWiring, brokerGuard, improveWiring, judgeVersion, previousAnswers, runFigures, runSkillEvalFor, scratchRunFor, skillImproveWiring } from "../src/skill-evals.js";
import { startIdentity } from "../src/identity/index.js";
import { FakeNoteBroker } from "./helpers/fakes/broker.js";
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
const PAIRWISE_PROMPT = readFileSync(join(import.meta.dirname, "..", "prompts", "skill-judge-pairwise.md"), "utf8");
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
async function suiteWith(cases: Record<string, { input: unknown; expected: unknown; split?: "dev" | "held-out" }>) {
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
    const yn = { kind: "yes/no", weight: 1, must: true };
    expect(replays.find((r) => r.case_id === "c2")!.detail).toEqual({
      answers: [
        { check: "a", answer: "yes", reason: "check 1 yes", ...yn, value: 1 },
        { check: "b", answer: "no", reason: "check 2 no", ...yn, value: 0 },
        { check: "c", answer: "yes", reason: "check 3 yes", ...yn, value: 1 },
      ],
      score: 2 / 3,
      threshold: 1,
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

  it("replays each case N times, stores each verdict with its number 1 to N, and does not replay a stored (case, number) again", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] }, c2: { input: "y", expected: ["a"] } });
    let calls = 0;
    const replay = vi.fn<SkillReplay>(async () => ({ output: `o${++calls}` }));
    const judge: SkillJudgeFn = async (s) => [{ answer: s.output === "o4" ? "no" : "yes", reason: "r" }];
    const ac = new AbortController();
    // An abort after the third replay leaves the run part-done; the second call finishes it without repeating one.
    const stopping: SkillReplay = async (c, sig) => {
      const out = await replay(c, sig);
      if (calls === 3) ac.abort();
      return out;
    };
    const first = await runSkillEval({ store, replay: stopping, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v", replays: 3 }, ac.signal);
    expect(first.status).toBeNull();
    const outcome = await runSkillEval({ store, replay: stopping, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v", replays: 3 }, signal());
    expect(replay).toHaveBeenCalledTimes(6);
    expect(outcome.status).toBe("failed");
    expect(outcome.verdicts).toHaveLength(6);
    const stored = await store.listSkillEvalReplays("r1");
    for (const c of ["c1", "c2"]) expect(stored.filter((x) => x.case_id === c).map((x) => x.replay).sort()).toEqual([1, 2, 3]);
    expect(stored.filter((x) => x.verdict === "fail")).toEqual([expect.objectContaining({ case_id: "c2", replay: 2 })]);
  });

  it("a verdict stored with no replay number counts as replay 1 and is not replayed again", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", verdict: "pass", detail: {} });
    const replay = vi.fn<SkillReplay>(async () => ({ output: "o" }));
    await runSkillEval({ store, replay, judge: async () => [{ answer: "yes", reason: "ok" }], scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v", replays: 2 }, signal());
    expect(replay).toHaveBeenCalledTimes(1);
    expect((await store.listSkillEvalReplays("r1")).map((x) => x.replay)).toEqual(expect.arrayContaining([null, 2]));
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
      store, root: tmp, judgePrompt: async () => JUDGE_PROMPT, pairwisePrompt: async () => PAIRWISE_PROMPT, plugins, repo: REPO, deny_paths: [".env"], timeout_ms: 1000, newId: () => "run1", sandbox_plugin: "local",
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

  it("stores the suite's version, the SHA-256 over both judge prompts and the factory version at the run's start (absent: dev)", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const { d } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const [suite] = await store.db.all("SELECT version FROM controller_skill_eval_suites WHERE id = 's1'");
    const judge_version = judgeVersion(JUDGE_PROMPT, PAIRWISE_PROMPT);
    const r = await runSkillEvalFor({ ...d, factory_version: "rev-abc" }, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(r).toEqual({ run: expect.objectContaining({ suite_version: Number(suite!.version), judge_version, factory_version: "rev-abc" }) });
    const dev = await runSkillEvalFor({ ...d, newId: () => "run2" }, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(dev).toEqual({ run: expect.objectContaining({ id: "run2", judge_version, factory_version: "dev" }) });
  });

  it("gives a new judge version when either judge prompt changes, and keeps a stored run's version and verdicts", async () => {
    const base = judgeVersion(JUDGE_PROMPT, PAIRWISE_PROMPT);
    expect(judgeVersion(`${JUDGE_PROMPT}.`, PAIRWISE_PROMPT)).not.toBe(base);
    expect(judgeVersion(JUDGE_PROMPT, `${PAIRWISE_PROMPT}.`)).not.toBe(base);
    expect(judgeVersion("ab", "c")).not.toBe(judgeVersion("a", "bc"));
    expect(base).not.toBe(createHash("sha256").update(JUDGE_PROMPT).digest("hex"));

    const store = await suiteWith({ c1: { input: "good", expected: ["a"] } });
    const old = createHash("sha256").update(JUDGE_PROMPT).digest("hex");
    await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER, skill_version: "v0", judge_version: old });
    await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", verdict: "pass", detail: { answers: [{ check: "a", answer: "yes", reason: "r" }] } });
    await store.finishSkillEvalRun("old", "passed");
    const { d } = await wiring(store, new FakeLLM(() => yesNo("no")));
    await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(await store.getSkillEvalRun("old")).toMatchObject({ judge_version: old, status: "passed" });
    expect(await store.listSkillEvalReplays("old")).toEqual([expect.objectContaining({ verdict: "pass", detail: { answers: [{ check: "a", answer: "yes", reason: "r" }] } })]);
    expect(await store.getSkillEvalRun("run1")).toMatchObject({ judge_version: base, status: "failed" });
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

  it("--replays N replays each case N times: replays is cases × N, the pass rate passes over replays, errored the errored replays", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] }, c2: { input: "bad", expected: ["a"] }, c3: { input: "x", expected: "no rubric" } });
    const llm = new FakeLLM((req) => (req.messages[0]!.content.includes("did good") ? yesNo("yes") : yesNo("no")));
    const { d, runner } = await wiring(store, llm);
    const r = await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal(), replays: 2 });
    expect(r).toEqual({ run: expect.objectContaining({ id: "run1", status: "failed", replays: 6, pass_rate: 2 / 6, errored: 2 }) });
    expect(runner.specs.length).toBe(4);
    expect((await store.listSkillEvalReplays("run1")).map((x) => x.replay).sort()).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("refuses an unknown --model class, another --judge-model class and --replays outside 1 to 10, writing no run nor building a plugin", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const { d, plugins } = await wiring(store, new FakeLLM(() => yesNo("yes")));
    const go = (o: { model_class?: string; judge_model_class?: string; replays?: number }) => runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal(), ...o });
    expect(await go({ model_class: "huge" })).toEqual({ refused: expect.stringMatching(/huge.*cheap, standard, strong/) });
    expect(await go({ judge_model_class: "standard" })).toEqual({ refused: expect.stringMatching(/--judge-model standard.*strong/) });
    expect(await go({ model_class: "cheap", judge_model_class: "cheap" })).toEqual({ refused: expect.stringMatching(/--judge-model cheap.*strong/) });
    for (const replays of [0, 11, 2.5, -1]) expect(await go({ replays })).toEqual({ refused: expect.stringMatching(new RegExp(`--replays ${replays}.*1 to 10`)) });
    expect(plugins).not.toHaveBeenCalled();
    expect(await store.db.all("SELECT id FROM controller_skill_eval_runs")).toEqual([]);
  });

  it("previousAnswers reads the replay numbered 1 of a run with repeats, else the replay stored with no number", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    for (const [id, v] of [["old", "v0"], ["rep", "v1"]] as const) await store.startSkillEvalRun({ id, suite_id: "s1", created_by: OWNER, skill_version: v });
    await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", verdict: "pass", detail: {}, answer: "unnumbered" });
    for (const replay of [2, 1, 3]) await store.recordSkillEvalReplay({ run_id: "rep", case_id: "c1", replay, verdict: "pass", detail: {}, answer: `answer ${replay}` });
    expect(await previousAnswers(store, "skills/tests-first", "v2")("c1")).toBe("answer 1");
    expect(await previousAnswers(store, "skills/tests-first", "v1")("c1")).toBe("unnumbered");
  });

  it("previousAnswers skips baseline: runs, so a pairwise check never compares against a no-skill answer", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    for (const [id, v] of [["old", "v0"], ["base", "baseline:v1"]] as const) await store.startSkillEvalRun({ id, suite_id: "s1", created_by: OWNER, skill_version: v });
    await store.recordSkillEvalReplay({ run_id: "old", case_id: "c1", replay: 1, verdict: "pass", detail: {}, answer: "skill answer" });
    await store.recordSkillEvalReplay({ run_id: "base", case_id: "c1", replay: 1, verdict: "pass", detail: {}, answer: "no-skill answer" });
    expect(await previousAnswers(store, "skills/tests-first", "v1")("c1")).toBe("skill answer");
  });

  it("figures: one replay per case, a null pass rate with no replays, the judge on judgeClass of the replay's class", () => {
    expect(runFigures("standard", [])).toEqual({ model_class: "standard", judge_model_class: "strong", replays: 0, pass_rate: null, errored: 0 });
    expect(runFigures("strong", [{ verdict: "pass" }, { verdict: "errored" }])).toEqual({ model_class: "strong", judge_model_class: "standard", replays: 2, pass_rate: 0.5, errored: 1 });
  });

  it("a scratch run replays each dev case with the draft as the skill's system prompt, judges it with skill-judge.md and stores it; SKILL.md is unchanged", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] }, c2: { input: "bad", expected: ["a"] }, h1: { input: "held", expected: ["a"], split: "held-out" } });
    const llm = new FakeLLM((req) => (req.messages[0]!.content.includes("did good") ? yesNo("yes") : yesNo("no")));
    const { d, folder, runner } = await wiring(store, llm);

    const run = await scratchRunFor(d, { skill_ref: "skills/tests-first", system_prompt: "DRAFT TEXT", run_id: "scratch1", skill_version: "draft:d1", model_class: "standard", created_by: OWNER, split: "dev" }, signal());

    expect(run).toMatchObject({ id: "scratch1", skill_version: "draft:d1", model_class: "standard", replays: 2, pass_rate: 0.5 });
    expect(runner.specs.map((s) => s.system_prompt)).toEqual(["DRAFT TEXT", "DRAFT TEXT"]);
    expect(runner.specs.map((s) => s.prompt).join("\n")).not.toContain("held");
    expect((await store.listSkillEvalReplays("scratch1")).map((r) => r.case_id).sort()).toEqual(["c1", "c2"]);
    expect(llm.requests.map((r) => r.system)).toEqual([JUDGE_PROMPT, JUDGE_PROMPT]);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("Write the test first.");
    expect(await scratchRunFor(d, { skill_ref: "skills/none", system_prompt: "x", run_id: "s2", skill_version: "draft:d2", model_class: "standard", created_by: OWNER, split: "dev" }, signal())).toBeNull();
  });

  it("a held-out scratch run replays only the held-out cases; eval run replays every case whatever its split", async () => {
    const store = await suiteWith({ c1: { input: "good", expected: ["a"] }, h1: { input: "held", expected: ["a"], split: "held-out" } });
    const llm = new FakeLLM(() => yesNo("yes"));
    const { d } = await wiring(store, llm);

    const held = await scratchRunFor(d, { skill_ref: "skills/tests-first", system_prompt: "DRAFT", run_id: "held1", skill_version: "draft:d1", model_class: "standard", created_by: OWNER, split: "held-out" }, signal());
    expect(held).toMatchObject({ replays: 1, pass_rate: 1 });
    expect((await store.listSkillEvalReplays("held1")).map((r) => r.case_id)).toEqual(["h1"]);

    const all = await runSkillEvalFor({ ...d, newId: () => "all1" }, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
    expect(all).toEqual({ run: expect.objectContaining({ id: "all1", replays: 2 }) });
    expect((await store.listSkillEvalReplays("all1")).map((r) => r.case_id).sort()).toEqual(["c1", "h1"]);
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

  describe("a skill whose tools: front matter names broker tools", () => {
    /** The wiring with SKILL.md `text`, its plugins carrying `broker` behind the shared G2 guard over a started Identity. */
    async function toolWiring(text: string, o: { sandbox_plugin?: string } = {}) {
      const { store } = await newStore();
      await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/tests-first", title: "Tests first", created_by: OWNER });
      await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "read it", expected: ["a"] });
      const folder = join(tmp, "skills", "tests-first");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), text);
      const identity = await startIdentity({ db: store.db, stateDir: tmp });
      const broker = new FakeNoteBroker({ k: "the note" });
      const loaded = { pack_tools: [], config: { packs_auto_approve_read_only: false } } as unknown as Loaded;
      const { guard, passports } = brokerGuard(loaded, { store, secrets: { get: async () => null } as never, identity: identity.passports, tool_grants: undefined });
      const guarded = guard(broker);
      const begin = vi.spyOn(passports, "begin");
      const results: unknown[] = [];
      const sandbox = new FakeSandbox();
      const runner = new FakeRunner({
        implement: async (spec) => {
          results.push(await guarded.call({ run_id: spec.run_id, work_item_id: spec.work_item_id, lease_token: spec.lease_token } as never, "test.read_note", { key: "k" }));
          return { output: "done" };
        },
      });
      const close = vi.fn(async () => identity.stop());
      const plugins = vi.fn(async () => ({ sandbox, runner, llm: new FakeLLM(() => yesNo("yes")), scanner: cleanScanner, tools: { broker: guarded, passports, project: "local:p" }, close }));
      const d: SkillEvalWiring = {
        store, root: tmp, judgePrompt: async () => JUDGE_PROMPT, plugins, repo: REPO, deny_paths: [".env"], timeout_ms: 1000, newId: () => "run1", sandbox_plugin: o.sandbox_plugin ?? "local",
      };
      const run = async () => {
        await runSkillEvalFor(d, { skill: "skills/tests-first", created_by: OWNER, signal: signal() });
        return store.listSkillEvalReplays("run1");
      };
      return { run, runner, sandbox, plugins, passports, begin, results, broker, close, identity };
    }

    it("replays with exactly the named read-only tools as tool_grants, and the runner calls them through the guarded broker under the run's own passport", async () => {
      const w = await toolWiring("---\nname: tests-first\ntools: test.read_note\n---\nRead the note.");
      const replays = await w.run();

      expect(replays).toEqual([expect.objectContaining({ case_id: "c1", verdict: "pass" })]);
      expect(w.plugins).toHaveBeenCalledWith({ tools: true });
      expect(w.runner.specs[0]!.tool_grants).toEqual(["test.read_note"]);
      expect(w.results).toEqual([{ ok: true, content: { key: "k", note: "the note" } }]);
      expect(w.broker.ran).toEqual([{ name: "test.read_note", args: { key: "k" } }]);
      const runId = w.runner.specs[0]!.run_id;
      expect(w.begin).toHaveBeenCalledWith(expect.objectContaining({ run: runId, kind: "skill_eval", grants: ["test.read_note"], project: "local:p" }));
      const issued = await w.begin.mock.results[0]!.value;
      expect(issued.passport.chain.at(-1)).toMatchObject({ tools: ["test.read_note"], audience: ["tool-broker"], runs: [runId], actions: ["use_tool"] });
      expect(w.passports.passportOf(runId)).toBeNull(); // dropped after the run
      expect(w.close).toHaveBeenCalledTimes(1);
    });

    it("the guard refuses a call from a replay run that holds no passport", async () => {
      const w = await toolWiring("---\ntools: test.read_note\n---\nRead the note.");
      vi.spyOn(w.passports, "begin").mockResolvedValue(undefined as never);
      await w.run();
      expect(w.results).toEqual([expect.objectContaining({ ok: false, error_code: "passport_missing" })]);
      expect(w.broker.ran).toEqual([]);
      await w.identity.stop();
    });

    it("a skill with no tools: front matter asks for no broker, replays with no tools and no grants, and mints no passport", async () => {
      const w = await toolWiring("---\nname: tests-first\n---\nWrite the test first.");
      await w.run();
      expect(w.plugins).toHaveBeenCalledWith({ tools: false });
      expect(w.runner.specs[0]).toMatchObject({ tools: [], tool_grants: [] });
      expect(w.begin).not.toHaveBeenCalled();
      await w.identity.stop();
    });

    it("a named tool the broker does not serve read-only errors the case tool_not_served, with no sandbox", async () => {
      const w = await toolWiring("---\ntools: test.write_note\n---\nWrite the note.");
      expect(await w.run()).toEqual([expect.objectContaining({ verdict: "errored", detail: { error: "tool_not_served" } })]);
      expect(w.sandbox.created).toEqual([]);
      expect(w.begin).not.toHaveBeenCalled();
    });

    it("under the noop sandbox a replay with tools is refused noop_tools_refused before any sandbox, and no broker is asked for", async () => {
      const w = await toolWiring("---\ntools: test.read_note\n---\nRead the note.", { sandbox_plugin: "noop" });
      expect(await w.run()).toEqual([expect.objectContaining({ verdict: "errored", detail: { error: "noop_tools_refused" } })]);
      expect(w.plugins).toHaveBeenCalledWith({ tools: false });
      expect(w.sandbox.created).toEqual([]);
      await w.identity.stop();
    });
  });
});
