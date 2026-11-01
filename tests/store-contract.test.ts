import { describe, expect, it } from "vitest";
import type { RunId, RunKind, UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
// One contract, every FactoryStore backend. MySQL joins when SF_TEST_MYSQL_URL is set (see helpers/store.ts).
import { BACKENDS, human, issue, system, w1, w2, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

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
      expect(await store.getWorkItemByPr(PROJECT_KEY, 34)).toBeNull();
      expect(await store.getWorkItemByMergeSha(PROJECT_KEY, "m1")).toBeNull();
      await store.transition({ id: item.id, expected_version: 1, patch: { pr_number: 34, merge_sha: "m1" }, actor: system, reason: "x" });
      expect((await store.getWorkItemByPr(PROJECT_KEY, 34))!.id).toBe(item.id);
      expect((await store.getWorkItemByMergeSha(PROJECT_KEY, "m1"))!.id).toBe(item.id);
      expect(await store.getWorkItemByPr(OTHER_PROJECT_KEY, 34)).toBeNull();
      expect(await store.getWorkItemByMergeSha(OTHER_PROJECT_KEY, "m1")).toBeNull();
      expect(await store.getWorkItemByPr(PROJECT_KEY, 35)).toBeNull();
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
        { id: a.id, tier: 2, stage: "READY", token_cost: 40, reasons: ["retry_requested", "retry_requested"], severities: ["major", "none"], origin: "factory" },
        { id: b.id, tier: null, stage: "CLOSED", token_cost: 0, reasons: ["spec_rejected"], severities: [], origin: "factory" },
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

  describe("run input", () => {
    it("stores a run's input (e.g. /resolve notes) with the run; runs enqueued without one have input null", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const notes = "keep main's API\n`x` and ünïcode, 'quotes'";
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "resolve", idempotency_key: "r", input: { notes } },
      });
      expect(r.ok && r.enqueued?.input).toEqual({ notes });
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => [x.kind, x.input])).toEqual([["triage", null], ["resolve", { notes }]]);
      const claimed = (await store.claimRun({ worker_id: w1, kinds: ["resolve"], lease_ms: LEASE }))!;
      expect(claimed.input).toEqual({ notes });
      expect((await store.getRun(claimed.id))!.input).toEqual({ notes });
    });
  });

  describe("adopted PRs, PR heads and unreviewed merges (migration 12)", () => {
    const adopted = (n: number) => ({
      ...issue(n),
      source: { type: "github_issue" as const, id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` },
      title: `PR ${n}`,
      adopted: { pr_number: n, head_branch: "feature/x", head_sha: "h1", allowed_paths: ["src/a.ts", "b/c.md"], tier: 4 as const },
    });

    it("items from intake are origin factory with no head branch or head sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      expect(item).toMatchObject({ origin: "factory", head_branch: null, last_head_sha: null });
      expect((await store.getWorkItem(item.id))!).toMatchObject({ origin: "factory", head_branch: null, last_head_sha: null });
    });

    it("an adoption creates the item at REVIEW with its PR, branch, head, paths and tier, idempotent on the source", async () => {
      const { store } = await make();
      const enqueue = { kind: "review" as const, idempotency_key: "o/r#5:adopt:review" };
      const a = await store.createWorkItem(adopted(5), human, { enqueue });
      const b = await store.createWorkItem(adopted(5), human, { enqueue });
      expect([a.created, b.created]).toEqual([true, false]);
      const it = (await store.getWorkItem(a.item.id))!;
      expect(it).toEqual(a.item);
      expect(it).toMatchObject({
        origin: "adopted", stage: "REVIEW", blocked_on: "none", pr_number: 5, head_branch: "feature/x", last_head_sha: "h1",
        allowed_paths: ["src/a.ts", "b/c.md"], tier: 4, done_criteria: null, version: 1,
      });
      expect((await store.listRuns(it.id)).map((r) => r.kind)).toEqual(["review"]);
      const [sc] = await store.listStateChanges(it.id);
      expect(sc).toMatchObject({ reason: "pr_adopted", actor: human, version: 1 });
      expect(sc!.changes).toMatchObject({ stage: { from: null, to: "REVIEW" }, pr_number: { from: null, to: 5 } });
      expect((await store.getWorkItemByPr(PROJECT_KEY, 5))!.id).toBe(it.id);
    });

    it("transitions keep origin, head_branch and last_head_sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(adopted(5), human);
      const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { blocked_on: "human" } });
      expect(r.ok && r.item).toMatchObject({ origin: "adopted", head_branch: "feature/x", last_head_sha: "h1" });
    });

    it("recordPushedHead is fenced by the run's lease and bumps no version", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
      expect(await store.recordPushedHead(run.id, run.lease!.token + 1, "x")).toEqual({ ok: false, reason: "lease_lost" });
      expect(await store.recordPushedHead(run.id, run.lease!.token, "p1")).toEqual({ ok: true });
      expect((await store.getWorkItem(item.id))!).toMatchObject({ last_head_sha: "p1", version: 1 });
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
      expect(await store.recordPushedHead(run.id, run.lease!.token, "p2")).toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getWorkItem(item.id))!.last_head_sha).toBe("p1");
    });

    it("recordPrHead: a baseline writes no run; a person's push writes one acknowledged manual run, once", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const base = await store.recordPrHead({ id: item.id, expected_head: null, head_sha: "a", manual: { actor: human, pr_number: 9 } });
      expect(base).toMatchObject({ ok: true, run: null, item: { last_head_sha: "a", version: 1 } });

      const push = { id: item.id, expected_head: "a", head_sha: "b", manual: { actor: human, pr_number: 9 } };
      const r = await store.recordPrHead(push);
      if (!r.ok || !r.run) throw new Error("expected a manual run");
      expect(r.item).toMatchObject({ last_head_sha: "b", version: 1, stage: "NEW", blocked_on: "none" });
      expect(r.run).toMatchObject({
        kind: "manual", status: "succeeded", attempt: 0, lease: null, work_item_id: item.id,
        outcome: { status: "succeeded", data: { actor: human, from_sha: "a", to_sha: "b", pr_number: 9 } },
      });
      expect(r.run.acknowledged_at).not.toBeNull();
      expect(r.run.finished_at).not.toBeNull();
      expect(await store.recordPrHead(push)).toMatchObject({ ok: false, reason: "head_moved", current: { last_head_sha: "b" } });
      expect((await store.listRuns(item.id)).filter((x) => x.kind === "manual")).toHaveLength(1);
      expect(await store.listUnacknowledgedRuns(10)).toEqual([]);
      expect(await store.claimRun({ worker_id: w1, kinds: ["manual"], lease_ms: LEASE })).toBeNull();
      expect(await store.listStateChanges(item.id)).toHaveLength(1);
      expect(await store.recordPrHead({ ...push, id: "wi_missing" as WorkItemId })).toEqual({ ok: false, reason: "not_found" });
    });

    it("recordUnreviewedMerge is idempotent on (project, pr_number); listUnreviewedMerges is newest first", async () => {
      const { store, clock } = await make();
      const a = await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 7, merge_sha: "m7", merger_id: "github:1" as UserId });
      clock.advance(1000);
      const again = await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 7, merge_sha: "other", merger_id: null });
      const b = await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 8, merge_sha: "m8", merger_id: null });
      const c = await store.recordUnreviewedMerge({ project: OTHER_PROJECT_KEY, pr_number: 7, merge_sha: "m7b", merger_id: null });
      expect([a.created, again.created, b.created, c.created]).toEqual([true, false, true, true]);
      expect(again.merge).toEqual(a.merge);
      expect(a.merge).toMatchObject({ project: PROJECT_KEY, pr_number: 7, merge_sha: "m7", merger_id: "github:1" });
      const rows = await store.listUnreviewedMerges(10);
      expect(rows.map((r) => [r.project, r.pr_number])).toEqual([[OTHER_PROJECT_KEY, 7], [PROJECT_KEY, 8], [PROJECT_KEY, 7]]);
      expect(await store.listUnreviewedMerges(1)).toHaveLength(1);
    });
  });

  describe("budget checkpoints", () => {
    const held = {
      tier: 2 as const,
      tokens_spent: 1_200_000,
      budget: 1_000_000,
      suggested_budget: 2_000_000,
      held_run_kind: "review" as const,
      held_run_key: "k:review:l0:r0",
      held_run_not_before: null,
    };
    const block = { blocked_on: "budget" as const, blocked_reason: "budget_checkpoint" };

    async function opened(store: FactoryStore) {
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.openBudgetCheckpoint({
        id: item.id, expected_version: 1, patch: block, actor: system, reason: "budget_checkpoint", checkpoint: held,
      });
      if (!r.ok) throw new Error(r.reason);
      return r;
    }

    it("opens a pending checkpoint in the same transaction as the block and its state change", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      expect(r.item).toMatchObject({ version: 2, blocked_on: "budget", blocked_reason: "budget_checkpoint" });
      expect(r.state_change.reason).toBe("budget_checkpoint");
      expect(r.enqueued).toBeNull();
      expect(r.checkpoint).toMatchObject({
        ...held, work_item_id: r.item.id, answer: "pending", granted_budget: null, outcome: null,
        created_at: clock.now().toISOString(), answered_at: null,
      });
      expect(await store.listBudgetCheckpoints(r.item.id)).toEqual([r.checkpoint]);
      expect(await store.listRuns(r.item.id)).toEqual([]);
    });

    it("opens nothing on a version conflict, or while another checkpoint of the item is pending", async () => {
      const { store } = await make();
      const { item: other } = await store.createWorkItem(issue(2), system);
      const stale = { id: other.id, expected_version: 0, patch: block, actor: system, reason: "budget_checkpoint", checkpoint: held };
      expect(await store.openBudgetCheckpoint(stale)).toMatchObject({ ok: false, reason: "version_conflict" });
      expect(await store.listBudgetCheckpoints(other.id)).toEqual([]);
      expect(await store.listStateChanges(other.id)).toHaveLength(1);

      const r = await opened(store);
      const again = { id: r.item.id, patch: {}, actor: system, reason: "budget_checkpoint", checkpoint: held };
      expect(await store.openBudgetCheckpoint({ ...again, expected_version: 2 })).toEqual({ ok: false, reason: "checkpoint_pending" });
      expect(await store.listBudgetCheckpoints(r.item.id)).toHaveLength(1);
      expect(await store.listStateChanges(r.item.id)).toHaveLength(2);
    });

    it("answers a pending checkpoint once, enqueueing the held run with its key and not_before in the same transaction", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      clock.advance(5_000);
      const at = new Date(clock.now().getTime() + 1_000).toISOString();
      const answer = {
        id: r.item.id, patch: { blocked_on: "none" as const, blocked_reason: null }, actor: human, reason: "budget_continued",
        checkpoint_id: r.checkpoint.id, answer: "continued_custom" as const, granted_budget: 9_000_000,
        enqueue: { kind: "review" as const, idempotency_key: held.held_run_key, not_before: at as never },
      };
      const a = await store.answerBudgetCheckpoint({ ...answer, expected_version: 2 });
      if (!a.ok) throw new Error(a.reason);
      expect(a.item).toMatchObject({ version: 3, blocked_on: "none" });
      expect(a.state_change).toMatchObject({ reason: "budget_continued", actor: human });
      expect(a.enqueued).toMatchObject({ kind: "review", idempotency_key: held.held_run_key, not_before: at, status: "queued" });
      expect(a.checkpoint).toMatchObject({
        answer: "continued_custom", granted_budget: 9_000_000, answered_at: clock.now().toISOString(), outcome: null,
      });
      // A second answer (a redelivery) changes nothing, whatever the version.
      expect(await store.answerBudgetCheckpoint({ ...answer, expected_version: 3 })).toEqual({ ok: false, reason: "checkpoint_not_pending" });
      expect(await store.listStateChanges(r.item.id)).toHaveLength(3);
      expect(await store.listRuns(r.item.id)).toHaveLength(1);
    });

    it("an answer on a version conflict changes nothing", async () => {
      const { store } = await make();
      const r = await opened(store);
      const a = await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 1, patch: {}, actor: human, reason: "budget_continued",
        checkpoint_id: r.checkpoint.id, answer: "continued_suggested", granted_budget: 2_000_000,
        enqueue: { kind: "review", idempotency_key: held.held_run_key },
      });
      expect(a).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listBudgetCheckpoints(r.item.id))[0]).toMatchObject({ answer: "pending", granted_budget: null });
      expect(await store.listRuns(r.item.id)).toEqual([]);
    });

    it("a rejecting answer that closes the item sets answer rejected and outcome rejected", async () => {
      const { store } = await make();
      const r = await opened(store);
      const a = await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 2, actor: human, reason: "budget_rejected",
        patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
        checkpoint_id: r.checkpoint.id, answer: "rejected", granted_budget: null,
      });
      if (!a.ok) throw new Error(a.reason);
      expect(a.checkpoint).toMatchObject({ answer: "rejected", granted_budget: null, outcome: "rejected" });
    });

    for (const [close_reason, outcome] of [["completed", "merged"], ["rejected", "rejected"], ["failed", "failed"]] as const) {
      it(`closing the item with ${close_reason} sets the open checkpoint's outcome to ${outcome}, in the same transition`, async () => {
        const { store } = await make();
        const r = await opened(store);
        await store.transition({
          id: r.item.id, expected_version: 2, actor: system, reason: "close",
          patch: { stage: "CLOSED", close_reason, blocked_on: "none", blocked_reason: null },
        });
        expect((await store.listBudgetCheckpoints(r.item.id))[0]).toMatchObject({ answer: "pending", outcome });
      });
    }

    it("lists an item's checkpoints oldest first; an outcome already set is not overwritten", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 2, patch: { blocked_on: "none", blocked_reason: null }, actor: human,
        reason: "budget_continued", checkpoint_id: r.checkpoint.id, answer: "continued_suggested", granted_budget: 2_000_000,
      });
      clock.advance(1_000);
      const second = await store.openBudgetCheckpoint({
        id: r.item.id, expected_version: 3, patch: { blocked_on: "budget", blocked_reason: "budget_checkpoint" }, actor: system,
        reason: "budget_checkpoint", checkpoint: { ...held, tokens_spent: 2_100_000, budget: 2_000_000, held_run_key: "k2" },
      });
      if (!second.ok) throw new Error(second.reason);
      await store.transition({
        id: r.item.id, expected_version: 4, actor: system, reason: "pr_merged",
        patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null },
      });
      // A later transition of a closed item does not touch the outcome again.
      await store.transition({ id: r.item.id, expected_version: 5, actor: system, reason: "x", patch: { close_reason: "rejected" } });
      const list = await store.listBudgetCheckpoints(r.item.id);
      expect(list.map((c) => [c.held_run_key, c.answer, c.outcome])).toEqual([
        ["k:review:l0:r0", "continued_suggested", "merged"],
        ["k2", "pending", "merged"],
      ]);
      expect(await store.listBudgetCheckpoints("wi_missing" as WorkItemId)).toEqual([]);
    });

    it("tier history: finished (CLOSED) items of the project and tier, and token_cost of the merged ones", async () => {
      const { store } = await make();
      const close = async (n: number, tier: 1 | 2, close_reason: "completed" | "rejected" | null, token_cost: number, project = PROJECT_KEY) => {
        const { item } = await store.createWorkItem({ ...issue(n), project }, system);
        await store.transition({
          id: item.id, expected_version: 1, actor: system, reason: "x",
          patch: close_reason ? { tier, token_cost, stage: "CLOSED", close_reason } : { tier, token_cost, stage: "RUNNING" },
        });
      };
      await close(1, 2, "completed", 300);
      await close(2, 2, "completed", 100);
      await close(3, 2, "rejected", 900);
      await close(4, 2, null, 5_000);
      await close(5, 1, "completed", 7_000);
      await close(6, 2, "completed", 8_000, OTHER_PROJECT_KEY);
      const h = await store.getTierHistory(PROJECT_KEY, 2);
      expect(h.finished).toBe(3);
      expect([...h.merged_token_costs].sort((a, b) => a - b)).toEqual([100, 300]);
      expect(await store.getTierHistory(PROJECT_KEY, 4)).toEqual({ finished: 0, merged_token_costs: [] });
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

    it("a close with cancel_running_runs stops every running run of the item, of any kind, in the same write", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const triage = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "update", idempotency_key: "u" },
      });
      const update = (await store.claimRun({ worker_id: w2, kinds: ["update"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "review", idempotency_key: "r" },
      });
      const other = await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });
      const otherRun = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(otherRun.work_item_id).toBe(other.item.id);

      // Losing the version check stops nothing.
      const lost = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed",
        cancel_queued_runs: true, cancel_running_runs: true,
      });
      expect(lost).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "running", "queued"]);

      const r = await store.transition({
        id: item.id, expected_version: 3, patch: close, actor: human, reason: "source_closed",
        cancel_queued_runs: true, cancel_running_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => x.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(runs.every((x) => x.lease === null && x.outcome === null && x.acknowledged_at === null)).toBe(true);
      expect([...r.cancelled].sort()).toEqual(runs.map((x) => x.id).sort());

      // The stopped runs lose their lease: the next heartbeat fails, and the outcome is not stored.
      expect(await store.heartbeat(triage.id, triage.lease!.token, LEASE)).toEqual({ ok: false, reason: "lease_lost" });
      expect(await store.completeRun(update.id, update.lease!.token, { status: "succeeded", summary: "", data: {} }))
        .toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getRun(update.id))).toMatchObject({ status: "cancelled", outcome: null });
      // Another item's running run is untouched.
      expect((await store.getRun(otherRun.id))!.status).toBe("running");
      expect((await store.heartbeat(otherRun.id, otherRun.lease!.token, LEASE)).ok).toBe(true);
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

  describe("one branch writer per item: overlapping paths do not hold runs back", () => {
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

    it("two items with overlapping allowed_paths have implement-type runs running at the same time", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/", "docs/design.md"], ["implement"]);
      const b = await item(store, 2, ["src/core/x.ts", "docs/design.md"], ["update"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([first?.work_item_id, second?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listRunsByStatus(["running"], 10)).toHaveLength(2);
    });

    it("an item never has two implement-type runs running at once, even with no allowed_paths", async () => {
      const { store } = await make();
      const self = await item(store, 3, [], ["update", "implement"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect([first, second].filter((r) => r !== null).map((r) => r!.kind)).toEqual(["update"]);
      expect(await claim(store)).toBeNull();
      expect((await store.listRuns(self)).map((r) => r.status)).toEqual(["running", "queued"]);
    });

    it("the held run stays queued and is claimed once its item's run completes", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["update", "implement"]);
      const first = (await claim(store))!;
      expect(await claim(store, w2)).toBeNull();
      await store.completeRun(first.id, first.lease!.token, ok);
      expect(await claim(store, w2)).toMatchObject({ work_item_id: a, kind: "implement", status: "running", attempt: 1 });
    });

    it("a held run does not hold up a later run of another item (FIFO among eligible runs)", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["update", "implement"]);
      const b = await item(store, 2, ["src/"], ["implement"]);
      await claim(store);
      expect((await claim(store))?.work_item_id).toBe(b);
      expect((await store.listRuns(a)).find((r) => r.kind === "implement")!.status).toBe("queued");
    });

    it("triage and review runs are never held back, and do not hold back an implement", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["implement", "review", "triage"]);
      // Kind rank: review, then triage, then the implement that was queued before both.
      expect([(await claim(store))?.kind, (await claim(store))?.kind]).toEqual(["review", "triage"]);
      expect((await claim(store))?.kind).toBe("implement");

      const other = await make();
      await item(other.store, 2, ["src/"], ["review", "implement"]);
      expect((await claim(other.store))?.kind).toBe("review");
      expect((await claim(other.store))?.kind).toBe("implement");
      expect(a).toBeTruthy();
    });
  });

  describe("claim order: kind rank, then created_at, then insertion order", () => {
    const ALL_KINDS: RunKind[] = ["triage", "implement", "review", "update", "resolve"];
    const claim = (store: FactoryStore, worker_id = w1) => store.claimRun({ worker_id, kinds: ALL_KINDS, lease_ms: LEASE });
    const enqueue = (store: FactoryStore, n: number, kind: RunKind, not_before?: string) =>
      store.createWorkItem(issue(n), system, { enqueue: { kind, idempotency_key: `${n}:${kind}`, not_before: not_before as never } });

    it("a queued review and a queued triage, created after an older implement, are claimed before it", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      clock.advance(1_000);
      await enqueue(store, 2, "triage");
      clock.advance(1_000);
      await enqueue(store, 3, "review");
      expect([(await claim(store))?.kind, (await claim(store))?.kind, (await claim(store))?.kind]).toEqual([
        "review", "triage", "implement",
      ]);
    });

    it("ranks review, triage, update, implement, resolve, whatever their age", async () => {
      const { store, clock } = await make();
      for (const [n, kind] of (["resolve", "implement", "update", "triage", "review"] as RunKind[]).entries()) {
        await enqueue(store, n + 1, kind);
        clock.advance(1_000);
      }
      const order: (RunKind | undefined)[] = [];
      for (let i = 0; i < 5; i++) order.push((await claim(store))?.kind);
      expect(order).toEqual(["review", "triage", "update", "implement", "resolve"]);
    });

    it("within one kind, the oldest queued run is claimed first; equal created_at breaks on insertion order", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      await enqueue(store, 2, "implement"); // same created_at as #1
      clock.advance(1_000);
      await enqueue(store, 3, "implement");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await claim(store))!.idempotency_key);
      expect(ids).toEqual(["1:implement", "2:implement", "3:implement"]);
    });

    it("a held implement-type run does not block a later run of any kind behind it", async () => {
      const { store, clock } = await make();
      // Held by its item's running branch writer: item 1 has update running and implement queued.
      const { item: a } = await enqueue(store, 1, "update");
      expect((await claim(store))?.kind).toBe("update");
      await store.transition({
        id: a.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "implement", idempotency_key: "1:implement" },
      });
      // Held by not_before: an update that may not start yet.
      await enqueue(store, 2, "update", new Date(clock.now().getTime() + 60_000).toISOString());
      clock.advance(1_000);
      for (const [n, kind] of (["implement", "resolve", "triage", "review", "update"] as RunKind[]).entries()) {
        await enqueue(store, n + 10, kind);
      }
      const order: (string | undefined)[] = [];
      for (let i = 0; i < 5; i++) order.push((await claim(store))?.idempotency_key);
      expect(order).toEqual(["13:review", "12:triage", "14:update", "10:implement", "11:resolve"]);
      expect(await claim(store)).toBeNull();
      const held = (await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key).sort();
      expect(held).toEqual(["1:implement", "2:update"]);
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

  describe("source inbox", () => {
    const slack = "slack_thread" as const;
    const ev = (n: number): SourceEvent => ({
      kind: "item_requested",
      source: { type: slack, id: `C1/${n}`, link: `https://slack.example/C1/${n}` },
      requester: { provider: "slack", subject: "U1" },
      title: `t${n}`,
      body: `b${n}`,
    });
    async function leased(store: FactoryStore): Promise<number> {
      const r = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!r.ok) throw new Error(r.reason);
      return r.lease.token;
    }

    it("appends in sequence order and reads back after a cursor", async () => {
      const { store } = await make();
      const token = await leased(store);
      const seqs: number[] = [];
      for (const n of [1, 2, 3]) {
        const r = await store.appendInbox({ source_type: slack, dedupe_key: `k${n}`, event: ev(n), lease_token: token });
        if (!r.ok) throw new Error(r.reason);
        expect(r.duplicate).toBe(false);
        seqs.push(r.row.seq);
      }
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(3);

      const all = await store.listInboxAfter(slack, 0, 10);
      expect(all.map((r) => r.dedupe_key)).toEqual(["k1", "k2", "k3"]);
      expect(all[0]).toMatchObject({ seq: seqs[0], source_type: slack, event: ev(1) });
      expect(typeof all[0]!.received_at).toBe("string");
      expect((await store.listInboxAfter(slack, seqs[0]!, 10)).map((r) => r.dedupe_key)).toEqual(["k2", "k3"]);
      expect((await store.listInboxAfter(slack, 0, 2)).map((r) => r.dedupe_key)).toEqual(["k1", "k2"]);
      expect(await store.listInboxAfter("github_issue", 0, 10)).toEqual([]);
    });

    it("a duplicate dedupe_key is a no-op that reports the stored row", async () => {
      const { store } = await make();
      const token = await leased(store);
      const first = await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: token });
      const again = await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(2), lease_token: token });
      expect(again).toEqual({ ok: true, duplicate: true, row: first.ok && first.row });
      expect(await store.listInboxAfter(slack, 0, 10)).toHaveLength(1);
    });

    it("refuses the write without the listener lease, or with a stale token", async () => {
      const { store, clock } = await make();
      expect(await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: 1 })).toEqual({
        ok: false, reason: "lease_lost",
      });
      const old = await leased(store);
      clock.advance(LEASE + 1);
      const b = await store.acquireListenerLease(slack, "replica-b", LEASE);
      if (!b.ok) throw new Error(b.reason);
      expect(await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: old })).toEqual({
        ok: false, reason: "lease_lost",
      });
      expect(await store.listInboxAfter(slack, 0, 10)).toEqual([]);
      expect((await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: b.lease.token })).ok).toBe(true);
    });

    it("prune deletes only rows both older than the retention and at or below the cursor", async () => {
      const { store, clock } = await make();
      const token = await leased(store);
      const append = async (k: string) => {
        const r = await store.appendInbox({ source_type: slack, dedupe_key: k, event: ev(1), lease_token: token });
        if (!r.ok) throw new Error(r.reason);
        return r.row.seq;
      };
      const oldA = await append("old-a");
      const oldB = await append("old-b");
      clock.advance(10_000);
      const fresh = await append("fresh");
      clock.advance(5_000);
      // Retention 8s: old-a and old-b are older, fresh is not. Cursor at old-a: old-b is still ahead of it.
      expect(await store.pruneInbox(slack, oldA, 8_000)).toBe(1);
      expect((await store.listInboxAfter(slack, 0, 10)).map((r) => r.dedupe_key)).toEqual(["old-b", "fresh"]);
      // Cursor past everything: fresh stays because it is newer than the retention.
      expect(await store.pruneInbox(slack, fresh, 8_000)).toBe(1);
      expect((await store.listInboxAfter(slack, 0, 10)).map((r) => r.dedupe_key)).toEqual(["fresh"]);
      expect(oldB).toBeGreaterThan(oldA);
      // Sequence numbers keep growing after the newest rows are deleted.
      clock.advance(10_000);
      expect(await store.pruneInbox(slack, fresh, 8_000)).toBe(1);
      expect(await append("next")).toBeGreaterThan(fresh);
    });
  });

  describe("listener lease", () => {
    const slack = "slack_thread" as const;

    it("one owner at a time; the token goes up on every take", async () => {
      const { store } = await make();
      const [a, b] = await Promise.all([
        store.acquireListenerLease(slack, "replica-a", LEASE),
        store.acquireListenerLease(slack, "replica-b", LEASE),
      ]);
      const won = [a, b].filter((r) => r.ok);
      expect(won).toHaveLength(1);
      const lost = [a, b].find((r) => !r.ok)!;
      expect(lost).toMatchObject({ ok: false, reason: "held", holder: { token: 1 } });
      // Another source type has its own lease.
      expect((await store.acquireListenerLease("github_issue", "replica-b", LEASE)).ok).toBe(true);
    });

    it("renew extends the lease while the token is current, even past expiry", async () => {
      const { store, clock } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE - 1);
      const r = await store.renewListenerLease(slack, a.lease.token, LEASE);
      expect(r).toMatchObject({ ok: true, lease: { owner: "replica-a", token: a.lease.token } });
      expect(r.ok && r.lease.expires_at).toBe(new Date(clock.now().getTime() + LEASE).toISOString());
      clock.advance(LEASE - 1);
      expect((await store.acquireListenerLease(slack, "replica-b", LEASE)).ok).toBe(false);
      // Expired but not taken: the holder can still renew (host sleep), as with run leases.
      clock.advance(10);
      expect((await store.renewListenerLease(slack, a.lease.token, LEASE)).ok).toBe(true);
    });

    it("another owner takes over after expiry; the old token is refused", async () => {
      const { store, clock } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE);
      const b = await store.acquireListenerLease(slack, "replica-b", LEASE);
      expect(b).toMatchObject({ ok: true, lease: { owner: "replica-b", token: a.lease.token + 1 } });
      expect(await store.renewListenerLease(slack, a.lease.token, LEASE)).toMatchObject({
        ok: false, reason: "lease_lost", holder: { owner: "replica-b" },
      });
      // A stale release changes nothing.
      await store.releaseListenerLease(slack, a.lease.token);
      expect((await store.acquireListenerLease(slack, "replica-c", LEASE)).ok).toBe(false);
    });

    it("release lets another owner take the lease at once", async () => {
      const { store } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      await store.releaseListenerLease(slack, a.lease.token);
      expect(await store.acquireListenerLease(slack, "replica-b", LEASE)).toMatchObject({ ok: true, lease: { owner: "replica-b" } });
    });
  });
});
