import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker/index.js";
import { DEFAULT_COORDINATION } from "../src/core/coordination.js";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type JudgeInput, renderJudgePrompt } from "../src/worker/runs/judge/judge.run.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, recordingLog, silent } from "./helpers/fakes/config.js";

const FILE = "src/worker/runner.ts"; // a default hotspot: two items changing it hold each other
const MIN = 60_000;

/** Item `n` implementing FILE, with a queued implement run. */
async function implementing(store: FactoryStore, clock: FakeClock, n: number): Promise<WorkItemId> {
  const { item } = await store.createWorkItem(issue(n), system);
  await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", files_to_change: [FILE], allowed_paths: ["src/worker/"] } });
  await store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: `impl${n}` } });
  clock.advance(1_000);
  return item.id;
}

/** A worker on `store` with the default coordination settings (hold_policy run_after_minutes 120). */
const worker = (store: FactoryStore, clock: FakeClock, log: ReturnType<typeof recordingLog>) => new Worker({
  id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
  clock, config: { ...config, workers: 4, coordination: DEFAULT_COORDINATION }, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {},
  awake: new NoKeepAwake(),
});

describe("run start log of a held implement run (design 05-dependencies, 2026-11-23)", () => {
  it("a run held past the hold limit starts, and its run start log names the timed_out decision and the limit in minutes", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await implementing(store, clock, 1);
    const held = await implementing(store, clock, 2);
    // Item 1's run is left running elsewhere; item 2's run is held behind it.
    expect((await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 }))!.work_item_id).not.toBe(held);
    expect(await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 })).toBeNull();
    clock.advance(120 * MIN);

    const log = recordingLog();
    expect(await worker(store, clock, log).tick()).toBe(true);
    const start = log.lines.find((l) => l.msg === "run start")!;
    expect(start.fields).toMatchObject({ work_item_id: held, kind: "implement", hold_decision: "timed_out", hold_limit_minutes: 120 });
    expect(await store.listClaimDecisions(held)).toMatchObject([{ decision: "timed_out" }]);
  });

  it("an implement run that starts free logs no hold decision", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const lone = await implementing(store, clock, 1);
    const log = recordingLog();
    expect(await worker(store, clock, log).tick()).toBe(true);
    const start = log.lines.find((l) => l.msg === "run start")!;
    expect(start.fields).toMatchObject({ work_item_id: lone, kind: "implement" });
    expect(start.fields?.hold_decision).toBeUndefined();
    expect(start.fields?.hold_limit_minutes).toBeUndefined();
  });
});

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
