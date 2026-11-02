import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { PHASE_HOLD, PHASES_OPEN, phaseMarker } from "../src/core/split.js";
import type { RunOutcome, SourceRef, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SourceCloseReason } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes.js";
import { newStore, w1 } from "./helpers/store.js";

// Split specs (design 2026-11-01): a large estimate gives a split spec; /approve files one sub-issue per phase,
// in order; each later phase is held until the one before it closes as completed; the parent closes last.

const DAY = 24 * 60 * 60 * 1000;

const phase = (n: number) => ({
  title: `Part ${n}`,
  problem: `Problem of part ${n}`,
  done_criteria: [`part ${n} works`],
  allowed_paths: [`src/p${n}/`],
});
const bigSpec = (phases = 3) => ({
  ...triageSpec,
  estimated_lines: 2600,
  estimated_files: 30,
  phases: Array.from({ length: phases }, (_, i) => phase(i + 1)),
});
const smallSpec = { ...triageSpec, estimated_lines: 200, estimated_files: 4 };

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
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
  return { clock, store, source, controller, intake, finish, triaged, approve, closeSource, get, bySource, runsOf };
}

describe("split spec flow", () => {
  it("a large estimate gives a split spec; /approve files the phases in order, holds the later ones, and the parent closes last", async () => {
    const f = await setup();
    const parent = await f.intake(70);
    await f.finish("triage", f.triaged(bigSpec(3)));

    // The split spec waits at the spec gate and lists the phases in order.
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const spec = f.source.comments.find((c) => c.marker.startsWith("<!-- factory:spec:"))!;
    expect(spec.body).toContain("### Split into phases");
    expect(spec.body.indexOf("Phase 1 of 3: Part 1")).toBeLessThan(spec.body.indexOf("Phase 2 of 3: Part 2"));
    expect(spec.body.indexOf("Phase 2 of 3: Part 2")).toBeLessThan(spec.body.indexOf("Phase 3 of 3: Part 3"));
    expect(spec.body).toMatch(/Commands you can reply with now:[\s\S]*`\/approve/);
    expect(spec.body.trimEnd().split("\n").at(-1)).toContain("/help");

    await f.approve(issueRef(70));

    // Three factory-labelled sub-issues, in order, each linked to the parent; each later one names the one before.
    const subs = f.source.subIssues;
    expect(subs.map((s) => s.title)).toEqual(["Phase 1/3: Part 1", "Phase 2/3: Part 2", "Phase 3/3: Part 3"]);
    expect(subs.every((s) => s.linked && s.parent.id === issueRef(70).id)).toBe(true);
    expect(subs.map((s) => s.marker)).toEqual([1, 2, 3].map((n) => phaseMarker(parent.id, n)));
    expect(subs[1]!.body).toContain(subs[0]!.ref.id);
    expect(subs[2]!.body).toContain(subs[1]!.ref.id);
    expect(subs[0]!.body).toContain("Problem of part 1");

    // The first phase starts at once (triage queued); the later ones are held with no run.
    const [p1, p2, p3] = await Promise.all(subs.map((s) => f.bySource(s.ref)));
    expect(p1).toMatchObject({ stage: "NEW", blocked_on: "none", requester_id: "github:1" });
    expect((await f.runsOf(p1!)).map((r) => r.kind)).toEqual(["triage"]);
    for (const p of [p2!, p3!]) {
      expect(p).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
      expect(await f.runsOf(p)).toEqual([]);
    }
    // Each phase records its parent, its place and the phase it waits for.
    const link = (await f.store.listStateChanges(p2!.id))[0]!;
    expect(link).toMatchObject({
      reason: "intake",
      detail: { parent_work_item_id: parent.id, phase: 2, phases: 3, depends_on: subs[0]!.ref.id },
    });

    // The parent waits on its phases and records them in order.
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: PHASES_OPEN });
    const approved = (await f.store.listStateChanges(parent.id)).find((c) => c.reason === "split_approved")!;
    expect(JSON.parse(String(approved.detail!.sub_issues))).toEqual(subs.map((s) => s.ref.id));
    expect(await f.runsOf(parent)).toHaveLength(1); // only its triage: the parent itself is never implemented

    // The poll delivers the bot-filed issues: nothing is taken in twice and no hold is lifted.
    f.source.queue.push({ kind: "item_requested", source: subs[1]!.ref, requester: alice, title: subs[1]!.title, body: `${subs[1]!.body}\n\n${subs[1]!.marker}` });
    await f.controller.tickIntake();
    expect(await f.get(p2!)).toMatchObject({ blocked_reason: PHASE_HOLD, version: p2!.version });

    // Phase 1 closes as completed: phase 2 is released into triage, phase 3 stays held, the parent stays open.
    await f.closeSource(subs[0]!.ref, "completed");
    expect(await f.get(p2!)).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null });
    expect((await f.runsOf(p2!)).map((r) => r.kind)).toEqual(["triage"]);
    expect(await f.get(p3!)).toMatchObject({ blocked_reason: PHASE_HOLD });
    expect((await f.get(parent)).stage).toBe("READY");
    // A second pass changes nothing.
    const v2 = (await f.get(p2!)).version;
    await f.controller.tickPhases();
    expect((await f.get(p2!)).version).toBe(v2);
    expect(await f.runsOf(p2!)).toHaveLength(1);

    await f.closeSource(subs[1]!.ref, "completed");
    expect(await f.get(p3!)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect((await f.get(parent)).stage).toBe("READY");
    expect(f.source.closed.map((s) => s.id)).not.toContain(issueRef(70).id);

    // The last phase closes as completed: the bot closes the parent as completed.
    await f.closeSource(subs[2]!.ref, "completed");
    expect(await f.get(parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", blocked_on: "none" });
    const i = f.source.closed.findIndex((s) => s.id === issueRef(70).id);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(f.source.closeReasons[i]).toBe("completed");
    expect(f.source.comments.some((c) => c.source.id === issueRef(70).id && c.body.includes("All 3 phases"))).toBe(true);
  });

  it("a small estimate gives a normal spec and /approve files no sub-issues", async () => {
    const f = await setup();
    const item = await f.intake(71);
    await f.finish("triage", f.triaged(smallSpec));
    const spec = f.source.comments.find((c) => c.marker.startsWith("<!-- factory:spec:"))!;
    expect(spec.body).not.toContain("Split into phases");
    await f.approve(issueRef(71));
    expect(f.source.subIssues).toEqual([]);
    expect(f.source.subIssueCalls).toBe(0);
    expect(await f.get(item)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.runsOf(item)).map((r) => r.kind)).toEqual(["triage", "implement"]);
  });

  it("a large estimate without phases is invalid output and is retried, not shown", async () => {
    const f = await setup();
    const item = await f.intake(72);
    await f.finish("triage", f.triaged({ ...smallSpec, estimated_lines: 1400 }));
    expect(f.source.comments.some((c) => c.marker.startsWith("<!-- factory:spec:"))).toBe(false);
    const changes = await f.store.listStateChanges(item.id);
    expect(changes.at(-1)).toMatchObject({ reason: "run_retry_scheduled", detail: { error_code: "invalid_output" } });
  });

  it("/approve again after a partial failure files no duplicates", async () => {
    const f = await setup();
    const parent = await f.intake(73);
    await f.finish("triage", f.triaged(bigSpec(3)));
    f.source.subIssueFailAt = 2;
    await f.approve(issueRef(73));

    // The second phase was filed but not linked; the approval was refused and the spec still waits.
    expect(f.source.subIssues).toHaveLength(2);
    expect(f.source.subIssues[1]!.linked).toBe(false);
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(f.source.comments.at(-1)!.body).toContain("`/approve` was not applied");
    expect(f.source.comments.at(-1)!.body).toContain("1 of 3");

    await f.approve(issueRef(73));
    expect(f.source.subIssues.map((s) => s.title)).toEqual(["Phase 1/3: Part 1", "Phase 2/3: Part 2", "Phase 3/3: Part 3"]);
    expect(f.source.subIssues.every((s) => s.linked)).toBe(true);
    expect(await f.get(parent)).toMatchObject({ blocked_reason: PHASES_OPEN });
    const p1 = await f.bySource(f.source.subIssues[0]!.ref);
    expect(await f.runsOf(p1)).toHaveLength(1);
    expect((await f.store.listWorkItems(100)).length).toBe(4);

    // Once split, a third /approve is refused and files nothing.
    await f.approve(issueRef(73));
    expect(f.source.subIssues).toHaveLength(3);
  });

  it("a phase closed as not planned keeps the next phase held and the parent open", async () => {
    const f = await setup();
    const parent = await f.intake(74);
    await f.finish("triage", f.triaged(bigSpec(2)));
    await f.approve(issueRef(74));
    const [s1, s2] = f.source.subIssues;
    await f.closeSource(s1!.ref, "not_planned");
    expect(await f.bySource(s2!.ref)).toMatchObject({ blocked_reason: PHASE_HOLD });
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_reason: PHASES_OPEN });
    expect(f.source.closed.map((s) => s.id)).not.toContain(issueRef(74).id);
  });

  it("/revise on a split spec runs triage again; the new spec need not be a split", async () => {
    const f = await setup();
    const item = await f.intake(75);
    await f.finish("triage", f.triaged(bigSpec(2)));
    f.source.queue.push({ kind: "revise_requested", source: issueRef(75), comment_id: "7501000", requester: alice, feedback: "one PR is fine" });
    await f.controller.tickIntake();
    expect(await f.get(item)).toMatchObject({ stage: "NEW", revision_count: 1 });
    await f.finish("triage", f.triaged(smallSpec));
    const specs = f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:spec:"));
    expect(specs).toHaveLength(2);
    expect(specs[0]!.body).toContain("Split into phases");
    expect(specs[1]!.body).not.toContain("Split into phases");
    await f.approve(issueRef(75));
    expect(f.source.subIssues).toEqual([]);
    expect(await f.get(item)).toMatchObject({ stage: "RUNNING" });
  });

  it("a split spec is never auto-approved, whatever its tier", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 } };
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
    source.queue.push({ kind: "item_requested", source: issueRef(76), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: bigSpec(2) } });
    await controller.tickRuns();
    expect(await store.getWorkItemBySource("github_issue", issueRef(76).id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });
});

describe("size checkpoint: suggested split", () => {
  it("the diff_too_large comment suggests phases built from the paths and the diff size", async () => {
    const f = await setup();
    const item = await f.intake(80);
    await f.finish("triage", f.triaged({
      ...smallSpec,
      allowed_paths: ["src/core/", "src/impl/", "tests/", "docs/design.md"],
      files_to_change: ["src/core/"],
    }));
    await f.approve(issueRef(80));
    const run = await f.finish("implement", {
      status: "failed",
      error_code: "diff_too_large",
      detail: "the diff changes 2400 lines (limit max_diff_lines = 1500) in 30 files (limit max_diff_files = 40)",
      infra: false,
    });
    expect(await f.get(item)).toMatchObject({ blocked_reason: "run_failed:implement:diff_too_large" });
    const note = f.source.comments.find((c) => c.marker === `<!-- factory:run-failed:${run.id} -->`)!;
    expect(note.body).toContain("### Suggested split");
    expect(note.body).toContain("Phase 1 of 2");
    expect(note.body).toContain("Phase 2 of 2");
    for (const p of ["src/core/", "src/impl/", "tests/", "docs/design.md"]) expect(note.body).toContain(`\`${p}\``);
    expect(note.body).toContain("`/revise <feedback>`");
    // The usual footer still ends the comment.
    expect(note.body.trimEnd().split("\n").at(-1)).toContain("/help");
    expect(note.body.indexOf("### Suggested split")).toBeLessThan(note.body.indexOf("Commands you can reply with now:"));
  });
});
