import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJudge } from "../src/core/outputs.js";
import type { WorkerId } from "../src/core/types.js";
import { type GoldenRunDeps, runCases } from "../src/golden.js";
import { ROLES_DIR, loadRoles } from "../src/runtime/index.js";
import { Worker } from "../src/worker/index.js";
import { JUDGE_SCHEMA, type JudgeInput, renderJudgePrompt } from "../src/worker/runs/judge/judge.run.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { type AgentRunSpec, SESSION_ROLES } from "../src/interfaces/agent-runner.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";
import { REPO } from "./architecture/lib.js";

// The judge of a goal split (design 04-split-specs): its answer's schema, its read-only role and prompt, its golden
// case, and its run on the strong class. No test calls a live model: every answer comes from a FakeRunner.

const fix = { title: "Wire the flow", problem: "the flow stops", done_criteria: ["the flow runs"], allowed_paths: ["src/flow/"] };

describe("parseJudge", () => {
  it("takes a verdict of next, fix, done or ask and a reason", () => {
    for (const verdict of ["next", "done", "ask"]) {
      expect(parseJudge({ verdict, reason: " because " })).toEqual({ ok: true, value: { verdict, reason: "because" } });
    }
    expect(parseJudge({ verdict: "fix", reason: "r", fix })).toEqual({ ok: true, value: { verdict: "fix", reason: "r", fix } });
    expect(parseJudge({ verdict: "maybe", reason: "r" }).ok).toBe(false);
    expect(parseJudge({ verdict: "next" }).ok).toBe(false);
    expect(parseJudge({ verdict: "next", reason: " " }).ok).toBe(false);
    expect(parseJudge(null).ok).toBe(false);
    expect(parseJudge("done").ok).toBe(false);
  });

  it("refuses a fix with no title, no problem, no done criterion or no allowed path", () => {
    expect(parseJudge({ verdict: "fix", reason: "r" }).ok).toBe(false);
    expect(parseJudge({ verdict: "fix", reason: "r", fix: { ...fix, title: "" } }).ok).toBe(false);
    expect(parseJudge({ verdict: "fix", reason: "r", fix: { ...fix, problem: " " } }).ok).toBe(false);
    expect(parseJudge({ verdict: "fix", reason: "r", fix: { ...fix, done_criteria: [] } }).ok).toBe(false);
    expect(parseJudge({ verdict: "fix", reason: "r", fix: { ...fix, allowed_paths: [" "] } }).ok).toBe(false);
  });

  it("its schema names the four verdicts and the fix fields", () => {
    expect(JUDGE_SCHEMA.properties.verdict.enum).toEqual(["next", "fix", "done", "ask"]);
    expect(JUDGE_SCHEMA.required).toEqual(["verdict", "reason"]);
    expect(JUDGE_SCHEMA.properties.fix.required).toEqual(["title", "problem", "done_criteria", "allowed_paths"]);
  });
});

describe("judge role", () => {
  it("is read-only (Read, Glob, Grep), keeps no session, proposes only a verdict, and ships a golden case", async () => {
    const role = (await loadRoles()).get("judge")!;
    expect(role).toMatchObject({ name: "judge", prompt: "judge.md", tools: ["Read", "Glob", "Grep"], proposes: ["verdict"], approves: [] });
    expect(existsSync(join(REPO, "prompts", "judge.md"))).toBe(true);
    expect(SESSION_ROLES).not.toContain("judge");
    const golden = join(REPO, ROLES_DIR, "judge", "golden");
    const cases = readdirSync(golden).filter((id) => existsSync(join(golden, id, "case.json")));
    expect(cases.length).toBeGreaterThanOrEqual(role.golden.min_cases);
    for (const id of cases) expect(readFileSync(join(golden, id, "instruction.md"), "utf8")).toMatch(/^## Goal lines\n/);
  });
});

describe("judge golden replay", () => {
  it("replays its cases on the strong class with the judge schema: fix or ask flags a case, next or done passes it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sf-judge-"));
    const runner = new FakeRunner({
      judge: (s: AgentRunSpec) => ({ output: s.prompt.includes("No item is lost") ? { verdict: "fix", reason: "the last chunk is dropped", fix } : { verdict: "done", reason: "ok" } }),
    });
    const deps = {
      rolesDir: join(REPO, ROLES_DIR), roles: await loadRoles(), prompt: async () => "JUDGE",
      resultsDir: join(tmp, "results"), sandbox: new FakeSandbox(), runner, scanner: cleanScanner,
      clock: new FakeClock(new Date("2026-11-23T00:00:00.000Z")), config,
    } as unknown as GoldenRunDeps;
    const report = await runCases(deps, { role: "judge" });
    expect(report.cases.length).toBeGreaterThan(0);
    expect(report.cases.map((c) => c.verdict)).toEqual(report.cases.map((c) => (c.expect === "should_flag" ? "bug" : "pass")));
    for (const s of runner.specs) {
      expect(s.model_class).toBe("strong");
      expect(s.output_schema).toBe(JUDGE_SCHEMA);
      expect(s.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    }
  });
});

describe("judge run", () => {
  const input: JudgeInput = {
    phase: 1, goal_done_when: ["the flow works"], title: "[1/2] Part 1", problem: "Problem of part 1", done_criteria: ["part 1 works"], merge_sha: "abc123", phases: ["[1/2] Part 1", "[2/2] Part 2"],
  };

  async function judgeRun(opts: { prompt: boolean; tier: 1 | 3 | 5 }) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem({ ...issue(900), title: "Goal" }, system);
    await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { tier: opts.tier } });
    const cur = (await store.getWorkItem(item.id))!;
    await store.transition({ id: item.id, expected_version: cur.version, actor: system, reason: "judge_queued", patch: {}, enqueue: { kind: "judge", idempotency_key: `judge:${item.id}:1`, input: { judge: input } } });
    const runner = new FakeRunner({ judge: () => ({ output: { verdict: "next", reason: "phase 1 did its part" } }) });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
      prompts: opts.prompt ? { ...prompts, judge: "JUDGE" } : prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
    });
    while (await worker.tick()) { /* the one judge run */ }
    const run = (await store.listRuns(item.id)).find((r) => r.kind === "judge")!;
    return { run, runner };
  }

  it("runs on the strong class whatever the tier, with the goal, the phase and its merge sha in its prompt, and stores the verdict", async () => {
    for (const tier of [1, 5] as const) {
      const { run, runner } = await judgeRun({ prompt: true, tier });
      expect(run.outcome).toMatchObject({ status: "succeeded", data: { verdict: { verdict: "next", reason: "phase 1 did its part" }, model_class: "strong" } });
      const spec = runner.specs.find((s) => s.role === "judge")!;
      expect(spec.model_class).toBe("strong");
      expect(spec.prompt).toBe(renderJudgePrompt(input));
      expect(spec.prompt).toContain("abc123");
      expect(spec.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    }
  });

  it("fails with prompt_missing and asks no model when no pack has prompts/judge.md", async () => {
    const { run, runner } = await judgeRun({ prompt: false, tier: 3 });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "prompt_missing" });
    expect(runner.specs.filter((s) => s.role === "judge")).toEqual([]);
  });
});
