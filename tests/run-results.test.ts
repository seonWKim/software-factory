import { describe, expect, it } from "vitest";
import { NO_FILES_REFUSAL } from "../src/core/commands.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { alice, cleanScanner, config, issueRef, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { newStore } from "./helpers/store.js";

// The triage outcome in auto mode (design 03-risk, 04-spec-gate-commands 2026-11-20): auto mode approves a spec it may,
// never one that changes no file in this repo, which waits at the spec gate with the comment a person gets.

async function autoTriage(spec: Record<string, unknown>) {
  const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  await store.setSettingOverride({ key: "mode", project: "", value: JSON.stringify("auto"), actor: "local:me@example.com" as UserId });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false, settings });
  const runner = new FakeRunner({ triage: () => ({ output: spec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  expect(await worker.tick()).toBe(true);
  await controller.tickRuns();
  const it = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  return { it, store, source, changes: await store.listStateChanges(it.id) };
}

describe("auto mode and a spec that changes no file in this repo", () => {
  it("auto mode approves a spec that changes a file (the setup reaches auto mode)", async () => {
    const r = await autoTriage(triageSpec);
    expect(r.changes.map((c) => c.reason)).toContain("spec_approved");
  });

  it("is not approved: it waits at the spec gate with the same comment, naming /revise and /reject and not /approve", async () => {
    const r = await autoTriage({ ...triageSpec, files_to_change: [] });
    expect(r.it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
    expect((await r.store.listRuns(r.it.id)).map((x) => x.kind)).toEqual(["triage"]);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(`This spec cannot be approved: ${NO_FILES_REFUSAL}.`);
    expect(spec).not.toContain("Auto mode is on");
    expect(spec).not.toContain("/approve");
  });
});

// Done-when checks (design 04-triage, 2026-11-22): the triage branch passes the repo's check commands to parseTriage
// and stores the list on the item; the worker's own parse has no command list, so these refusals are the branch's.
describe("the triage branch and done_checks", () => {
  it("stores the answer's done_checks on the item and shows each line's check in the spec comment", async () => {
    const r = await autoTriage(triageSpec);
    expect(r.it.done_checks).toEqual(triageSpec.done_checks);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(`- ${triageSpec.done_criteria[0]} (check: \`tests/scope-gate.test.ts\`)`);
  });

  it("refuses an answer without done_checks: nothing is stored and the item does not move on", async () => {
    const { done_checks: _, ...without } = triageSpec;
    const r = await autoTriage(without);
    expect(r.it).toMatchObject({ stage: "NEW", done_checks: null, done_criteria: null });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
  });

  it("refuses a command that is not one of the repo's check commands", async () => {
    const r = await autoTriage({ ...triageSpec, done_checks: [{ line: triageSpec.done_criteria[0], command: "rm -rf /" }] });
    expect(r.it).toMatchObject({ stage: "NEW", done_checks: null });
  });
});

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
    expect(sentence).toContain("The triage run failed twice in a row the same way: the agent exited with an error.");
    expect(sentence).not.toMatch(/`[a-z]+_[a-z]+`/);
    expect(sentence).not.toContain("agent_failed");
    expect(rest).toContain("<summary>Details</summary>");
    expect(rest).toContain("Error code: `agent_failed`");
  });
});
