import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { RunOutcome, SourceRef, WorkItem } from "../src/core/types.js";
import type { SourceCloseReason } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore, w1 } from "./helpers/store.js";

// phases_auto_approve (src/controller/units/phases/phases.unit.ts): approvedByParent at triage and the phase tick.
// A phase spec that is itself a split, or waits at its own size checkpoint, is never approved by the parent's /approve.

const DAY = 24 * 60 * 60 * 1000;

const phase = (n: number) => ({ title: `Part ${n}`, problem: `Problem of part ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] });
const bigSpec = (phases: number) => ({ ...triageSpec, estimated_lines: 2600, estimated_files: 30, phases: Array.from({ length: phases }, (_, i) => phase(i + 1)) });
const smallSpec = { ...triageSpec, estimated_lines: 200, estimated_files: 4 };

async function setup(cfg: FactoryConfig = config) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, settings });
  /** `factory settings set <key> <value>`: a stored override the controller reads on its next tick. */
  const set = (key: string, value: unknown) => store.setSettingOverride({ key, project: "", value: JSON.stringify(value), actor: "local:test" });
  let comment = 10_000_000;
  const intake = async (n: number): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "Big change", body: "do it all" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  /** Claims the next run of `kind` (any item), completes it with `outcome`, applies it. */
  const finish = async (kind: "triage" | "implement", outcome: RunOutcome) => {
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
    expect(run?.kind).toBe(kind);
    await store.completeRun(run!.id, run!.lease!.token, outcome);
    await controller.tickRuns();
    return run!;
  };
  const triaged = (spec: unknown): RunOutcome => ({ status: "succeeded", summary: "s", data: { spec } });
  const approve = async (src: SourceRef) => {
    source.queue.push({ kind: "spec_approved", source: src, comment_id: String(++comment), approver: alice });
    await controller.tickIntake();
  };
  const closeSource = async (src: SourceRef, state_reason: SourceCloseReason) => {
    source.queue.push({ kind: "source_closed", source: src, closer: alice, state_reason });
    await controller.tickIntake();
  };
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const bySource = async (src: SourceRef) => (await store.getWorkItemBySource("github_issue", src.id))!;
  const runsOf = async (it: WorkItem) => store.listRuns(it.id);
  return { store, source, controller, intake, finish, triaged, approve, closeSource, get, bySource, runsOf, set };
}

describe("phases_auto_approve: the parent's /approve covers its phases", () => {
  /** A split parent approved: its phases filed, phase 1 queued for triage. */
  async function approvedSplit(f: Awaited<ReturnType<typeof setup>>, n: number) {
    const parent = await f.intake(n);
    await f.finish("triage", f.triaged(bigSpec(2)));
    await f.approve(issueRef(n));
    const [p1, p2] = await Promise.all(f.source.subIssues.map((s) => f.bySource(s.ref)));
    return { parent, p1: p1!, p2: p2! };
  }

  it("off (the default): each phase's spec waits for its own /approve", async () => {
    const f = await setup();
    const { p1 } = await approvedSplit(f, 80);
    expect(f.source.comments.find((c) => c.body.includes("filed 2 phases"))!.body).toContain("its own `/approve`");
    await f.finish("triage", f.triaged(smallSpec));
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  });

  it("on: a phase's spec goes straight to implement, says why in its spec comment, and the next phase does too", async () => {
    const f = await setup({ ...config, phases_auto_approve: true });
    const { parent, p1, p2 } = await approvedSplit(f, 81);
    expect(f.source.comments.find((c) => c.body.includes("filed 2 phases"))!.body).toContain("approved by this `/approve`");
    await f.finish("triage", f.triaged(smallSpec));
    expect(await f.get(p1)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.runsOf(p1)).map((r) => r.kind)).toEqual(["triage", "implement"]);
    const change = (await f.store.listStateChanges(p1.id)).at(-1)!;
    expect(change).toMatchObject({ reason: "triaged_phase_approved", detail: { parent_work_item_id: parent.id } });
    const spec = f.source.comments.filter((c) => c.source.id === f.source.subIssues[0]!.ref.id && c.marker.startsWith("<!-- factory:spec:")).at(-1)!;
    expect(spec.body).toContain("The owner approved the split on the parent issue (`phases_auto_approve`)");

    await f.closeSource(f.source.subIssues[0]!.ref, "completed");
    await f.finish("triage", f.triaged(smallSpec));
    expect(await f.get(p2)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
  });

  it("turned on live (settings set): a phase spec already waiting is approved on the next phase tick, once", async () => {
    const f = await setup();
    const { p1 } = await approvedSplit(f, 82);
    await f.finish("triage", f.triaged(smallSpec));
    expect(await f.get(p1)).toMatchObject({ blocked_reason: "spec_pending" });

    await f.set("phases_auto_approve", true);
    await f.controller.tickPhases();
    expect(await f.get(p1)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.store.listStateChanges(p1.id)).at(-1)).toMatchObject({ reason: "phase_spec_auto_approved" });
    const v = (await f.get(p1)).version;
    await f.controller.tickPhases();
    expect((await f.get(p1)).version).toBe(v);
    expect((await f.runsOf(p1)).filter((r) => r.kind === "implement")).toHaveLength(1);
  });

  it("an item that is not a phase, and a phase whose own spec is a split, still wait for a human", async () => {
    const f = await setup({ ...config, phases_auto_approve: true });
    const lone = await f.intake(83);
    await f.finish("triage", f.triaged(smallSpec));
    expect(await f.get(lone)).toMatchObject({ blocked_reason: "spec_pending" });
    await f.controller.tickPhases();
    expect(await f.get(lone)).toMatchObject({ blocked_reason: "spec_pending" });

    const { p1 } = await approvedSplit(f, 84);
    await f.finish("triage", f.triaged(bigSpec(2)));
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    await f.controller.tickPhases();
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("on: a phase spec at its own size checkpoint waits for its own /approve, at triage and on the phase tick", async () => {
    const f = await setup({ ...config, phases_auto_approve: true });
    const { p1 } = await approvedSplit(f, 85);
    await f.finish("triage", f.triaged({ ...smallSpec, estimated_lines: 1400 }));
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect((await f.store.listStateChanges(p1.id)).at(-1)).toMatchObject({ reason: "triaged" });
    const spec = f.source.comments.filter((c) => c.source.id === f.source.subIssues[0]!.ref.id && c.marker.startsWith("<!-- factory:spec:")).at(-1)!;
    expect(spec.body).toContain("at the size checkpoint");
    expect(spec.body).not.toContain("(`phases_auto_approve`)");
    await f.controller.tickPhases();
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect((await f.runsOf(p1)).filter((r) => r.kind === "implement")).toEqual([]);
  });

  it("turned on live: a phase spec waiting at its size checkpoint is not approved by the phase tick", async () => {
    const f = await setup();
    const { p1 } = await approvedSplit(f, 86);
    await f.finish("triage", f.triaged({ ...smallSpec, estimated_files: 35 }));
    expect(await f.get(p1)).toMatchObject({ blocked_reason: "spec_pending" });
    await f.set("phases_auto_approve", true);
    await f.controller.tickPhases();
    expect(await f.get(p1)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect((await f.store.listStateChanges(p1.id)).map((c) => c.reason)).not.toContain("phase_spec_auto_approved");
  });
});
