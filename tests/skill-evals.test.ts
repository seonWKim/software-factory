// The skill-eval engine (src/runtime/skill-evals/): the replay shared with golden (replayInSandbox), the judge's
// plain completion shared with LlmJudge (judgeCompletion), the all-yes pass rule, and the skill version per run.
// Every runner, sandbox and LLM provider here is a fake: no test calls a model.

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

vi.mock("../src/runtime/skill-evals/replay.js", async (load) => {
  const m = await load<typeof import("../src/runtime/skill-evals/replay.js")>();
  return { ...m, replayInSandbox: vi.fn(m.replayInSandbox) };
});

const OWNER = "local:owner" as UserId;
const JUDGE_PROMPT = readFileSync(join(import.meta.dirname, "..", "prompts", "skill-judge.md"), "utf8");
const REPO = { path: config.repo.path, base_branch: config.repo.base_branch };
const REPLAY_OPTS = { repo: REPO, role: "implement", system_prompt: "SKILL", env_allowlist: {}, deny_paths: [".env"], model_class: "standard" as const, timeout_ms: 1000 };

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
  it("the skill-eval replay runs in a fresh detached sandbox with no tools, no session and no doc index, and destroys it", async () => {
    const sandbox = new FakeSandbox();
    const runner = new FakeRunner({ implement: () => ({ output: { done: true } }) });
    const replay = skillEvalReplay({ sandbox, runner }, REPLAY_OPTS);

    expect(await replay({ run_id: "r1", case_id: "c1", input: "do it" }, signal())).toBe('{"done":true}');
    expect(await replay({ run_id: "r1", case_id: "c2", input: "again" }, signal())).toBe('{"done":true}');

    expect(replayModule.replayInSandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.created).toEqual([
      { repo: REPO.path, branch: null, base_ref: REPO.base_branch },
      { repo: REPO.path, branch: null, base_ref: REPO.base_branch },
    ]);
    expect(sandbox.destroyedIds).toEqual(["sbx1", "sbx2"]);
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
  function deps(store: SkillEvalEngineDeps["store"], llm: LLMProvider, replay: SkillReplay = async (c) => `out:${c.input}`): SkillEvalEngineDeps {
    return { store, replay, judge: skillJudge(llm, JUDGE_PROMPT, "standard"), scan: async () => true };
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
    await runSkillEval({ store, replay: async () => "o", judge, scan: async (t) => !t.includes("token") }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(JSON.stringify((await store.listSkillEvalReplays("r1"))[0]!.detail)).not.toContain("token");
  });

  it("is safe to run twice: a finished run is left as it is and nothing is replayed again", async () => {
    const store = await suiteWith({ c1: { input: "x", expected: ["a"] } });
    const replay = vi.fn<SkillReplay>(async () => "o");
    const d = { store, replay, judge: (async () => [{ answer: "yes", reason: "ok" }]) as SkillJudgeFn, scan: async () => true };
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
