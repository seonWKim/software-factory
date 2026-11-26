import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { alice, cleanScanner, config, issueRef, prompts, silent } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { newStore } from "./helpers/store.js";

// The run-failed comment (issue #758): the sentence names the failure in plain English; the error code is only in
// code under the comment's Details fold, never in the sentence.
describe("the run-failed comment of a repeated failure", () => {
  it("says what failed in words and keeps the error code under Details", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const runner = new FakeRunner({ triage: () => ({ status: "failed", error: "boom", transcript: "agent said: boom" }) });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    for (let i = 0; i < 3; i++) {
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
      clock.advance(config.retry_max_ms);
    }
    const it = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
    expect(it).toMatchObject({ blocked_on: "human", blocked_reason: "repeated_failure" });
    const body = source.comments.find((c) => c.marker.includes("run-failed:"))!.body;
    const [sentence, rest] = body.split("<details>");
    expect(sentence).toContain("The Triage run failed twice in a row the same way: the agent exited with an error.");
    expect(sentence).not.toMatch(/`[a-z]+_[a-z]+`/);
    expect(sentence).not.toContain("agent_failed");
    expect(rest).toContain("<summary>Details</summary>");
    expect(rest).toContain("Error code `agent_failed`: the agent exited with an error.");
  });
});
