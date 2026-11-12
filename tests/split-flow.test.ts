import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { PHASE_HOLD, PHASES_OPEN, SPLIT_FILING, phaseMarker } from "../src/core/split.js";
import { REFUSED_ATTEMPTS } from "../src/outbound/outbound.js";
import type { RunOutcome, SourceRef, UserId, WorkItem } from "../src/core/types.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SourceCloseReason } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Split specs (design 2026-11-01): a large estimate gives a split spec; /approve queues one sub-issue per phase,
// filed by outbound in order (RFC 0015 M7); each later phase is held until the one before it closes as completed;
// the parent closes last.

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
  /** A second controller on the same store and source: another replica, or an old process still draining. */
  const replica = () => new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, settings });
  return { clock, store, source, controller, replica, intake, finish, triaged, approve, closeSource, get, bySource, runsOf, set };
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
    const num = (id: string) => id.slice(id.lastIndexOf("#"));
    expect(subs[1]!.body).toContain(`waits for ${num(subs[0]!.ref.id)}:`);
    expect(subs[2]!.body).toContain(`waits for ${num(subs[1]!.ref.id)}:`);
    expect(subs[0]!.body).toContain("Problem of part 1");

    // The first phase starts at once (triage queued); the later ones are held with no run.
    const [p1, p2, p3] = await Promise.all(subs.map((s) => f.bySource(s.ref)));
    expect(p1).toMatchObject({ stage: "NEW", blocked_on: "none", requester_id: "github:1" });
    expect((await f.runsOf(p1!)).map((r) => r.kind)).toEqual(["triage"]);
    for (const p of [p2!, p3!]) {
      expect(p).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
      expect(await f.runsOf(p)).toEqual([]);
    }
    // The store holds each phase's parent link and place; listPhases returns them in order.
    expect([p1, p2, p3].map((p) => [p!.parent_id, p!.phase])).toEqual([[parent.id, 1], [parent.id, 2], [parent.id, 3]]);
    expect((await f.store.listPhases(parent.id)).map((p) => p.id)).toEqual([p1!.id, p2!.id, p3!.id]);
    // Each phase's intake row also records its parent, its place and the phase it waits for (audit trail).
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
    expect(f.source.comments.some((c) => c.source.id === issueRef(70).id && c.body.includes("Closed because all 3 phases"))).toBe(true);
  });

  it("a duplicate phase issue closed as not planned neither holds the next phase nor keeps the parent open", async () => {
    const f = await setup();
    const parent = await f.intake(74);
    await f.finish("triage", f.triaged(bigSpec(2)));
    await f.approve(issueRef(74));
    const subs = f.source.subIssues;
    // A second, racing approval filed phase 2 again: linked to the parent, but not in its recorded sub_issues.
    const dup = issueRef(9074);
    await f.store.createWorkItem(
      { source: dup, title: "Phase 2/2: Part 2", requester_id: parent.requester_id, project: parent.project, problem: "p", resources: [], parent: { id: parent.id, phase: 2 } },
      { kind: "user", id: parent.requester_id },
    );
    await f.closeSource(dup, "not_planned");
    await f.closeSource(subs[0]!.ref, "completed");
    const p2 = await f.bySource(subs[1]!.ref);
    expect(p2).toMatchObject({ stage: "NEW", blocked_on: "none" });
    await f.closeSource(subs[1]!.ref, "completed");
    expect(await f.get(parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
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

  it("phase N+1 is filed only after phase N's delivery; a failed filing is outbound's retry and files each phase once", async () => {
    const f = await setup();
    const parent = await f.intake(73);
    await f.finish("triage", f.triaged(bigSpec(3)));
    f.source.subIssueFailAt = 2; // phase 2's first call files the issue, then fails before linking it
    await f.approve(issueRef(73));

    // `/approve` says the filing is queued; it is not refused.
    expect(f.source.comments.some((c) => c.body.includes("is filing the 3 phases of this split"))).toBe(true);
    expect(f.source.comments.some((c) => c.body.includes("was not applied"))).toBe(false);
    // Phase 1 is filed and taken in; phase 2 waits for its retry, and phase 3 (whose body names phase 2) is not
    // even recorded yet.
    expect(f.source.subIssueCalls).toBe(2);
    expect((await f.store.listPhases(parent.id)).map((p) => p.phase)).toEqual([1]);
    const filings = async () => (await f.store.db.all("SELECT args FROM outbound_actions WHERE action = 'file_sub_issue' ORDER BY seq"))
      .map((r) => (JSON.parse(String(r.args)) as { phase: number }).phase);
    expect(await filings()).toEqual([1, 2]);
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: SPLIT_FILING });
    // Before the backoff, neither a phase tick nor an outbox step files anything.
    await f.controller.tickPhases();
    await f.controller.tickOutbox();
    expect(f.source.subIssueCalls).toBe(2);

    f.clock.advance(config.retry_max_ms);
    await f.controller.tickOutbox();
    expect(f.source.subIssues.map((s) => s.title)).toEqual(["Phase 1/3: Part 1", "Phase 2/3: Part 2", "Phase 3/3: Part 3"]);
    expect(f.source.subIssues.every((s) => s.linked)).toBe(true);
    expect(f.source.subIssueCalls).toBe(4); // 1, 2 (failed), 2 again (found by its marker), 3
    expect(await filings()).toEqual([1, 2, 3]);
    expect(await f.get(parent)).toMatchObject({ blocked_reason: PHASES_OPEN });
    const p1 = await f.bySource(f.source.subIssues[0]!.ref);
    expect(await f.runsOf(p1)).toHaveLength(1);
    expect((await f.store.listWorkItems(100)).length).toBe(4);

    // Once split, another /approve is refused and files nothing.
    await f.approve(issueRef(73));
    expect(f.source.subIssueCalls).toBe(4);
  });

  it("a filing the source refuses for good is given up: the split waits for a person with an alarm, and /approve again files the rest once", async () => {
    const f = await setup();
    const parent = await f.intake(77);
    await f.finish("triage", f.triaged(bigSpec(3)));
    const file = f.source.fileSubIssue.bind(f.source);
    let locked = true;
    f.source.fileSubIssue = async (input) => {
      if (locked && input.marker === phaseMarker(parent.id, 2)) throw Object.assign(new Error("Validation Failed: the parent issue is locked"), { status: 422 });
      return file(input);
    };
    await f.approve(issueRef(77));
    for (let i = 1; i < REFUSED_ATTEMPTS; i++) {
      f.clock.advance(config.retry_max_ms);
      await f.controller.tickOutbox();
    }
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "delivery_failed" });
    expect((await f.store.listStateChanges(parent.id)).at(-1)).toMatchObject({ reason: "delivery_failed", detail: { action: "file_sub_issue", phase: 2 } });
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([
      expect.objectContaining({ pattern: "dead_letter", error_code: "non_retryable", detail: expect.stringContaining("the parent issue is locked") }),
    ]);
    // The reply is a thread entry the next outbox step sends.
    await f.controller.tickOutbox();
    expect(f.source.comments.some((c) => c.body.includes("stopped after 1 of 3"))).toBe(true);
    const first = await f.store.listPhases(parent.id);
    expect(first.map((p) => p.phase)).toEqual([1]);

    locked = false;
    await f.approve(issueRef(77));
    expect(f.source.subIssues.map((s) => s.title)).toEqual(["Phase 1/3: Part 1", "Phase 2/3: Part 2", "Phase 3/3: Part 3"]);
    const again = await f.store.listPhases(parent.id);
    expect(again.map((p) => p.phase)).toEqual([1, 2, 3]);
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(await f.get(parent)).toMatchObject({ blocked_reason: PHASES_OPEN });
  });

  it("one /approve applied by two controllers at once files one set of phases, even when the marker lookup misses", async () => {
    const f = await setup();
    const parent = await f.intake(78);
    await f.finish("triage", f.triaged(bigSpec(3)));
    // #172 and #252 (2026-11-07): a draining process and its successor both polled the same /approve, and the
    // marker lookup did not yet see the issues the other pass had just filed.
    f.source.subIssueLookupMisses = true;
    f.source.queue.push({ kind: "spec_approved", source: issueRef(78), comment_id: "20000001", approver: alice });
    await Promise.all([f.controller.tickIntake(), f.replica().tickIntake()]);

    expect(f.source.subIssues.map((s) => s.title)).toEqual(["Phase 1/3: Part 1", "Phase 2/3: Part 2", "Phase 3/3: Part 3"]);
    expect(await f.store.listPhases(parent.id)).toHaveLength(3);
    expect(await f.get(parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: PHASES_OPEN });
    const reasons = (await f.store.listStateChanges(parent.id)).map((c) => c.reason);
    expect(reasons.filter((r) => r === SPLIT_FILING)).toHaveLength(1);
    expect(reasons.filter((r) => r === "split_approved")).toHaveLength(1);
    // One split comment, and no refusal: the losing pass of the same command stays quiet.
    expect(f.source.comments.filter((c) => c.marker.includes(`split:${parent.id}`))).toHaveLength(1);
    expect(f.source.comments.some((c) => c.body.includes("already approved"))).toBe(false);
  });

  it("a phase whose text the egress scan flags is filed with the withheld notice only, under its marker (G5)", async () => {
    const f = await setup();
    const parent = await f.intake(76);
    const token = `ghp_${"a".repeat(36)}`;
    const spec = bigSpec(2);
    await f.finish("triage", f.triaged({ ...spec, phases: [{ ...spec.phases[0]!, problem: `Rotate ${token}` }, spec.phases[1]!] }));
    await f.approve(issueRef(76));
    const [s1, s2] = f.source.subIssues;
    expect(s1!.body).not.toContain(token);
    expect(s1!.body).toContain("withheld by the leak scanner (github_token)");
    expect(s1!.marker).toBe(phaseMarker(parent.id, 1));
    expect(s2!.body).toContain("Problem of part 2");
    expect(await f.get(parent)).toMatchObject({ blocked_reason: PHASES_OPEN });
  });

  it("a filing whose process stopped right after the claim goes on at the next phase tick; /approve meanwhile is refused", async () => {
    const f = await setup();
    const parent = await f.intake(79);
    await f.finish("triage", f.triaged(bigSpec(2)));
    // The process stopped right after claiming the filing: no filing was recorded.
    const it0 = await f.get(parent);
    const claimed = await f.store.transition({
      id: it0.id, expected_version: it0.version, patch: { blocked_on: "upstream", blocked_reason: SPLIT_FILING },
      actor: { kind: "user", id: "github:1" as UserId }, reason: SPLIT_FILING, detail: { phases: 2, comment_id: "1" },
    });
    expect(claimed.ok).toBe(true);

    // The phase tick (each poll runs it) records phase 1's filing; outbound has not sent it yet.
    await f.controller.tickPhases();
    expect(f.source.subIssues).toHaveLength(0);
    expect(await f.get(parent)).toMatchObject({ blocked_reason: SPLIT_FILING });

    // Another /approve meanwhile is refused; the poll that reads it sends the filings.
    await f.approve(issueRef(79));
    expect(f.source.comments.some((c) => c.body.includes("queued this split's phases for filing"))).toBe(true);
    expect(f.source.subIssues.map((s) => s.title)).toEqual(["Phase 1/2: Part 1", "Phase 2/2: Part 2"]);
    expect(await f.get(parent)).toMatchObject({ blocked_reason: PHASES_OPEN });
    expect((await f.store.listPhases(parent.id))[0]).toMatchObject({ requester_id: "github:1" });
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

  describe("/retry on a held phase (design 04-split-specs, 2026-11-12)", () => {
    /** A split of two approved on issue `n`, phase 1's triage done: phase 1 waits at the spec gate, phase 2 is held. */
    async function heldSplit(n: number) {
      const f = await setup();
      const parent = await f.intake(n);
      await f.finish("triage", f.triaged(bigSpec(2)));
      await f.approve(issueRef(n));
      const [s1, s2] = f.source.subIssues;
      await f.finish("triage", f.triaged(smallSpec));
      const p1 = await f.bySource(s1!.ref);
      const p2 = await f.bySource(s2!.ref);
      expect(p1).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      expect(p2).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
      let comment = 20_000_000;
      const say = async (event: (comment_id: string) => SourceEvent) => {
        const id = String(++comment);
        f.source.queue.push(event(id));
        await f.controller.tickIntake();
        return id;
      };
      const retry = (src: SourceRef) => say((comment_id) => ({ kind: "retry_requested", source: src, comment_id, requester: alice }));
      const reject = (src: SourceRef) => say((comment_id) => ({ kind: "spec_rejected", source: src, comment_id, approver: alice, reason: "superseded by other work" }));
      const refusal = (id: string) => f.source.comments.find((c) => c.marker === `<!-- factory:refused:${id} -->`);
      return { f, parent, s1: s1!, s2: s2!, p1, p2, retry, reject, refusal };
    }

    it("previous phase rejected: the automatic pass keeps it held; /retry releases it into triage and records the closed phase", async () => {
      const { f, s1, s2, p1, p2, retry, reject, refusal } = await heldSplit(90);
      await reject(s1.ref);
      expect(await f.get(p1)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
      // The automatic release is unchanged: only a completed previous phase releases the next.
      await f.controller.tickPhases();
      expect(await f.get(p2)).toMatchObject({ blocked_on: "upstream", blocked_reason: PHASE_HOLD, version: p2.version });
      expect(await f.runsOf(p2)).toEqual([]);

      const id = await retry(s2.ref);
      expect(refusal(id)).toBeUndefined();
      expect(await f.get(p2)).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null });
      const runs = await f.runsOf(p2);
      expect(runs.map((r) => [r.kind, r.idempotency_key])).toEqual([["triage", `${s2.ref.type}:${s2.ref.id}:triage`]]);
      const change = (await f.store.listStateChanges(p2.id)).at(-1)!;
      expect(change).toMatchObject({
        reason: "retry_requested",
        actor: { kind: "user" },
        detail: { released: PHASE_HOLD, depends_on: s1.ref.id, close_reason: "rejected", phase: 2 },
      });
      // A second pass and a second /retry release nothing more.
      await f.controller.tickPhases();
      await retry(s2.ref);
      expect((await f.store.listStateChanges(p2.id)).filter((c) => c.detail?.released === PHASE_HOLD)).toHaveLength(1);
      expect(await f.runsOf(p2)).toHaveLength(1);
    });

    it("previous phase still open: /retry changes nothing, queues nothing, and says that phase must close as completed first", async () => {
      const { f, s1, s2, p2, retry, refusal } = await heldSplit(91);
      const id = await retry(s2.ref);
      const after = await f.get(p2);
      expect([after.stage, after.blocked_on, after.blocked_reason, after.version]).toEqual([p2.stage, p2.blocked_on, p2.blocked_reason, p2.version]);
      expect(await f.runsOf(p2)).toEqual([]);
      const reply = refusal(id)!.body;
      expect(reply).toContain("must close as completed first");
      expect(reply).toContain(`phase 1 (${s1.ref.link})`);
    });

    it("previous phase completed: the automatic pass releases it as before, and a /retry after it releases nothing more", async () => {
      const { f, parent, s1, s2, p2, retry } = await heldSplit(92);
      await f.closeSource(s1.ref, "completed");
      expect(await f.get(p2)).toMatchObject({ blocked_on: "none", blocked_reason: null });
      const released = (await f.store.listStateChanges(p2.id)).at(-1)!;
      expect(released).toMatchObject({ reason: "phase_released", actor: { kind: "system" } });
      expect(released.detail).toEqual({ parent_work_item_id: parent.id, phase: 2, depends_on: s1.ref.id });
      const v = (await f.get(p2)).version;
      await retry(s2.ref);
      expect((await f.get(p2)).version).toBe(v);
      expect(await f.runsOf(p2)).toHaveLength(1);
    });

    it("previous phase completed with no pass yet: /retry releases it once, and the automatic pass after it releases nothing more", async () => {
      const { f, p1, s2, p2, retry } = await heldSplit(93);
      const r = await f.store.transition({
        id: p1.id, expected_version: (await f.get(p1)).version, actor: system, reason: "setup",
        patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null },
      });
      expect(r.ok).toBe(true);
      await retry(s2.ref);
      expect(await f.get(p2)).toMatchObject({ blocked_on: "none", blocked_reason: null });
      await f.controller.tickPhases();
      const releases = (await f.store.listStateChanges(p2.id)).filter((c) => c.reason === "phase_released" || c.detail?.released === PHASE_HOLD);
      expect(releases.map((c) => [c.reason, c.detail?.close_reason])).toEqual([["retry_requested", "completed"]]);
      expect(await f.runsOf(p2)).toHaveLength(1);
    });
  });

  it("a split parent closed as completed counts as merged for its dependents (no merge sha of its own)", async () => {
    const f = await setup();
    const parent = await f.intake(75);
    await f.finish("triage", f.triaged(bigSpec(2)));
    await f.approve(issueRef(75));
    const [s1, s2] = f.source.subIssues;
    /** An implementing item on issue `n` that depends on the parent, with its implement run queued under `key`. */
    const dependent = async (n: number, key: string) => {
      const { item } = await f.store.createWorkItem({ ...issue(n), source: issueRef(n) }, system);
      await f.store.transition({
        id: item.id, expected_version: 1, actor: system, reason: "x",
        patch: { stage: "RUNNING", tier: 2, allowed_paths: ["lib/"] }, enqueue: { kind: "implement", idempotency_key: key },
      });
      await f.store.replaceDependencyEdges(item.id, [{ depends_on: issueRef(75).id, kind: "depends_on" }]);
      return item;
    };
    const held = await dependent(81, "81:implement");
    const blocked = await dependent(82, "82:implement");
    await f.controller.tickCoordination();
    expect(await f.get(held)).toMatchObject({ blocked_on: "dependency", blocked_reason: "waiting for #75 to merge" });
    // An item an older version blocked when the parent closed (it had no merge sha), with its run cancelled.
    const b = await f.get(blocked);
    await f.store.transition({
      id: b.id, expected_version: b.version, actor: system, reason: "dependency_closed",
      patch: { blocked_on: "human", blocked_reason: "dependency_closed:#75" }, cancel_queued_runs: true,
    });

    await f.closeSource(s1!.ref, "completed");
    await f.closeSource(s2!.ref, "completed");
    expect(await f.get(parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null });
    // The held dependent is released when the split closes, in the same pass.
    expect(await f.get(held)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect((await f.store.listDependencyEdges({ work_item_id: held.id }))[0]).toMatchObject({ state: "merged" });

    // The blocked one: a human `/retry` reads its dependencies again and starts a new implement run.
    await f.controller.handleEvent({ kind: "retry_requested", source: issueRef(82), comment_id: "8201", requester: alice });
    expect(await f.get(blocked)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect((await f.runsOf(blocked)).filter((r) => r.status === "queued").map((r) => r.kind)).toEqual(["implement"]);
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
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
    source.queue.push({ kind: "item_requested", source: issueRef(76), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: bigSpec(2) } });
    await controller.tickRuns();
    expect(await store.getWorkItemBySource("github_issue", issueRef(76).id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });
});

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
