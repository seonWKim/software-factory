import { describe, expect, it } from "vitest";
import { NO_FILES_REFUSAL } from "../src/core/commands.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
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

async function autoTriage(spec: Record<string, unknown>, sandbox?: Sandbox) {
  const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  await store.setSettingOverride({ key: "mode", project: "", value: JSON.stringify("auto"), actor: "local:me@example.com" as UserId });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false, settings, ...(sandbox && { sandbox }) });
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

// The size checkpoint (design 04-split-specs): an answer over 85% of a cap with no phases waits at the spec gate,
// never approved without a person, auto mode included; 1 phase or more than 4 is refused as before.
describe("the triage branch and the size checkpoint", () => {
  const phase = (n: number) => ({ title: `Part ${n}`, problem: `Problem ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] });

  it("an estimate over 85% of a cap with no phases waits at the spec gate with the size checkpoint note, not approved by auto mode", async () => {
    const r = await autoTriage({ ...triageSpec, estimated_lines: 1400 });
    expect(r.it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain("at the size checkpoint");
    expect(spec).toContain("1275 lines or 34 files");
    expect(spec).toContain("/approve");
  });

  it("at the threshold it is an ordinary spec: auto mode approves it", async () => {
    const r = await autoTriage({ ...triageSpec, estimated_lines: 1275, estimated_files: 34 });
    expect(r.changes.map((c) => c.reason)).toContain("spec_approved");
  });

  it("1 phase or more than 4 is refused: nothing is stored and the item does not move on", async () => {
    for (const n of [1, 5]) {
      const r = await autoTriage({ ...triageSpec, estimated_lines: 1400, phases: Array.from({ length: n }, (_, i) => phase(i + 1)) });
      expect(r.it).toMatchObject({ stage: "NEW", done_criteria: null });
      expect(r.source.comments.some((c) => c.marker.includes("spec:"))).toBe(false);
    }
  });
});

// Migration timestamps (design 04-triage): the triage branch moves a new migration whose timestamp the base branch
// uses to the next free minute before parseTriage, so the stored spec and its comment show the new path.
describe("the triage branch and taken migration timestamps", () => {
  const mig = (stamp: string, component = "controller", slug = "new-thing") => `src/${component}/migrations/${stamp}-${component}-${slug}.migration.ts`;
  const listed: { ref: string; path: string }[] = [];
  const base = {
    listLocalFiles: async (s: { ref: string; path: string }) => {
      listed.push({ ref: s.ref, path: s.path });
      return [mig("20261122T1200", "controller", "schedules"), mig("20261122T1201", "worker", "cancel-closed-item-runs"), "src/core/policy.ts"];
    },
  } as unknown as Sandbox;
  const draft = (stamp: string) => ({
    ...triageSpec,
    allowed_paths: [mig(stamp), `tests/${stamp}-controller-new-thing.test.ts`],
    files_to_change: [mig(stamp), `tests/${stamp}-controller-new-thing.test.ts`],
    done_checks: [{ line: triageSpec.done_criteria[0], test_file: `tests/${stamp}-controller-new-thing.test.ts` }],
  });

  it("gives a spec draft naming a taken timestamp the next free one before it is shown", async () => {
    const r = await autoTriage(draft("20261122T1200"), base);
    expect(listed).toContainEqual({ ref: config.repo.base_branch, path: "src/" });
    // Companion rules may add paths after the drafted ones (the schema snapshot for a migration).
    expect(r.it.allowed_paths.slice(0, 2)).toEqual([mig("20261122T1202"), "tests/20261122T1202-controller-new-thing.test.ts"]);
    expect(r.it.files_to_change).toEqual([mig("20261122T1202"), "tests/20261122T1202-controller-new-thing.test.ts"]);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(mig("20261122T1202"));
    expect(spec).not.toContain("20261122T1200-controller-new-thing");
  });

  it("leaves a spec whose migration timestamps are all free unchanged", async () => {
    const r = await autoTriage(draft("20261123T0900"), base);
    expect(r.it.allowed_paths.slice(0, 2)).toEqual(draft("20261123T0900").allowed_paths);
    expect(r.it.files_to_change).toEqual(draft("20261123T0900").files_to_change);
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
    expect(sentence).toContain("The Triage run failed twice in a row the same way: the agent exited with an error.");
    expect(sentence).not.toMatch(/`[a-z]+_[a-z]+`/);
    expect(sentence).not.toContain("agent_failed");
    expect(rest).toContain("<summary>Details</summary>");
    expect(rest).toContain("Error code `agent_failed`: the agent exited with an error.");
  });
});
