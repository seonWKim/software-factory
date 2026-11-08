import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { DEFAULT_TIMEOUTS } from "../src/worker/run-kind.js";
import { FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, prompts, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// A step's start_to_close stops the step's work (worker review finding 3): the agent's signal aborts, and the run's
// folder is removed only after the agent returned, never under a running agent.

async function waitUntil(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error("timed out waiting");
}

describe("a step past its start_to_close", () => {
  it("aborts the agent's signal, and the folder is removed only after the agent returned", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const sandbox = new FakeSandbox();
    const controller = new ControllerRole({ store, source, forge: new FakeForge(source), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
    const events: string[] = [];
    const runner = new FakeRunner({
      // The agent runs until its signal aborts, as a real runner kills its process then; the process takes a
      // moment to exit.
      triage: (spec) =>
        new Promise((resolve) => {
          events.push("agent started");
          spec.signal.addEventListener("abort", () => {
            setTimeout(() => {
              events.push(`agent stopped (destroyed ${sandbox.destroyed})`);
              resolve({ status: "failed", error: "aborted" });
            }, 20);
          }, { once: true });
        }),
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config, prompts, log: silent,
      scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
    });
    source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    const running = worker.tick();
    await waitUntil(() => events.includes("agent started"));

    // One heartbeat past the step's hour: the engine times the step out.
    clock.advance(DEFAULT_TIMEOUTS.start_to_close_ms + config.heartbeat_ms);
    await running;

    expect(events).toEqual(["agent started", "agent stopped (destroyed 0)"]);
    expect(sandbox.destroyed).toBe(1);
    const item = (await store.getWorkItemBySource("github_issue", issueRef(9).id))!;
    const [triage] = await store.listRuns(item.id);
    expect(triage!.outcome).toMatchObject({ status: "failed", error_code: "start_to_close" });
  });
});
