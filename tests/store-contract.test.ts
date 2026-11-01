import { describe, expect, it } from "vitest";
import type { RunId, RunKind, UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
// One contract, every FactoryStore backend. MySQL joins when SF_TEST_MYSQL_URL is set (see helpers/store.ts).
import { BACKENDS, human, issue, system, w1, w2 } from "./helpers/store.js";

const LEASE = 60_000;

describe.each(BACKENDS)("FactoryStore contract: $name", ({ make }) => {
  describe("work items", () => {
    it("intake is idempotent on (source.type, source.id) and enqueues once", async () => {
      const { store } = await make();
      const enqueue = { kind: "triage" as const, idempotency_key: "o/r#1:triage" };
      const a = await store.createWorkItem(issue(1), system, { enqueue });
      const b = await store.createWorkItem(issue(1), system, { enqueue });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.item.id).toBe(a.item.id);
      expect(await store.listRuns(a.item.id)).toHaveLength(1);
      expect(await store.listStateChanges(a.item.id)).toHaveLength(1);
    });

    it("transition applies only on the expected version; the loser gets version_conflict", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const base = { id: item.id, expected_version: 1, actor: system, reason: "test" };
      const [first, second] = await Promise.all([
        store.transition({ ...base, patch: { stage: "READY" } }),
        store.transition({ ...base, patch: { stage: "CLOSED", close_reason: "wont_do" } }),
      ]);
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, reason: "version_conflict", current: { version: 2, stage: "READY" } });
    });

    it("records only changed fields, with from/to, in state_changes", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.transition({
        id: item.id,
        expected_version: 1,
        patch: { stage: "READY", blocked_on: "human", loop_count: 0 },
        actor: human,
        reason: "spec_posted",
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.state_change.changes).toEqual({
        stage: { from: "NEW", to: "READY" },
        blocked_on: { from: "none", to: "human" },
      });
      expect(r.state_change.actor).toEqual(human);
      expect(r.item.version).toBe(2);
    });

    it("acks a finished run and enqueues the next run atomically", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });

      const r = await store.transition({
        id: item.id,
        expected_version: 1,
        patch: { stage: "READY" },
        actor: system,
        reason: "triaged",
        ack_run: run.id,
        enqueue: { kind: "implement", idempotency_key: "i" },
      });
      expect(r.ok && r.enqueued?.kind).toBe("implement");
      expect(await store.listUnacknowledgedRuns(10)).toHaveLength(0);

      // Acking twice is refused and changes nothing.
      const again = await store.transition({
        id: item.id, expected_version: 2, patch: { stage: "RUNNING" }, actor: system, reason: "x", ack_run: run.id,
      });
      expect(again).toEqual({ ok: false, reason: "run_not_ackable" });
      expect((await store.getWorkItem(item.id))!.version).toBe(2);
    });

    it("re-enqueueing an existing idempotency key is a no-op", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "k" } });
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "k" },
      });
      expect(r.ok && r.enqueued).toBeNull();
      expect(await store.listRuns(item.id)).toHaveLength(1);
    });
  });

  describe("state change detail and PR lookups", () => {
    it("round-trips detail through transition and listStateChanges; it is null when not given", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const detail = { reverting_commit: "abc123", reverting_pr: 50 };
      const r = await store.transition({ id: item.id, expected_version: 1, patch: {}, actor: system, reason: "reverted", detail });
      if (!r.ok) throw new Error(r.reason);
      expect(r.state_change.detail).toEqual(detail);
      const [intake, reverted] = await store.listStateChanges(item.id);
      expect(intake!.detail).toBeNull();
      expect(reverted).toMatchObject({ reason: "reverted", detail, changes: {} });
    });

    it("finds a work item by (project, pr_number) and by merge_sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.createWorkItem(issue(2), system);
      expect(await store.getWorkItemByPr("o/r", 34)).toBeNull();
      expect(await store.getWorkItemByMergeSha("o/r", "m1")).toBeNull();
      await store.transition({ id: item.id, expected_version: 1, patch: { pr_number: 34, merge_sha: "m1" }, actor: system, reason: "x" });
      expect((await store.getWorkItemByPr("o/r", 34))!.id).toBe(item.id);
      expect((await store.getWorkItemByMergeSha("o/r", "m1"))!.id).toBe(item.id);
      expect(await store.getWorkItemByPr("other/repo", 34)).toBeNull();
      expect(await store.getWorkItemByMergeSha("other/repo", "m1")).toBeNull();
      expect(await store.getWorkItemByPr("o/r", 35)).toBeNull();
    });
  });

  describe("runs and leases", () => {
    async function queued() {
      const ctx = await make();
      const { item } = await ctx.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      return { ...ctx, item };
    }

    it("only one worker claims a run", async () => {
      const { store } = await queued();
      const [a, b] = await Promise.all([
        store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }),
        store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("claims only the requested kinds", async () => {
      const { store } = await queued();
      expect(await store.claimRun({ worker_id: w1, kinds: ["review"], lease_ms: LEASE })).toBeNull();
    });

    const ok = { status: "succeeded" as const, summary: "", data: { kept: true } };

    /** heartbeat, completeRun and appendHandoff with `token` all return lease_lost. */
    async function expectAllLost(store: FactoryStore, runId: RunId, item: WorkItemId, token: number) {
      const lost = { ok: false, reason: "lease_lost" };
      expect(await store.heartbeat(runId, token, LEASE)).toEqual(lost);
      expect(await store.completeRun(runId, token, ok)).toEqual(lost);
      expect(
        await store.appendHandoff({ run_id: runId, work_item_id: item, commit_sha: "abc", worked_on: "", next_steps: "" }, token),
      ).toEqual(lost);
    }

    it("heartbeat extends the lease", async () => {
      const { store, clock } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE - 1);
      expect((await store.heartbeat(run.id, run.lease!.token, LEASE)).ok).toBe(true);
      const after = (await store.getRun(run.id))!;
      expect(new Date(after.lease!.expires_at).getTime()).toBe(clock.now().getTime() + LEASE);
    });

    it("host sleep: an expired lease nobody reclaimed is renewed by its holder (status and token decide, not the clock)", async () => {
      const { store, clock, item } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE * 5);
      const hb = await store.heartbeat(run.id, run.lease!.token, LEASE);
      expect(hb.ok).toBe(true);
      const renewed = (await store.getRun(run.id))!;
      expect(renewed.status).toBe("running");
      expect(new Date(renewed.lease!.expires_at).getTime()).toBeGreaterThan(clock.now().getTime());

      // Handoffs and completion after expiry are accepted too, and the outcome is kept.
      clock.advance(LEASE * 5);
      const h = await store.appendHandoff(
        { run_id: run.id, work_item_id: item.id, commit_sha: "abc", worked_on: "x", next_steps: "y" },
        run.lease!.token,
      );
      expect(h.ok).toBe(true);
      const done = await store.completeRun(run.id, run.lease!.token, ok);
      expect(done.ok).toBe(true);
      expect((await store.getRun(run.id))!).toMatchObject({ status: "succeeded", outcome: ok, attempt: 1 });
    });

    it("fencing: after the reaper requeued the run, the old token is rejected everywhere", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toEqual([first.id]);
      expect((await store.getRun(first.id))!.status).toBe("queued");
      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(first.id))!.status).toBe("queued");
    });

    it("fencing: after the reaper failed the run (attempts used up), the old token is rejected everywhere", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(1)).toEqual([first.id]);
      expect((await store.getRun(first.id))!.status).toBe("failed");
      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(first.id))!.outcome).toMatchObject({ error_code: "lease_expired" });
    });

    it("fencing: after expiry and reclaim, the old holder's token is rejected; the new holder completes after expiry", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toEqual([first.id]);
      const second = (await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(second.lease!.token).toBe(first.lease!.token + 1);
      expect(second.attempt).toBe(2);

      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(second.id))!.status).toBe("running");

      clock.advance(LEASE + 1);
      const fresh = await store.completeRun(second.id, second.lease!.token, ok);
      expect(fresh.ok).toBe(true);
      expect((await store.getRun(second.id))!).toMatchObject({ status: "succeeded", outcome: ok });
    });

    it("the reaper fails a run once attempts are used up", async () => {
      const { store, clock } = await queued();
      let id: RunId | undefined;
      for (let i = 0; i < 2; i++) {
        id = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!.id;
        clock.advance(LEASE + 1);
        await store.expireLeases(2);
      }
      const run = (await store.getRun(id!))!;
      expect(run.status).toBe("failed");
      expect(run.outcome).toMatchObject({ error_code: "lease_expired", infra: true });
      expect(await store.listUnacknowledgedRuns(10)).toHaveLength(1);
    });

    it("handoffs are idempotent per (run, commit)", async () => {
      const { store, item } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      const h = { run_id: run.id, work_item_id: item.id, commit_sha: "abc", worked_on: "x", next_steps: "y" };
      await store.appendHandoff(h, run.lease!.token);
      await store.appendHandoff(h, run.lease!.token);
      expect(await store.listHandoffs(item.id)).toHaveLength(1);
    });
  });

  describe("title and run timing columns", () => {
    it("records the title at intake, null when not given; transitions leave it alone", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem({ ...issue(1), title: "Add a status page" }, system);
      expect(item.title).toBe("Add a status page");
      const { item: untitled } = await store.createWorkItem(issue(2), system);
      expect(untitled.title).toBeNull();
      await store.transition({ id: item.id, expected_version: 1, patch: { problem: "the spec" }, actor: system, reason: "x" });
      expect(await store.getWorkItem(item.id)).toMatchObject({ title: "Add a status page", problem: "the spec" });
      expect((await store.getWorkItem(untitled.id))!.title).toBeNull();
    });

    it("sets started_at on each claim and finished_at on completion; queued runs have neither", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const [queued] = await store.listRunsByStatus(["queued"], 10);
      expect(queued).toMatchObject({ started_at: null, finished_at: null });

      clock.advance(1_000);
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(run.started_at).toBe(clock.now().toISOString());
      expect(run.finished_at).toBeNull();

      clock.advance(5_000);
      await store.heartbeat(run.id, run.lease!.token, LEASE);
      expect((await store.getRun(run.id))!.started_at).toBe(run.started_at);

      clock.advance(5_000);
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
      const done = (await store.getRun(run.id))!;
      expect(done.started_at).toBe(run.started_at);
      expect(done.finished_at).toBe(clock.now().toISOString());
    });

    it("the reaper sets finished_at only when it fails the run; a requeue clears nothing and a reclaim restarts", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      await store.expireLeases(2);
      expect((await store.getRun(first.id))!.finished_at).toBeNull();

      const second = (await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(second.started_at).toBe(clock.now().toISOString());
      expect(second.started_at).not.toBe(first.started_at);
      clock.advance(LEASE + 1);
      await store.expireLeases(2);
      const failed = (await store.getRun(first.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.finished_at).toBe(clock.now().toISOString());
    });
  });

  describe("comment links", () => {
    it("spec_comment_url and failure_comment_url default to null and round-trip through transition()", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      expect(item.spec_comment_url).toBeNull();
      expect(item.failure_comment_url).toBeNull();
      expect((await store.getWorkItem(item.id))!).toMatchObject({ spec_comment_url: null, failure_comment_url: null });

      const spec = "https://github.com/o/r/issues/1#issuecomment-11";
      const r = await store.transition({
        id: item.id, expected_version: 1, actor: system, reason: "triaged",
        patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", spec_comment_url: spec },
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.item.spec_comment_url).toBe(spec);
      expect(r.state_change.changes.spec_comment_url).toEqual({ from: null, to: spec });

      const fail = "https://github.com/o/r/issues/1#issuecomment-22";
      await store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: { failure_comment_url: fail } });
      expect(await store.getWorkItem(item.id)).toMatchObject({ spec_comment_url: spec, failure_comment_url: fail });
      expect((await store.getWorkItemBySource("github_issue", item.source.id))!.failure_comment_url).toBe(fail);
      expect((await store.listWorkItemsWhere({ limit: 10 }))[0]).toMatchObject({ spec_comment_url: spec, failure_comment_url: fail });

      await store.transition({ id: item.id, expected_version: 3, actor: system, reason: "x", patch: { failure_comment_url: null } });
      expect(await store.getWorkItem(item.id)).toMatchObject({ spec_comment_url: spec, failure_comment_url: null });
    });
  });

  describe("read-only queries", () => {
    it("listWorkItemsWhere filters by stage, blocked_on and closed, most recently updated first", async () => {
      const { store, clock } = await make();
      const ids = [];
      for (let n = 1; n <= 4; n++) {
        clock.advance(1_000);
        ids.push((await store.createWorkItem(issue(n), system)).item.id);
      }
      const [a, b, c, d] = ids as [WorkItemId, WorkItemId, WorkItemId, WorkItemId];
      clock.advance(1_000);
      await store.transition({ id: a, expected_version: 1, patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_review" }, actor: system, reason: "x" });
      clock.advance(1_000);
      await store.transition({ id: b, expected_version: 1, patch: { stage: "CLOSED", close_reason: "wont_do" }, actor: system, reason: "x" });
      clock.advance(1_000);
      await store.transition({ id: c, expected_version: 1, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" }, actor: system, reason: "x" });

      const idsOf = (xs: { id: WorkItemId }[]) => xs.map((x) => x.id);
      expect(idsOf(await store.listWorkItemsWhere({ limit: 10 }))).toEqual([c, b, a, d]);
      expect(idsOf(await store.listWorkItemsWhere({ exclude_closed: true, limit: 10 }))).toEqual([c, a, d]);
      expect(idsOf(await store.listWorkItemsWhere({ stage: "CLOSED", exclude_closed: true, limit: 10 }))).toEqual([b]);
      expect(idsOf(await store.listWorkItemsWhere({ stage: "READY", limit: 10 }))).toEqual([a]);
      expect(idsOf(await store.listWorkItemsWhere({ blocked_on: "human", limit: 10 }))).toEqual([c, a]);
      expect(idsOf(await store.listWorkItemsWhere({ blocked_on: "human", stage: "REVIEW", limit: 10 }))).toEqual([c]);
      expect(idsOf(await store.listWorkItemsWhere({ limit: 2 }))).toEqual([c, b]);
    });

    it("countWorkItemsByStage counts every stage, 0 when empty", async () => {
      const { store } = await make();
      expect(await store.countWorkItemsByStage()).toEqual({ NEW: 0, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 0 });
      const { item } = await store.createWorkItem(issue(1), system);
      await store.createWorkItem(issue(2), system);
      await store.transition({ id: item.id, expected_version: 1, patch: { stage: "CLOSED", close_reason: "wont_do" }, actor: system, reason: "x" });
      expect(await store.countWorkItemsByStage()).toEqual({ NEW: 1, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 1 });
    });

    it("listRunsByStatus returns runs in the given statuses, oldest first, up to the limit", async () => {
      const { store, clock } = await make();
      for (let n = 1; n <= 3; n++) {
        clock.advance(1_000);
        await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      }
      const claimed = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(claimed.idempotency_key).toBe("t1");
      expect((await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key)).toEqual(["t2", "t3"]);
      expect((await store.listRunsByStatus(["queued"], 1)).map((r) => r.idempotency_key)).toEqual(["t2"]);
      expect((await store.listRunsByStatus(["running"], 10)).map((r) => r.id)).toEqual([claimed.id]);
      expect(await store.listRunsByStatus(["queued", "running"], 10)).toHaveLength(3);
      expect(await store.listRunsByStatus([], 10)).toEqual([]);
    });

    it("listRunsFinishedWithin returns runs finished inside the window, newest first", async () => {
      const { store, clock } = await make();
      const DAY = 24 * 60 * 60 * 1000;
      for (let n = 1; n <= 3; n++) {
        await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      }
      const finish = async (outcome: Parameters<FactoryStore["completeRun"]>[2]) => {
        const r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
        await store.completeRun(r.id, r.lease!.token, outcome);
        return r.id;
      };
      const old = await finish({ status: "succeeded", summary: "", data: { tokens: 5 } });
      clock.advance(DAY);
      const recentOk = await finish({ status: "succeeded", summary: "", data: { tokens: 7 } });
      clock.advance(1_000);
      const recentFail = await finish({ status: "failed", error_code: "x", detail: "", infra: false });
      clock.advance(1_000);

      const within = await store.listRunsFinishedWithin(DAY);
      expect(within.map((r) => r.id)).toEqual([recentFail, recentOk]);
      expect(within.map((r) => r.id)).not.toContain(old);
      expect((await store.listRunsFinishedWithin(DAY + 10_000)).map((r) => r.id)).toEqual([recentFail, recentOk, old]);
    });

    it("countWorkItemsWhere counts every match, with no limit, by stage, blocked_on and closed", async () => {
      const { store } = await make();
      const filter = { blocked_on: "human" as const, exclude_closed: true };
      expect(await store.countWorkItemsWhere(filter)).toBe(0);
      const ids = [];
      for (let n = 1; n <= 6; n++) ids.push((await store.createWorkItem(issue(n), system)).item.id);
      const block = (id: WorkItemId, patch: Parameters<FactoryStore["transition"]>[0]["patch"]) =>
        store.transition({ id, expected_version: 1, patch, actor: system, reason: "x" });
      await block(ids[0]!, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
      await block(ids[1]!, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
      await block(ids[2]!, { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" });
      await block(ids[3]!, { stage: "CLOSED", close_reason: "rejected", blocked_on: "human", blocked_reason: "x" });
      await block(ids[4]!, { stage: "RUNNING", blocked_on: "upstream" });
      expect(await store.countWorkItemsWhere(filter)).toBe(3);
      expect(await store.countWorkItemsWhere({ blocked_on: "human" })).toBe(4);
      expect(await store.countWorkItemsWhere({ blocked_on: "human", stage: "REVIEW" })).toBe(1);
      expect(await store.countWorkItemsWhere({})).toBe(6);
      expect(await store.countWorkItemsWhere({ exclude_closed: true })).toBe(5);
    });

    it("the read methods write nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const before = { item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) };
      await store.listWorkItemsWhere({ limit: 10 });
      await store.countWorkItemsWhere({ blocked_on: "human", exclude_closed: true });
      await store.countWorkItemsByStage();
      await store.listRunsByStatus(["queued", "running"], 10);
      await store.listRunsFinishedWithin(1_000);
      expect({ item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) }).toEqual(before);
    });
  });

  describe("verdicts", () => {
    const user = { kind: "user" as const, id: "github:1" as UserId };
    const verdict = (id: WorkItemId, expected_version: number, comment_id = "c1") => ({
      id, expected_version, actor: user, verdict: "changes" as const, severity: "minor" as const,
      reason: "rename it", comment_id, target: "pr" as const,
    });

    it("records a verdict: version + 1, a human_verdict state change with empty changes, and a linked verdict row", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({
        id: item.id, expected_version: 1, actor: system, reason: "x",
        patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 9 },
      });
      const r = await store.recordVerdict(verdict(item.id, 2));
      if (!r.ok) throw new Error(r.reason);
      expect(r.item).toMatchObject({ version: 3, stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
      expect(r.state_change).toMatchObject({ version: 3, actor: user, reason: "human_verdict", changes: {}, detail: null });
      expect(r.verdict).toMatchObject({
        work_item_id: item.id, state_change_id: r.state_change.id, verdict: "changes", severity: "minor",
        reason: "rename it", comment_id: "c1", target: "pr",
      });
      expect(await store.listVerdicts(item.id)).toEqual([r.verdict]);
      expect((await store.listStateChanges(item.id)).at(-1)).toEqual(r.state_change);

      const accept = await store.recordVerdict({ ...verdict(item.id, 3, "c2"), verdict: "accept", severity: "none", reason: null, target: "issue" });
      expect(accept.ok && accept.verdict.reason).toBeNull();
      expect((await store.listVerdicts(item.id)).map((v) => v.comment_id)).toEqual(["c1", "c2"]);
    });

    it("a duplicate comment id is a no-op, whatever the expected version", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const first = await store.recordVerdict(verdict(item.id, 1));
      if (!first.ok) throw new Error(first.reason);
      for (const v of [2, 1]) {
        expect(await store.recordVerdict(verdict(item.id, v))).toEqual({ ok: false, reason: "duplicate", verdict: first.verdict });
      }
      expect((await store.getWorkItem(item.id))!.version).toBe(2);
      expect(await store.listVerdicts(item.id)).toHaveLength(1);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
    });

    it("concurrent deliveries of one comment store one verdict", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const rs = await Promise.all([store.recordVerdict(verdict(item.id, 1)), store.recordVerdict(verdict(item.id, 1))]);
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      expect(await store.listVerdicts(item.id)).toHaveLength(1);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
    });

    it("applies only on the expected version; a conflict stores nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "READY" } });
      const r = await store.recordVerdict(verdict(item.id, 1));
      expect(r).toMatchObject({ ok: false, reason: "version_conflict", current: { version: 2, stage: "READY" } });
      expect(await store.listVerdicts(item.id)).toEqual([]);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
      expect(await store.recordVerdict(verdict("wi_missing" as WorkItemId, 1))).toEqual({ ok: false, reason: "not_found" });
    });
  });

  describe("listStatsRecords", () => {
    it("returns every item with its tier, stage, token_cost, the requested reasons and its verdict severities", async () => {
      const { store, clock } = await make();
      expect(await store.listStatsRecords(["spec_rejected", "retry_requested"])).toEqual([]);

      clock.advance(1_000);
      const a = (await store.createWorkItem(issue(1), system)).item;
      clock.advance(1_000);
      const b = (await store.createWorkItem(issue(2), system)).item;
      await store.transition({ id: a.id, expected_version: 1, actor: system, reason: "triaged", patch: { stage: "READY", tier: 2, token_cost: 40 } });
      await store.transition({ id: a.id, expected_version: 2, actor: human, reason: "retry_requested", patch: {} });
      await store.recordVerdict({
        id: a.id, expected_version: 3, actor: { kind: "user", id: "github:1" as UserId }, verdict: "changes",
        severity: "major", reason: "r", comment_id: "c1", target: "pr",
      });
      await store.transition({ id: a.id, expected_version: 4, actor: human, reason: "retry_requested", patch: {} });
      await store.recordVerdict({
        id: a.id, expected_version: 5, actor: { kind: "user", id: "github:1" as UserId }, verdict: "accept",
        severity: "none", reason: null, comment_id: "c2", target: "pr",
      });
      await store.transition({
        id: b.id, expected_version: 1, actor: human, reason: "spec_rejected",
        patch: { stage: "CLOSED", close_reason: "rejected" },
      });

      expect(await store.listStatsRecords(["spec_rejected", "retry_requested"])).toEqual([
        { id: a.id, tier: 2, stage: "READY", token_cost: 40, reasons: ["retry_requested", "retry_requested"], severities: ["major", "none"] },
        { id: b.id, tier: null, stage: "CLOSED", token_cost: 0, reasons: ["spec_rejected"], severities: [] },
      ]);
      expect((await store.listStatsRecords([])).map((r) => r.reasons)).toEqual([[], []]);
    });

    it("writes nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const before = { item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) };
      await store.listStatsRecords(["intake", "spec_rejected"]);
      expect({ item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) }).toEqual(before);
    });
  });

  describe("retry waits and the claim pause", () => {
    it("a run enqueued with not_before is not claimed before it, by any worker, and is claimed at that exact time", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const at = new Date(clock.now().getTime() + 60_000).toISOString();
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "triage", idempotency_key: "t:a1", not_before: at as never },
      });
      expect(r.ok && r.enqueued?.not_before).toBe(at);
      clock.advance(59_999);
      expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect((await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("t:a1");
    });

    it("a waiting run does not hold up a later run that may start now", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "triage", idempotency_key: "wait", not_before: new Date(clock.now().getTime() + 1_000).toISOString() as never },
      });
      await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "now" } });
      expect((await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("now");
    });

    it("the reaper requeues an expired run with the backoff it is given, stored on the run", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3, (attempt) => attempt * 10_000)).toEqual([run.id]);
      const requeued = (await store.getRun(run.id))!;
      expect(requeued).toMatchObject({ status: "queued", not_before: new Date(clock.now().getTime() + 10_000).toISOString() });
      clock.advance(9_999);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect((await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))?.id).toBe(run.id);
    });

    it("a claim pause stops every claim until resume_at; it only ever moves later", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const until = new Date(clock.now().getTime() + 30_000).toISOString();
      expect(await store.getClaimPause()).toBeNull();
      expect(await store.pauseClaims(until as never)).toEqual({ extended: true, resume_at: until });
      // An earlier time does not shorten it; the same time again is not an extension.
      expect(await store.pauseClaims(new Date(clock.now().getTime() + 1_000).toISOString() as never)).toEqual({ extended: false, resume_at: until });
      expect(await store.pauseClaims(until as never)).toEqual({ extended: false, resume_at: until });
      expect(await store.getClaimPause()).toBe(until);

      clock.advance(29_999);
      expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).not.toBeNull();
    });
  });

  describe("cancel on close", () => {
    const close = { stage: "CLOSED" as const, close_reason: "wont_do" as const, blocked_on: "none" as const, blocked_reason: null };

    it("a close with cancel_queued_runs cancels the item's queued runs, waiting ones too, in the same transaction", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const later = new Date(clock.now().getTime() + 60_000).toISOString();
      const waiting = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "implement", idempotency_key: "i", not_before: later as never },
      });
      if (!waiting.ok) throw new Error(waiting.reason);
      const other = await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });

      const r = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.cancelled).toHaveLength(2);
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
      expect(r.cancelled.sort()).toEqual(runs.map((x) => x.id).sort());
      expect(runs.every((x) => x.acknowledged_at === null && x.lease === null)).toBe(true);

      // No worker can claim them, even after the backoff; the other item's run is untouched.
      clock.advance(120_000);
      const claimed = await store.claimRun({ worker_id: w1, kinds: ["triage", "implement"], lease_ms: LEASE });
      expect(claimed!.work_item_id).toBe(other.item.id);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage", "implement"], lease_ms: LEASE })).toBeNull();

      // Cancelled runs go through the ack path like any finished run.
      const unacked = await store.listUnacknowledgedRuns(10);
      expect(unacked.map((x) => x.id).sort()).toEqual(runs.map((x) => x.id).sort());
      const ack = await store.transition({
        id: item.id, expected_version: 3, patch: {}, actor: system, reason: "run_ignored", ack_run: runs[0]!.id,
      });
      expect(ack.ok).toBe(true);
    });

    it("leaves a running run alone, and cancels nothing without the flag or when the transition loses", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const running = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "review", idempotency_key: "r" },
      });

      const plain = await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "y" });
      expect(plain.ok && plain.cancelled).toEqual([]);
      const lost = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      expect(lost).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "queued"]);

      const r = await store.transition({
        id: item.id, expected_version: 3, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "cancelled"]);
      // The running run still finishes normally.
      expect((await store.completeRun(running.id, running.lease!.token, { status: "succeeded", summary: "", data: {} })).ok).toBe(true);
    });

    it("the reaper cancels an expired run of a CLOSED item instead of requeueing it", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE });
      await store.transition({ id: item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true });
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toHaveLength(1);
      const [run] = await store.listRuns(item.id);
      expect(run).toMatchObject({ status: "cancelled", lease: null });
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
    });
  });

  describe("overlap rule: implement-type runs of overlapping items never run at once", () => {
    const ALL: RunKind[] = ["triage", "implement", "review", "update"];
    const ok = { status: "succeeded" as const, summary: "", data: {} };

    /** Item `n` with these allowed_paths and one queued run per kind given, in order. */
    async function item(store: FactoryStore, n: number, allowed_paths: string[], kinds: RunKind[]) {
      const { item } = await store.createWorkItem(issue(n), system);
      let version = 1;
      await store.transition({ id: item.id, expected_version: version++, patch: { allowed_paths }, actor: system, reason: "x" });
      for (const kind of kinds) {
        await store.transition({
          id: item.id, expected_version: version++, patch: {}, actor: system, reason: "x",
          enqueue: { kind, idempotency_key: `${n}:${kind}` },
        });
      }
      return item.id;
    }
    const claim = (store: FactoryStore, worker_id = w1) => store.claimRun({ worker_id, kinds: ALL, lease_ms: LEASE });

    it("two items with overlapping allowed_paths never have implement-type runs running at once", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["implement"]);
      const b = await item(store, 2, ["src/core/x.ts"], ["implement"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      const claimed = [first, second].filter((r) => r !== null);
      expect(claimed.map((r) => r!.work_item_id)).toEqual([a]);
      expect(await claim(store)).toBeNull();
      expect((await store.listRuns(b))[0]!.status).toBe("queued");
      expect(await store.listRunsByStatus(["running"], 10)).toHaveLength(1);
    });

    it("an update overlaps an implement, and an item overlaps itself even with no allowed_paths", async () => {
      const { store } = await make();
      await item(store, 1, ["docs/a.md"], ["implement"]);
      await item(store, 2, ["docs/a.md"], ["update"]);
      expect((await claim(store))?.kind).toBe("implement");
      expect(await claim(store)).toBeNull();

      const other = await make();
      const self = await item(other.store, 3, [], ["update", "implement"]);
      expect((await claim(other.store))?.kind).toBe("update");
      expect(await claim(other.store)).toBeNull();
      expect((await other.store.listRuns(self)).map((r) => r.status)).toEqual(["running", "queued"]);
    });

    it("two items with no overlap have runs running at the same time", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["docs/"], ["implement"]);
      const b = await item(store, 2, ["src/", "docs"], ["update"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([first?.work_item_id, second?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listRunsByStatus(["running"], 10)).toHaveLength(2);
    });

    it("the skipped run stays queued and is claimed once the overlapping run completes", async () => {
      const { store } = await make();
      await item(store, 1, ["src/"], ["implement"]);
      const b = await item(store, 2, ["src/a.ts"], ["implement"]);
      const first = (await claim(store))!;
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listRuns(b))[0]).toMatchObject({ status: "queued", attempt: 0 });

      await store.completeRun(first.id, first.lease!.token, ok);
      const next = await claim(store, w2);
      expect(next).toMatchObject({ work_item_id: b, kind: "implement", status: "running", attempt: 1 });
    });

    it("a skipped run does not hold up a later run that does not overlap (FIFO among eligible runs)", async () => {
      const { store } = await make();
      await item(store, 1, ["src/"], ["implement"]);
      const b = await item(store, 2, ["src/core/"], ["implement"]);
      const c = await item(store, 3, ["docs/"], ["implement"]);
      await claim(store);
      expect((await claim(store))?.work_item_id).toBe(c);
      expect((await store.listRuns(b))[0]!.status).toBe("queued");
    });

    it("triage and review runs are never skipped by the overlap rule", async () => {
      const { store } = await make();
      await item(store, 1, ["src/"], ["implement"]);
      const b = await item(store, 2, ["src/"], ["review", "triage", "implement"]);
      expect((await claim(store))?.kind).toBe("implement");
      const kinds = [(await claim(store))?.kind, (await claim(store))?.kind];
      expect(kinds).toEqual(["review", "triage"]);
      expect(await claim(store)).toBeNull();
      expect((await store.listRuns(b)).find((r) => r.kind === "implement")!.status).toBe("queued");
    });

    it("a running triage or review does not hold back an overlapping implement", async () => {
      const { store } = await make();
      await item(store, 1, ["src/"], ["review"]);
      const b = await item(store, 2, ["src/"], ["implement"]);
      expect((await claim(store))?.kind).toBe("review");
      expect((await claim(store))?.work_item_id).toBe(b);
    });
  });

  describe("cursors", () => {
    it("advances only from the expected value", async () => {
      const { store } = await make();
      expect(await store.advanceCursor("intake", null, "a")).toBe(true);
      expect(await store.advanceCursor("intake", null, "b")).toBe(false);
      expect(await store.advanceCursor("intake", "a", "b")).toBe(true);
      expect(await store.advanceCursor("intake", "a", "c")).toBe(false);
      expect(await store.getCursor("intake")).toBe("b");
    });
  });
});
