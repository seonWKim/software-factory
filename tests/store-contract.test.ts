import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
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
