import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { Worker } from "../src/worker/index.js";
import { ROUTINE_TOOLS } from "../src/worker/support.js";
import { type RoutineInput, parseRoutine, renderRoutinePrompt } from "../src/worker/runs/routine/routine.run.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";

// The routine run kind (phase 1 of the routines split): a read-only run with the routine role's prompt and tools.
// No scheduler queues one yet; these tests queue it by hand. Every answer comes from a FakeRunner.

const input: RoutineInput = { instruction: "Check that the README names the license.", url: "https://status.example.com/" };

async function routineRun(opts: { prompt: boolean }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const { item } = await store.createWorkItem(issue(901), system);
  await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "routine_queued", patch: {}, enqueue: { kind: "routine", idempotency_key: `routine:${item.id}:1`, input: { routine: input } } });
  const runner = new FakeRunner({ routine: () => ({ output: { verdict: "pass", findings: [], summary: "the README names it" } }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
    prompts: opts.prompt ? { ...prompts, routine: "ROUTINE" } : prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  while (await worker.tick()) { /* the one routine run */ }
  const run = (await store.listRuns(item.id)).find((r) => r.kind === "routine")!;
  return { run, runner, worker };
}

describe("the routine run", () => {
  it("roleSpec(\"routine\") resolves to prompts/routine.md and the routine tools", async () => {
    const { worker } = await routineRun({ prompt: true });
    const spec = await worker.roleSpec("routine");
    expect(spec.system_prompt).toContain("ROUTINE");
    expect(spec.tools).toEqual([...ROUTINE_TOOLS]);
  });

  it("runs one read-only agent step on the cheap class with the instruction and the page in its prompt, and stores the answer", async () => {
    const { run, runner } = await routineRun({ prompt: true });
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { routine: { verdict: "pass" }, model_class: "cheap" } });
    const spec = runner.specs.find((s) => s.role === "routine")!;
    expect(spec.prompt).toBe(renderRoutinePrompt(input));
    expect(spec.prompt).toContain(input.url);
    expect(spec.tools.map((t) => [t.name, t.capability])).toEqual([["Read", "read"], ["Glob", "read"], ["Grep", "read"], ["Browse", "read"]]);
  });

  it("fails with prompt_missing and asks no model when no pack has prompts/routine.md", async () => {
    const { run, runner } = await routineRun({ prompt: false });
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "prompt_missing" });
    expect(runner.specs.filter((s) => s.role === "routine")).toEqual([]);
  });

  it("says when no page is set, and reads an answer's verdict and findings", () => {
    expect(renderRoutinePrompt({ instruction: "x", url: null })).toContain("None: Browse refuses every call.");
    expect(parseRoutine({ verdict: "bug", findings: [{ text: "README.md:1 has no license" }], summary: "s" })).toEqual({ ok: true, value: { verdict: "bug", findings: [{ kind: "code", text: "README.md:1 has no license" }] } });
    expect(parseRoutine({ verdict: "maybe", findings: [] })).toEqual({ ok: false, error: "verdict" });
    expect(parseRoutine({ verdict: "bug", findings: [{}] })).toEqual({ ok: false, error: "findings" });
  });
});
