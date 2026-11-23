import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { type JudgeInput, renderJudgePrompt } from "../src/worker/runs/judge/judge.run.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

// The runner's pin of the judge to the strong class (design 04-split-specs): model_by lists only the four agent
// kinds, so the judge's class never comes from the tier. No test calls a live model: every answer comes from a FakeRunner.

describe("the runner on a judge run", () => {
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

  it("runs the judge on the strong class whatever the tier, with the goal, the phase and its merge sha in its prompt, and stores the verdict", async () => {
    for (const tier of [1, 3, 5] as const) {
      const { run, runner } = await judgeRun({ prompt: true, tier });
      expect(run.outcome).toMatchObject({ status: "succeeded", data: { verdict: { verdict: "next", reason: "phase 1 did its part" }, model_class: "strong" } });
      const spec = runner.specs.find((s) => s.role === "judge")!;
      expect(spec.model_class).toBe("strong");
      expect(spec.prompt).toBe(renderJudgePrompt(input));
      expect(spec.prompt).toContain("abc123");
      expect(spec.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    }
  });

  it("fails the judge with prompt_missing and asks no model when no pack has prompts/judge.md", async () => {
    const { run, runner } = await judgeRun({ prompt: false, tier: 3 });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "prompt_missing" });
    expect(runner.specs.filter((s) => s.role === "judge")).toEqual([]);
  });
});
