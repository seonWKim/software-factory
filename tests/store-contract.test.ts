import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { HostSleep, RunId, RunKind, Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { projectLabelCursor } from "../src/core/project.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { FactoryStore, NewAlert, WorkerProcessReport } from "../src/interfaces/factory-store.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
// One contract, every FactoryStore backend. MySQL joins when SF_TEST_MYSQL_URL is set (see helpers/store.ts).
import { BACKENDS, MYSQL_URL, mysqlStepsUpTo, newEmptyMysqlDatabase, human, issue, system, w1, w2, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

const LEASE = 60_000;
/** A project label as the cursor `project_label:<key>` stores it, and the PR link built like prUrl in src/main.ts. */
const LABEL = "github.com/o/r";
const prUrl = (label: string, n: number) => `https://${label}/pull/${n}`;
/** The SQLite migration that adds the change columns, found by what it does so a renumber at merge needs no edit. */
const CHANGE_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN change_ref")) + 1;

describe.each(BACKENDS)("FactoryStore contract: $name", ({ name, make: makeBackend }) => {
  const make = makeBackend;
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

    it("intake can start held on upstream, with a detail on its intake row and no run", async () => {
      const { store } = await make();
      const detail = { parent_work_item_id: "wi_parent", phase: 2, phases: 3, depends_on: "o/r#10" };
      const a = await store.createWorkItem(
        { ...issue(11), hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } },
        system,
        { detail },
      );
      expect(a.item).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold" });
      expect(await store.listRuns(a.item.id)).toHaveLength(0);
      const [row] = await store.listStateChanges(a.item.id);
      expect(row).toMatchObject({ reason: "intake", detail });
      expect(row!.changes).toMatchObject({ blocked_on: { from: "none", to: "upstream" }, blocked_reason: { from: null, to: "phase_hold" } });
      // A repeat is the same item, still held.
      const b = await store.createWorkItem({ ...issue(11), hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } }, system, { detail });
      expect(b).toMatchObject({ created: false, item: { id: a.item.id, blocked_reason: "phase_hold" } });
      // Without hold or detail, intake is as before.
      const c = await store.createWorkItem(issue(12), system);
      expect(c.item).toMatchObject({ blocked_on: "none", blocked_reason: null });
      expect((await store.listStateChanges(c.item.id))[0]!.detail).toBeNull();
    });

    it("a phase stores its parent link and phase number; listPhases returns a parent's phases in phase order", async () => {
      const { store } = await make();
      const parent = (await store.createWorkItem(issue(20), system)).item;
      expect(parent).toMatchObject({ parent_id: null, phase: null });
      // Filed out of order on purpose: listPhases sorts by phase, not by intake.
      const p2 = (await store.createWorkItem({ ...issue(22), parent: { id: parent.id, phase: 2 } }, system)).item;
      const p1 = (await store.createWorkItem({ ...issue(21), parent: { id: parent.id, phase: 1 } }, system)).item;
      const other = (await store.createWorkItem(issue(30), system)).item;
      await store.createWorkItem({ ...issue(31), parent: { id: other.id, phase: 1 } }, system);
      expect(p1).toMatchObject({ parent_id: parent.id, phase: 1 });
      expect((await store.getWorkItem(p2.id))!).toMatchObject({ parent_id: parent.id, phase: 2 });
      expect((await store.listPhases(parent.id)).map((p) => [p.id, p.phase])).toEqual([[p1.id, 1], [p2.id, 2]]);
      expect(await store.listPhases(p1.id)).toEqual([]);
      // The link is store-owned: a transition keeps it.
      const r = await store.transition({ id: p2.id, expected_version: p2.version, patch: { blocked_on: "human" }, actor: system, reason: "t" });
      expect(r.ok && r.item).toMatchObject({ parent_id: parent.id, phase: 2 });
    });

    it("transition applies only on the expected version; the loser gets version_conflict", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const base = { id: item.id, expected_version: 1, actor: system, reason: "test" };
      const [first, second] = await Promise.all([
        store.transition({ ...base, patch: { stage: "READY" } }),
        store.transition({ ...base, patch: { stage: "CLOSED", close_reason: "wont_do" } }),
      ]);
      // Either may win: SQLite runs them in order, a MySQL pool may not. Exactly one applies.
      const winner = first.ok ? first : second;
      const loser = first.ok ? second : first;
      if (!winner.ok) throw new Error("neither transition applied");
      expect(loser).toMatchObject({ ok: false, reason: "version_conflict", current: { version: 2, stage: winner.item.stage } });
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

  describe("run attempts (design §6): one record per claim", () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: null, model: null };
    const close = { stage: "CLOSED" as const, close_reason: "wont_do" as const, blocked_on: "none" as const, blocked_reason: null };

    async function queued(key = "t") {
      const ctx = await make();
      const { item } = await ctx.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: key } });
      return { ...ctx, item };
    }
    const claim = (store: FactoryStore, worker = w1) => store.claimRun({ worker_id: worker, kinds: ["triage"], lease_ms: LEASE });

    it("a claim writes one running record with the run, attempt 1, worker and start; queued runs have none", async () => {
      const { store, clock, item } = await queued();
      expect(await store.listRunAttempts(item.id)).toEqual([]);
      clock.advance(1_000);
      const run = (await claim(store))!;
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "running", started_at: clock.now().toISOString(),
          finished_at: null, error_code: null, failure_class: null, tokens: 0,
        },
      ]);
      // The fencing token is never part of the record.
      expect(Object.keys((await store.listRunAttempts(item.id))[0]!)).not.toContain("lease_token");
    });

    it("completeRun closes the claim's record: succeeded with tokens, no error code and no failure class", async () => {
      const { store, clock, item } = await queued();
      const run = (await claim(store))!;
      clock.advance(5_000);
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: { tokens: 1234 } });
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "succeeded", started_at: run.started_at,
          finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 1234,
        },
      ]);
    });

    it("a failed outcome stores its error code, failureClass() and outcomeTokens()", async () => {
      const cases = [
        [{ status: "failed" as const, error_code: "agent_error", detail: "", infra: false, usage }, "task", 20],
        [{ status: "failed" as const, error_code: "push_failed", detail: "", infra: true }, "infra", 0],
        [{ status: "failed" as const, error_code: "rate_limited", detail: "", infra: true, usage }, "rate_limited", 20],
        [{ status: "failed" as const, error_code: "agent_stalled", detail: "", infra: true }, "stalled", 0],
      ] as const;
      // One store for every case (a fresh MySQL database per case is slow): one item each, claimed in turn.
      const { store } = await make();
      for (const [i, [outcome, cls, tokens]] of cases.entries()) {
        const { item } = await store.createWorkItem(issue(i + 1), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
        const run = (await claim(store))!;
        expect(run.work_item_id).toBe(item.id);
        await store.completeRun(run.id, run.lease!.token, outcome);
        expect(await store.listRunAttempts(item.id)).toMatchObject([
          { status: "failed", error_code: outcome.error_code, failure_class: cls, tokens },
        ]);
      }
    });

    it("a stale token closes nothing: the close is conditional on the token that opened the record", async () => {
      const { store, clock, item } = await queued();
      const first = (await claim(store))!;
      clock.advance(LEASE + 1);
      await store.expireLeases(3);
      const second = (await claim(store, w2))!;
      expect(await store.completeRun(first.id, first.lease!.token, { status: "succeeded", summary: "", data: { tokens: 9 } }))
        .toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.listRunAttempts(item.id)).map((a) => [a.attempt, a.worker_id, a.status, a.tokens])).toEqual([
        [1, w1, "lease_expired", 0],
        [2, w2, "running", 0],
      ]);
      await store.completeRun(second.id, second.lease!.token, { status: "succeeded", summary: "", data: { tokens: 9 } });
      expect((await store.listRunAttempts(item.id)).map((a) => a.status)).toEqual(["lease_expired", "succeeded"]);
    });

    it("the reaper closes a record as lease_expired, infra, tokens 0, whether it requeues, fails or cancels the run", async () => {
      const { store, clock, item } = await queued();
      for (let i = 0; i < 2; i++) {
        await claim(store);
        clock.advance(LEASE + 1);
        await store.expireLeases(2);
      }
      const at = clock.now().toISOString();
      expect((await store.listRuns(item.id))[0]!.status).toBe("failed");
      const attempts = await store.listRunAttempts(item.id);
      expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
      for (const a of attempts) {
        expect(a).toMatchObject({ status: "lease_expired", error_code: "lease_expired", failure_class: "infra", tokens: 0 });
      }
      expect(attempts[1]!.finished_at).toBe(at);

      // An expired run of a CLOSED item is cancelled, and its record still closes as lease_expired.
      const other = await queued("t2");
      await claim(other.store);
      await other.store.transition({ id: other.item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed" });
      other.clock.advance(LEASE + 1);
      await other.store.expireLeases(3);
      expect((await other.store.listRuns(other.item.id))[0]!.status).toBe("cancelled");
      expect(await other.store.listRunAttempts(other.item.id)).toMatchObject([{ status: "lease_expired", failure_class: "infra" }]);
    });

    it("a close that stops running runs closes their records as cancelled", async () => {
      const { store, clock, item } = await queued();
      await claim(store);
      clock.advance(1_000);
      await store.transition({
        id: item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed", cancel_running_runs: true,
      });
      expect(await store.listRunAttempts(item.id)).toMatchObject([
        { status: "cancelled", finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 0 },
      ]);
    });

    it("pause and resume: the pause closes the record as paused, the resume opens attempt 2; run.attempt stays 1", async () => {
      const { store, clock, item } = await queued();
      const run = (await claim(store))!;
      clock.advance(1_000);
      const resume = { host: "h", folder: "sbx_1", base_sha: null, start_sha: null, head: null, bundle: null };
      expect((await store.pauseRun(run.id, run.lease!.token, { paused_by: "github:1", session_id: null, resume })).ok).toBe(true);
      const pausedAt = clock.now().toISOString();
      clock.advance(1_000);
      const resumed = (await claim(store, w2))!;
      expect(resumed.attempt).toBe(1);
      clock.advance(1_000);
      await store.completeRun(resumed.id, resumed.lease!.token, { status: "succeeded", summary: "", data: { tokens: 7 } });
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "paused", started_at: run.started_at, finished_at: pausedAt,
          error_code: null, failure_class: null, tokens: 0,
        },
        {
          run_id: run.id, attempt: 2, worker_id: w2, status: "succeeded", started_at: resumed.started_at,
          finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 7,
        },
      ]);
      expect((await store.getRun(run.id))!.attempt).toBe(1);
    });

    it("lists the item's attempts by run, then attempt; other items' attempts are not included", async () => {
      const { store, item } = await queued();
      const a = (await claim(store))!;
      await store.completeRun(a.id, a.lease!.token, { status: "failed", error_code: "agent_error", detail: "", infra: false, usage });
      await store.transition({ id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "t:2" } });
      const b = (await claim(store))!;
      await store.completeRun(b.id, b.lease!.token, { status: "succeeded", summary: "", data: { tokens: 50 } });
      const other = (await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "o" } })).item;
      await claim(store);
      expect((await store.listRunAttempts(item.id)).map((x) => [x.run_id, x.attempt, x.status, x.tokens])).toEqual([
        [a.id, 1, "failed", 20],
        [b.id, 1, "succeeded", 50],
      ]);
      expect(await store.listRunAttempts(other.id)).toHaveLength(1);
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
      reason: "rename it", comment_id, target: "pr" as const, implicit: false, pr_head: null,
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

    it("an implicit verdict: an implicit_verdict state change, implicit and pr_head stored, no other field changed", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.recordVerdict({ ...verdict(item.id, 1, "implicit:pushed:h2"), actor: system, implicit: true, pr_head: "h2" });
      if (!r.ok) throw new Error(r.reason);
      expect(r.item).toMatchObject({ version: 2, stage: item.stage, blocked_on: item.blocked_on, blocked_reason: item.blocked_reason });
      expect(r.state_change).toMatchObject({ version: 2, actor: system, reason: "implicit_verdict", changes: {} });
      expect(r.verdict).toMatchObject({ implicit: true, pr_head: "h2", comment_id: "implicit:pushed:h2" });
      expect(await store.listVerdicts(item.id)).toEqual([r.verdict]);
    });

    it("one verdict per PR head: a second implicit one is a duplicate; an explicit one replaces the implicit one", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const implicit = { ...verdict(item.id, 1, "implicit:pushed:h2"), actor: system, implicit: true, pr_head: "h2" };
      const first = await store.recordVerdict(implicit);
      if (!first.ok) throw new Error(first.reason);
      const again = await store.recordVerdict({ ...implicit, expected_version: 2, comment_id: "implicit:merged:m1", verdict: "accept" });
      expect(again).toEqual({ ok: false, reason: "duplicate", verdict: first.verdict });
      // Another head is its own.
      const other = await store.recordVerdict({ ...implicit, expected_version: 2, comment_id: "implicit:pushed:h3", pr_head: "h3" });
      expect(other.ok).toBe(true);

      const explicit = await store.recordVerdict({ ...verdict(item.id, 3, "c9"), verdict: "accept", severity: "none", reason: null, pr_head: "h2" });
      if (!explicit.ok) throw new Error(explicit.reason);
      expect((await store.listVerdicts(item.id)).map((v) => [v.comment_id, v.pr_head, v.implicit])).toEqual([
        ["implicit:pushed:h3", "h3", true],
        ["c9", "h2", false],
      ]);
      // An implicit one after the explicit one on that head stores nothing; the replaced one's state change stays.
      expect(await store.recordVerdict({ ...implicit, expected_version: 4, comment_id: "implicit:merged:m2" })).toMatchObject({ ok: false, reason: "duplicate" });
      expect((await store.listStateChanges(item.id)).map((c) => c.reason)).toEqual(["intake", "implicit_verdict", "implicit_verdict", "human_verdict"]);
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
    it("returns every item with its tier, stage, token_cost, the requested reasons, its explicit verdict severities and its implicit count", async () => {
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
        severity: "major", reason: "r", comment_id: "c1", target: "pr", implicit: false, pr_head: null,
      });
      await store.transition({ id: a.id, expected_version: 4, actor: human, reason: "retry_requested", patch: {} });
      await store.recordVerdict({
        id: a.id, expected_version: 5, actor: { kind: "user", id: "github:1" as UserId }, verdict: "accept",
        severity: "none", reason: null, comment_id: "c2", target: "pr", implicit: false, pr_head: "h1",
      });
      await store.recordVerdict({
        id: a.id, expected_version: 6, actor: system, verdict: "reverted", severity: "major", reason: "reverted",
        comment_id: "implicit:reverted:a", target: "pr", implicit: true, pr_head: null,
      });
      await store.transition({
        id: b.id, expected_version: 1, actor: human, reason: "spec_rejected",
        patch: { stage: "CLOSED", close_reason: "rejected" },
      });

      expect(await store.listStatsRecords(["spec_rejected", "retry_requested"])).toEqual([
        { id: a.id, tier: 2, stage: "READY", token_cost: 40, reasons: ["retry_requested", "retry_requested"], severities: ["major", "none"], implicit: 1, origin: "factory" },
        { id: b.id, tier: null, stage: "CLOSED", token_cost: 0, reasons: ["spec_rejected"], severities: [], implicit: 0, origin: "factory" },
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

    const pauseRows = async (store: FactoryStore) => (await store.listTableRows({ table: "claim_pauses", limit: 200 }))!.rows;
    const later = (clock: { now(): Date }, ms: number) => new Date(clock.now().getTime() + ms).toISOString() as Timestamp;

    it.each(["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const)(
      "endClaimPause ends an active %s pause, and the next claim takes a queued triage run",
      async (pause) => {
        const { store, clock } = await make();
        await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
        await store.pauseClaims(later(clock, 60_000), pause);
        expect(await store.getClaimPause(pause)).not.toBeNull();
        expect(await store.endClaimPause(pause)).toEqual({ ended: true });
        expect(await store.getClaimPause(pause)).toBeNull();
        expect((await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("t");
      },
    );

    it("ending a model_stall pause also clears model_stall_since, even after the probe time passed", async () => {
      const { store, clock } = await make();
      await store.pauseClaims(later(clock, 1_000), "model_stall");
      clock.advance(5_000);
      expect(await store.getClaimPause("model_stall_since")).not.toBeNull();
      expect(await store.endClaimPause("model_stall")).toEqual({ ended: true });
      expect(await store.getClaimPause("model_stall_since")).toBeNull();
      expect(await store.getClaimPause("model_stall")).toBeNull();
    });

    it("a second endClaimPause, or one with no pause in effect, succeeds and changes no claim_pauses row", async () => {
      const { store, clock } = await make();
      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        expect(await store.endClaimPause(pause)).toEqual({ ended: false });
      }
      expect(await pauseRows(store)).toEqual([]);

      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        await store.pauseClaims(later(clock, 60_000), pause);
        await store.endClaimPause(pause);
      }
      // A pause that ran out by itself is not in effect either.
      const sorted = async () => (await pauseRows(store)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const before = await sorted();
      clock.advance(1_000);
      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        expect(await store.endClaimPause(pause)).toEqual({ ended: false });
      }
      expect(await sorted()).toEqual(before);
    });

    it("takeStallProbe moves a due model_stall probe time once: a second caller for the same due time gets false", async () => {
      const { store, clock } = await make();
      const due = later(clock, 1_000);
      await store.pauseClaims(due, "model_stall");
      clock.advance(1_000);
      const next = later(clock, 60_000);
      expect(await store.takeStallProbe(due, next)).toEqual({ taken: true });
      expect(await store.getClaimPause("model_stall")).toBe(next);
      // The same due time again, also with another next time: already taken, nothing moves.
      expect(await store.takeStallProbe(due, later(clock, 90_000))).toEqual({ taken: false });
      expect(await store.getClaimPause("model_stall")).toBe(next);
    });

    it("a stall right after a model_stall pause ended before its probe time starts a new pause", async () => {
      const { store, clock } = await make();
      await store.pauseClaims(later(clock, 60_000), "model_stall");
      expect(await store.endClaimPause("model_stall")).toEqual({ ended: true });
      expect(await store.pauseClaims(later(clock, 60_000), "model_stall")).toMatchObject({ started: true });
      expect(await store.getClaimPause("model_stall")).toBe(later(clock, 60_000));
    });

    it("takeStallProbe takes nothing once the pause ended, so it never starts the pause again", async () => {
      const { store, clock } = await make();
      expect(await store.takeStallProbe(later(clock, 0), later(clock, 60_000))).toEqual({ taken: false });
      const due = later(clock, 1_000);
      await store.pauseClaims(due, "model_stall");
      clock.advance(1_000);
      await store.endClaimPause("model_stall");
      expect(await store.takeStallProbe(due, later(clock, 60_000))).toEqual({ taken: false });
      expect(await store.getClaimPause("model_stall")).toBeNull();
    });

    it("endClaimPause refuses model_stall_since and model_answered, which are not pauses of their own", async () => {
      const { store } = await make();
      await expect(store.endClaimPause("model_stall_since")).rejects.toThrow(/not a pause/);
      await expect(store.endClaimPause("model_answered")).rejects.toThrow(/not a pause/);
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

    it("countUnreviewedMergesSince counts rows recorded inside the window and not outside it", async () => {
      const { store, clock } = await make();
      await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 1, merge_sha: "a", merger_id: null });
      clock.advance(10 * 24 * 3600_000);
      await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 2, merge_sha: "b", merger_id: null });
      await store.recordUnreviewedMerge({ project: OTHER_PROJECT_KEY, pr_number: 2, merge_sha: "c", merger_id: null });
      const since = new Date(clock.now().getTime() - 7 * 24 * 3600_000).toISOString() as Timestamp;
      expect(await store.countUnreviewedMergesSince(since)).toBe(2);
      expect(await store.countUnreviewedMergesSince(new Date(clock.now().getTime() + 1000).toISOString() as Timestamp)).toBe(0);
      expect(await store.countUnreviewedMergesSince("1970-01-01T00:00:00.000Z" as Timestamp)).toBe(3);
    });
  });

  describe("change fields beside pr_number (migration 35)", () => {
    const raw = async (store: FactoryStore, table: string, id: string) =>
      (await store.listTableRows({ table, filter: { column: "id", value: id } }))!.rows[0]!;
    const adoptedIn = (n: number, project: string) => ({
      ...issue(n),
      project,
      source: { type: "github_issue" as const, id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` },
      adopted: { pr_number: n, head_branch: "feature/x", head_sha: "h1", allowed_paths: ["src/a.ts"], tier: 4 as const },
    });

    it("the adopted insert writes change_ref, and change_url from the stored label; intake writes neither", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const labelled = (await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human)).item;
      const unlabelled = (await store.createWorkItem(adoptedIn(6, OTHER_PROJECT_KEY), human)).item;
      const plain = (await store.createWorkItem(issue(7), system)).item;
      expect(await raw(store, "work_items", labelled.id)).toMatchObject({ pr_number: 5, change_ref: "5", change_url: prUrl(LABEL, 5) });
      expect(await raw(store, "work_items", unlabelled.id)).toMatchObject({ pr_number: 6, change_ref: "6", change_url: null });
      expect(await raw(store, "work_items", plain.id)).toMatchObject({ pr_number: null, change_ref: null, change_url: null });
      expect((await store.getWorkItemByPr(PROJECT_KEY, 5))!.id).toBe(labelled.id);
      expect((await store.getWorkItemByPr(OTHER_PROJECT_KEY, 6))!.id).toBe(unlabelled.id);
    });

    it("a patch that sets pr_number writes change_ref, and change_url when the label is stored", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item;
      const b = (await store.createWorkItem({ ...issue(2), project: OTHER_PROJECT_KEY }, system)).item;
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      await store.transition({ id: a.id, expected_version: 1, patch: { pr_number: 34 }, actor: system, reason: "x" });
      await store.transition({ id: b.id, expected_version: 1, patch: { pr_number: 35 }, actor: system, reason: "x" });
      expect(await raw(store, "work_items", a.id)).toMatchObject({ change_ref: "34", change_url: prUrl(LABEL, 34) });
      expect(await raw(store, "work_items", b.id)).toMatchObject({ change_ref: "35", change_url: null });
      // A patch without pr_number leaves the change columns alone.
      await store.transition({ id: a.id, expected_version: 2, patch: { blocked_on: "human" }, actor: system, reason: "x" });
      expect(await raw(store, "work_items", a.id)).toMatchObject({ change_ref: "34", change_url: prUrl(LABEL, 34) });
      // The change columns are not part of the state change: only the patched fields are.
      const [, set] = await store.listStateChanges(a.id);
      expect(set!.changes).toEqual({ pr_number: { from: null, to: 34 } });
      expect((await store.getWorkItemByPr(PROJECT_KEY, 34))!.id).toBe(a.id);
      expect((await store.getWorkItemByPr(OTHER_PROJECT_KEY, 35))!.id).toBe(b.id);
    });

    it("every work item read returns change_ref and change_url from the row, and intake returns the stored item", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const labelled = await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human);
      const unlabelled = await store.createWorkItem(adoptedIn(6, OTHER_PROJECT_KEY), human);
      const plain = await store.createWorkItem(issue(7), system);
      const factory = (await store.createWorkItem(issue(8), system)).item;
      const patched = await store.transition({ id: factory.id, expected_version: 1, patch: { pr_number: 40 }, actor: system, reason: "x" });
      const want = new Map([
        [labelled.item.id, { change_ref: "5", change_url: prUrl(LABEL, 5) }],
        [unlabelled.item.id, { change_ref: "6", change_url: null }],
        [plain.item.id, { change_ref: null, change_url: null }],
        [factory.id, { change_ref: "40", change_url: prUrl(LABEL, 40) }],
      ]);
      // Intake (created or adopted) returns the same change fields as its stored row; so does a transition.
      for (const r of [labelled, unlabelled, plain]) {
        expect(r.created).toBe(true);
        expect(r.item).toEqual(await store.getWorkItem(r.item.id));
        expect(r.item).toMatchObject(want.get(r.item.id)!);
      }
      expect(patched.ok && patched.item).toMatchObject(want.get(factory.id)!);
      // An intake that finds the item already there returns the stored row too.
      const again = await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human);
      expect(again).toMatchObject({ created: false, item: want.get(labelled.item.id) });
      for (const [id, fields] of want) {
        expect(await store.getWorkItem(id)).toMatchObject(fields);
        const it = (await store.getWorkItem(id))!;
        expect(await store.getWorkItemBySource(it.source.type, it.source.id)).toMatchObject(fields);
      }
      expect(await store.getWorkItemByPr(PROJECT_KEY, 5)).toMatchObject(want.get(labelled.item.id)!);
      const listed = await store.listWorkItems(50);
      for (const [id, fields] of want) expect(listed.find((i) => i.id === id)).toMatchObject(fields);
    });

    it("an unreviewed merge insert writes change_ref", async () => {
      const { store } = await make();
      const { merge } = await store.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 7, merge_sha: "m7", merger_id: null });
      expect(await raw(store, "unreviewed_merges", merge.id)).toMatchObject({ pr_number: 7, change_ref: "7" });
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

  describe("one branch writer per item: overlapping paths below the coordination threshold do not hold runs back", () => {
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
      // Two ordinary shared files: cost 2.0, under the default max_coordination_cost of 2.5 (design §5, 2026-11-03).
      const a = await item(store, 1, ["lib/", "docs/notes.md"], ["implement"]);
      const b = await item(store, 2, ["lib/x.ts", "docs/notes.md"], ["update"]);
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
      // `lib/` is one ordinary shared path (cost 1.0), so only the same-item rule holds a's implement run.
      const a = await item(store, 1, ["lib/"], ["update", "implement"]);
      const b = await item(store, 2, ["lib/"], ["implement"]);
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

  describe("raw table reads (design §9 Data page)", () => {
    // Every table the schema creates on both backends (MySQL adds its own step bookkeeping tables).
    const DOMAIN_TABLES = [...new Set(MIGRATIONS.flatMap((m) => [...m.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((x) => x[1]!)))];

    it("lists every table of the schema with its row count, columns, primary key and order", async () => {
      const { store, clock } = await make();
      const a = (await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t:1" } })).item;
      clock.advance(1000);
      await store.createWorkItem(issue(2), system);
      await store.recordConflicts({ project: PROJECT_KEY, paths: ["src/a.ts", "src/b.ts"], event_key: "e1" });
      const tables = await store.listTables();
      const names = tables.map((t) => t.name);
      expect(names).toEqual([...names].sort());
      for (const t of DOMAIN_TABLES) expect(names, t).toContain(t);
      // The item thread and the command inbox (migration 24, issue #281).
      for (const t of ["item_thread", "command_inbox"]) expect(DOMAIN_TABLES, t).toContain(t);
      if (name === "sqlite") expect(names).toEqual([...DOMAIN_TABLES, "schema_migrations"].sort());
      else expect(names).toContain("schema_migrations");
      const byName = new Map(tables.map((t) => [t.name, t]));
      expect(byName.get("work_items")).toMatchObject({ rows: 2, primary_key: ["id"], order_by: ["created_at", "id"] });
      expect(byName.get("work_items")!.columns).toEqual(expect.arrayContaining(["id", "title", "created_at", "updated_at"]));
      expect(byName.get("runs")).toMatchObject({ rows: 1 });
      expect(byName.get("state_changes")).toMatchObject({ rows: 2, order_by: ["at", "id"] });
      expect(byName.get("file_conflicts")).toMatchObject({ rows: 2, primary_key: ["project_key", "path", "event_key"], order_by: ["at", "project_key", "path", "event_key"] });
      expect(byName.get("run_attempts")).toMatchObject({ rows: 0, primary_key: ["run_id", "attempt"], order_by: ["started_at", "run_id", "attempt"] });
      expect(byName.get("cursors")).toMatchObject({ primary_key: ["name"], order_by: ["name"] });
      expect(byName.get("claim_decisions")).toMatchObject({ rows: 0 });
      expect(a.id).toMatch(/^wi_/);
    });

    it("a page is newest first by the order column, honours limit and offset, and returns the total", async () => {
      const { store, clock } = await make();
      const ids: string[] = [];
      for (let n = 1; n <= 7; n++) {
        ids.push((await store.createWorkItem(issue(n), system)).item.id);
        clock.advance(1000);
      }
      const newest = [...ids].reverse();
      const p1 = (await store.listTableRows({ table: "work_items", limit: 3 }))!;
      expect(p1).toMatchObject({ total: 7, limit: 3, offset: 0 });
      expect(p1.rows.map((r) => r.id)).toEqual(newest.slice(0, 3));
      const p3 = (await store.listTableRows({ table: "work_items", limit: 3, offset: 6 }))!;
      expect(p3.rows.map((r) => r.id)).toEqual(newest.slice(6));
      expect(p3.total).toBe(7);
      // Without a time column the primary key orders, descending.
      for (const c of ["b", "c", "a"]) await store.advanceCursor(c, null, "v");
      expect((await store.listTableRows({ table: "cursors" }))!.rows.map((r) => r.name)).toEqual(["c", "b", "a"]);
      // Every column comes back, numbers as numbers.
      expect(p1.rows[0]).toMatchObject({ version: 1, title: null });
    });

    it("no limit gives 50 rows; a limit above 200 is capped at 200", async () => {
      const { store } = await make();
      // 205 one-row transactions, sent together: one after another they outlast the default timeout on MySQL
      // (each commits on its own). The MySQL pool runs them side by side; SQLite queues them.
      const created = await Promise.all(
        Array.from({ length: 205 }, (_, n) => store.advanceCursor(`c${String(n).padStart(3, "0")}`, null, "v")),
      );
      expect(created.every(Boolean)).toBe(true);
      const def = (await store.listTableRows({ table: "cursors" }))!;
      expect(def.rows).toHaveLength(50);
      expect(def).toMatchObject({ limit: 50, total: 205 });
      const big = (await store.listTableRows({ table: "cursors", limit: 1000 }))!;
      expect(big.rows).toHaveLength(200);
      expect(big.limit).toBe(200);
    }, 30_000);

    it("an exact-value filter returns only equal rows; a quote in the value is bound, not spliced", async () => {
      const { store } = await make();
      const quoted = `it's "quoted"; --`;
      const q = (await store.createWorkItem({ ...issue(1), problem: quoted }, system)).item;
      await store.createWorkItem(issue(2), system);
      await store.createWorkItem({ ...issue(3), problem: "problem 2" }, system);
      const hit = (await store.listTableRows({ table: "work_items", filter: { column: "problem", value: quoted } }))!;
      expect(hit.total).toBe(1);
      expect(hit.rows.map((r) => r.id)).toEqual([q.id]);
      const two = (await store.listTableRows({ table: "work_items", filter: { column: "problem", value: "problem 2" } }))!;
      expect(two.total).toBe(2);
      expect(two.rows.every((r) => r.problem === "problem 2")).toBe(true);
      const inject = (await store.listTableRows({ table: "work_items", filter: { column: "problem", value: "x' OR '1'='1" } }))!;
      expect(inject).toMatchObject({ total: 0, rows: [] });
      // A number column matches its text form.
      expect((await store.listTableRows({ table: "work_items", filter: { column: "version", value: "1" } }))!.total).toBe(3);
    });

    it("an unknown table or filter column is refused with null", async () => {
      const { store } = await make();
      expect(await store.listTableRows({ table: "nope" })).toBeNull();
      expect(await store.listTableRows({ table: "work_items; DROP TABLE runs" })).toBeNull();
      expect(await store.listTableRows({ table: "work_items", filter: { column: "id = id OR 1", value: "x" } })).toBeNull();
      expect((await store.listTables()).map((t) => t.name)).toContain("runs");
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

  describe("identity links", () => {
    const slack = (subject: string) => ({ provider: "slack" as const, subject });
    const userA = "github:1" as UserId;
    const userB = "github:2" as UserId;

    it("a code links once; resolve finds the account by provider and subject; links list oldest first", async () => {
      const { store } = await make();
      await store.createLinkCode(userA, "CODEAAAAA1");
      await store.createLinkCode(userA, "CODEAAAAA2");
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U1"))).toEqual({ ok: true, user_id: userA });
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U1"))).toEqual({ ok: true, user_id: userA });
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U2"))).toEqual({ ok: false, reason: "used" });
      expect(await store.redeemLinkCode("CODEAAAAA2", slack("U2"))).toEqual({ ok: true, user_id: userA });
      expect(await store.resolveLink("slack", "U1")).toBe(userA);
      expect(await store.resolveLink("github", "U1")).toBeNull();
      expect(await store.listLinks(userA)).toEqual([slack("U1"), slack("U2")]);
    });

    it("a wrong code links nothing; an account linked to another user is refused and the code stays usable", async () => {
      const { store } = await make();
      await store.createLinkCode(userB, "CODEBBBBB1");
      expect(await store.redeemLinkCode("WRONGCODE1", slack("U1"))).toEqual({ ok: false, reason: "invalid" });
      expect(await store.redeemLinkCode("CODEBBBBB1", slack("U1"))).toEqual({ ok: true, user_id: userB });
      await store.createLinkCode(userA, "CODEAAAAA3");
      expect(await store.redeemLinkCode("CODEAAAAA3", slack("U1"))).toEqual({ ok: false, reason: "already_linked" });
      expect(await store.redeemLinkCode("CODEAAAAA3", slack("U3"))).toEqual({ ok: true, user_id: userA });
      expect(await store.resolveLink("slack", "U1")).toBe(userB);
    });
  });
  describe("settings overrides (migration 15)", () => {
    const actor = "local:owner";

    it("set stores the JSON value and one audit row; a second set replaces it and records the old value", async () => {
      const { store, clock } = await make();
      expect(await store.listSettingOverrides()).toEqual([]);
      const first = await store.setSettingOverride({ key: "workers", project: "", value: "2", actor });
      expect(first).toMatchObject({ key: "workers", project: "", old_value: null, new_value: "2", actor, at: clock.now().toISOString() });
      clock.advance(1000);
      const second = await store.setSettingOverride({ key: "workers", project: "", value: "3", actor: "local:other" });
      expect(second).toMatchObject({ old_value: "2", new_value: "3", actor: "local:other" });
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(await store.listSettingOverrides()).toEqual([
        { key: "workers", project: "", value: "3", set_by: "local:other", set_at: clock.now().toISOString() },
      ]);
      expect((await store.listSettingChanges(10)).map((c) => c.new_value)).toEqual(["3", "2"]);
    });

    it("a project override is its own row; overrides list by key, then project", async () => {
      const { store } = await make();
      await store.setSettingOverride({ key: "max_attempts", project: PROJECT_KEY, value: "2", actor });
      await store.setSettingOverride({ key: "max_attempts", project: "", value: "3", actor });
      await store.setSettingOverride({ key: "lease_ms", project: "", value: "90000", actor });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.project, o.value])).toEqual([
        ["lease_ms", "", "90000"],
        ["max_attempts", "", "3"],
        ["max_attempts", PROJECT_KEY, "2"],
      ]);
    });

    it("reset deletes the override with one audit row; reset with no override writes nothing", async () => {
      const { store } = await make();
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toBeNull();
      expect(await store.listSettingChanges(10)).toEqual([]);
      await store.setSettingOverride({ key: "workers", project: "", value: "2", actor });
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toMatchObject({ old_value: "2", new_value: null });
      expect(await store.listSettingOverrides()).toEqual([]);
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toBeNull();
      expect((await store.listSettingChanges(10)).map((c) => [c.old_value, c.new_value])).toEqual([["2", null], [null, "2"]]);
    });

    it("history is newest first and honours the limit", async () => {
      const { store } = await make();
      for (const v of ["1", "2", "3"]) await store.setSettingOverride({ key: "workers", project: "", value: v, actor });
      expect((await store.listSettingChanges(2)).map((c) => c.new_value)).toEqual(["3", "2"]);
    });
  });

  describe("worker processes (migration 19)", () => {
    const report = (over: Partial<WorkerProcessReport> = {}): WorkerProcessReport => ({
      process_id: "host-a:42", pid: 42, host: "host-a", slots: 2, max_slots: 4, busy: 1, index_base: 0,
      started_at: "2026-01-01T00:00:00.000Z" as Timestamp, ...over,
    });

    it("a report is stored with reported_at = now; a repeat write for the same process replaces the row", async () => {
      const { store, clock } = await make();
      expect(await store.listWorkerProcesses(LEASE)).toEqual([]);
      const first = await store.reportWorkerProcess(report());
      expect(first).toEqual({ ...report(), reported_at: clock.now().toISOString() });
      clock.advance(1000);
      await store.reportWorkerProcess(report({ slots: 3, busy: 3 }));
      expect(await store.listWorkerProcesses(LEASE)).toEqual([{ ...report({ slots: 3, busy: 3 }), reported_at: clock.now().toISOString() }]);
    });

    it("lists one row per process, by host then pid; a row older than max_age_ms is not listed", async () => {
      const { store, clock } = await make();
      await store.reportWorkerProcess(report({ process_id: "host-b:7", host: "host-b", pid: 7 }));
      clock.advance(LEASE / 2);
      await store.reportWorkerProcess(report({ process_id: "host-a:9", pid: 9 }));
      await store.reportWorkerProcess(report());
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9", "host-a:42", "host-b:7"]);
      clock.advance(LEASE / 2);
      // host-b:7 is exactly LEASE old: still live.
      expect(await store.listWorkerProcesses(LEASE)).toHaveLength(3);
      clock.advance(1);
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9", "host-a:42"]);
    });

    it("remove deletes only that process's row; removing again reports false", async () => {
      const { store } = await make();
      await store.reportWorkerProcess(report());
      await store.reportWorkerProcess(report({ process_id: "host-a:9", pid: 9 }));
      expect(await store.removeWorkerProcess("host-a:42")).toBe(true);
      expect(await store.removeWorkerProcess("host-a:42")).toBe(false);
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9"]);
    });

    it("concurrent first writes for one process leave one row", async () => {
      const { store } = await make();
      await Promise.all([store.reportWorkerProcess(report({ busy: 0 })), store.reportWorkerProcess(report({ busy: 2 }))]);
      const rows = await store.listWorkerProcesses(LEASE);
      expect(rows).toHaveLength(1);
      expect([0, 2]).toContain(rows[0]!.busy);
    });
  });
  describe("alerts (migration 36)", () => {
    const HOUR = 3_600_000;
    const alert = (over: Partial<NewAlert> = {}): NewAlert => ({
      pattern: "repeated_error", pattern_key: "repeated_error:abc", error_code: "checks_failed", count: 3, detail: "boom", ...over,
    });

    it("stores an alert with its fields; the same pattern inside the dedupe window stores none", async () => {
      const { store, clock } = await make();
      expect(await store.listAlerts({ limit: 10 })).toEqual([]);
      const first = await store.recordAlert(alert(), 6 * HOUR);
      expect(first).toMatchObject({ created: true, alert: { ...alert(), created_at: clock.now().toISOString() } });
      clock.advance(6 * HOUR - 1);
      expect(await store.recordAlert(alert({ count: 4 }), 6 * HOUR)).toEqual({ created: false });
      // Another pattern is its own; a null detail round-trips.
      const other = await store.recordAlert(alert({ pattern: "zero_tokens", pattern_key: "zero_tokens", detail: null }), 6 * HOUR);
      expect(other).toMatchObject({ created: true, alert: { pattern: "zero_tokens", detail: null } });
      expect((await store.listAlerts({ limit: 10 })).map((a) => a.pattern_key)).toEqual(["zero_tokens", "repeated_error:abc"]);
    });

    it("the same pattern stores again once the window has passed; newest first, limit honoured", async () => {
      const { store, clock } = await make();
      await store.recordAlert(alert(), 6 * HOUR);
      clock.advance(6 * HOUR);
      const again = await store.recordAlert(alert({ count: 7 }), 6 * HOUR);
      expect(again).toMatchObject({ created: true, alert: { count: 7 } });
      expect((await store.listAlerts({ limit: 10 })).map((a) => a.count)).toEqual([7, 3]);
      expect((await store.listAlerts({ limit: 1 })).map((a) => a.count)).toEqual([7]);
    });

    it("concurrent records of one pattern leave one alert", async () => {
      const { store } = await make();
      const results = await Promise.all([store.recordAlert(alert(), 6 * HOUR), store.recordAlert(alert(), 6 * HOUR)]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
    });
  });
  describe("host sleeps (migration 28)", () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString() as Timestamp;
    const sleep = (over: Partial<HostSleep> = {}): HostSleep => ({ worker_id: w1, woke_at: at(0), gap_ms: 120_000, run_id: null, ...over });

    it("stores a sleep with its ids, time and gap; recording it again keeps one row", async () => {
      const { store } = await make();
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([]);
      expect(await store.recordHostSleep(sleep())).toEqual({ created: true, sleep: sleep() });
      // Same worker and wake time: the stored row, not a second one, even with another gap.
      expect(await store.recordHostSleep(sleep({ gap_ms: 1 }))).toEqual({ created: false, sleep: sleep() });
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([sleep()]);
    });

    it("lists newest first, honours the limit, and keeps one row per worker for the same wake time", async () => {
      const { store } = await make();
      await store.recordHostSleep(sleep({ woke_at: at(1000) }));
      await store.recordHostSleep(sleep({ woke_at: at(3000) }));
      await store.recordHostSleep(sleep({ woke_at: at(2000) }));
      await store.recordHostSleep(sleep({ worker_id: w2, woke_at: at(3000) }));
      expect((await store.listHostSleeps({ limit: 10 })).map((h) => [h.worker_id, h.woke_at])).toEqual([
        [w2, at(3000)], [w1, at(3000)], [w1, at(2000)], [w1, at(1000)],
      ]);
      expect((await store.listHostSleeps({ limit: 2 })).map((h) => h.woke_at)).toEqual([at(3000), at(3000)]);
    });

    it("concurrent writes of one sleep leave one row", async () => {
      const { store } = await make();
      const results = await Promise.all([store.recordHostSleep(sleep()), store.recordHostSleep(sleep())]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([sleep()]);
    });

    it("by work item: only sleeps recorded during that item's runs", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } })).item;
      const b = (await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } })).item;
      const [ra] = await store.listRuns(a.id);
      const [rb] = await store.listRuns(b.id);
      await store.recordHostSleep(sleep({ woke_at: at(1000), run_id: ra!.id }));
      await store.recordHostSleep(sleep({ woke_at: at(2000), run_id: rb!.id }));
      await store.recordHostSleep(sleep({ woke_at: at(3000) }));
      await store.recordHostSleep(sleep({ woke_at: at(4000), run_id: ra!.id }));
      expect((await store.listHostSleeps({ limit: 10, work_item_id: a.id })).map((h) => [h.woke_at, h.run_id])).toEqual([
        [at(4000), ra!.id], [at(1000), ra!.id],
      ]);
      expect(await store.listHostSleeps({ limit: 10, work_item_id: "wi_none" as WorkItemId })).toEqual([]);
    });
  });
  // App command requests (issue #245, migration 23 on both backends).
  describe("dependency edges keep the issue updated_at they were read at (migrations 32 and 33)", () => {
    const T1 = "2026-11-07T10:00:00.000Z" as Timestamp;
    const T2 = "2026-11-07T11:00:00.000Z" as Timestamp;

    it("replaceDependencyEdges with read_at records it on every edge and on the item; without it both stay", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item.id;
      expect(await store.dependencyLinksReadAt(a)).toBeNull();
      const plain = await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }]);
      expect(plain.map((e) => e.source_updated_at)).toEqual([null]);

      const read = await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }, { depends_on: "o/r#3", kind: "sub_issue" }], T1);
      expect(read.map((e) => [e.depends_on, e.source_updated_at])).toEqual([["o/r#2", T1], ["o/r#3", T1]]);
      expect(await store.dependencyLinksReadAt(a)).toBe(T1);
      expect((await store.listDependencyEdges({ work_item_id: a })).map((e) => e.source_updated_at)).toEqual([T1, T1]);

      // No links: the item still records when they were read.
      await store.replaceDependencyEdges(a, [], T2);
      expect(await store.listDependencyEdges({ work_item_id: a })).toEqual([]);
      expect(await store.dependencyLinksReadAt(a)).toBe(T2);
      await store.replaceDependencyEdges(a, []);
      expect(await store.dependencyLinksReadAt(a)).toBe(T2);
    });

    it("markDependencyLinksStale clears the item's read time, twice as once", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item.id;
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }], T1);
      await store.markDependencyLinksStale(a);
      await store.markDependencyLinksStale(a);
      expect(await store.dependencyLinksReadAt(a)).toBeNull();
      // The edges keep the time they were read at.
      expect((await store.listDependencyEdges({ work_item_id: a })).map((e) => e.source_updated_at)).toEqual([T1]);
    });
  });

  describe("app command requests (migration 23)", () => {
    const owner = "github:1" as UserId;
    const req = (key: string, over: { command?: string; args?: Record<string, unknown> } = {}) => ({
      key, actor: owner, command: over.command ?? "approve", args: over.args ?? { work_item_id: "wi_1" },
    });

    it("record stores a pending request; the same key again stores nothing and reports the first", async () => {
      const { store, clock } = await make();
      const first = await store.recordAppCommandRequest(req("k1", { args: { work_item_id: "wi_1", note: "small" } }));
      expect(first).toEqual({
        created: true,
        request: {
          seq: first.request.seq, key: "k1", actor: owner, command: "approve", args: { work_item_id: "wi_1", note: "small" },
          created_at: clock.now().toISOString(), handled_at: null, refusal: null,
        },
      });
      const again = await store.recordAppCommandRequest(req("k1", { command: "reject" }));
      expect(again).toEqual({ created: false, request: first.request });
      expect(await store.getAppCommandRequest(first.request.seq)).toEqual(first.request);
      expect(await store.getAppCommandRequest(first.request.seq + 1000)).toBeNull();
    });

    it("each request's seq is greater than the ones recorded before it", async () => {
      const { store } = await make();
      const seqs: number[] = [];
      for (const k of ["a", "b", "c", "d"]) seqs.push((await store.recordAppCommandRequest(req(k))).request.seq);
      expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
    });

    it("a conditional mark sets handled_at and the refusal once; a second mark changes nothing", async () => {
      const { store, clock } = await make();
      const { request } = await store.recordAppCommandRequest(req("k1"));
      clock.advance(1000);
      const markedAt = clock.now().toISOString();
      expect(await store.markAppCommandRequest(request.seq, "`approve` was not applied: no.")).toBe(true);
      clock.advance(1000);
      expect(await store.markAppCommandRequest(request.seq, null)).toBe(false);
      expect(await store.markAppCommandRequest(request.seq, "other")).toBe(false);
      expect(await store.getAppCommandRequest(request.seq)).toEqual({
        ...request, handled_at: markedAt, refusal: "`approve` was not applied: no.",
      });
      // An applied request keeps a null refusal; an unknown seq marks nothing.
      const applied = (await store.recordAppCommandRequest(req("k2"))).request;
      expect(await store.markAppCommandRequest(applied.seq, null)).toBe(true);
      expect(await store.getAppCommandRequest(applied.seq)).toMatchObject({ handled_at: clock.now().toISOString(), refusal: null });
      expect(await store.markAppCommandRequest(applied.seq + 1000, null)).toBe(false);
    });

    it("two concurrent marks of one request: exactly one wins", async () => {
      const { store } = await make();
      const { request } = await store.recordAppCommandRequest(req("k1"));
      const r = await Promise.all([store.markAppCommandRequest(request.seq, "a"), store.markAppCommandRequest(request.seq, "b")]);
      expect(r.filter(Boolean)).toHaveLength(1);
      const stored = (await store.getAppCommandRequest(request.seq))!;
      expect(stored.refusal).toBe(r[0] ? "a" : "b");
    });

    it("the per-item read lists one item's requests, handled or not, oldest first, the newest `limit`", async () => {
      const { store } = await make();
      const a = (await store.recordAppCommandRequest(req("a", { args: { work_item_id: "wi_1", note: "n" } }))).request;
      await store.recordAppCommandRequest(req("other", { args: { work_item_id: "wi_10" } }));
      // `_` and `%` in an id are matched literally, not as LIKE wildcards.
      await store.recordAppCommandRequest(req("wild", { args: { work_item_id: "wiX1" } }));
      await store.recordAppCommandRequest(req("pct", { args: { work_item_id: "%" } }));
      const b = (await store.recordAppCommandRequest(req("b", { command: "reject", args: { note: "x", work_item_id: "wi_1" } }))).request;
      await store.markAppCommandRequest(a.seq, "no");
      const c = (await store.recordAppCommandRequest(req("c"))).request;
      const got = await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 10);
      expect(got.map((r) => r.key)).toEqual(["a", "b", "c"]);
      expect(got[0]).toMatchObject({ seq: a.seq, refusal: "no" });
      expect(got[0]!.handled_at).not.toBeNull();
      expect((await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 2)).map((r) => r.seq)).toEqual([b.seq, c.seq]);
      expect(await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 0)).toEqual([]);
      expect(await store.listAppCommandRequestsForItem("wi_nope" as WorkItemId, 10)).toEqual([]);
      expect((await store.listAppCommandRequestsForItem("%" as WorkItemId, 10)).map((r) => r.key)).toEqual(["pct"]);
    });
  });

  // Interactive sessions (design §5, 2026-11-01): the actor, transcript and token fields are run columns (migration
  // 18 on both backends); notes and the last finish live in the run's input.
  describe("interactive sessions", () => {
    const person = { kind: "user" as const, id: "github:5" as UserId };
    const seed = async (store: FactoryStore, n: number, paths: string[]) => {
      const { item } = await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { allowed_paths: paths } });
      if (!r.ok) throw new Error(r.reason);
      return r.item;
    };
    const start = (store: FactoryStore, it: { id: WorkItemId; version: number }) => store.startSession({
      id: it.id, expected_version: it.version, actor: person, patch: { stage: "RUNNING" }, reason: "session_started", detail: { spec_source: "owner" },
      owner: "session:h:1", lease_ms: LEASE, transcript_url: "https://example.com/t",
    });

    it("startSession writes one running interactive run and the transition and cancels queued triage; other runs read the fields as null", async () => {
      const { store } = await make();
      const it0 = await seed(store, 1, ["src/a/"]);
      expect((await store.listRuns(it0.id))[0]).toMatchObject({ actor_id: null, transcript_url: null, session_tokens: null, session_notes: [], last_finish: null });
      const r = await start(store, it0);
      if (!r.ok) throw new Error(r.reason);
      expect(r.run).toMatchObject({ kind: "interactive", status: "running", attempt: 1, actor_id: "github:5", transcript_url: "https://example.com/t", lease: { owner: "session:h:1", token: 1 } });
      expect(r.state_change).toMatchObject({ reason: "session_started", actor: person, detail: { spec_source: "owner", run_id: r.run.id } });
      expect([r.item.stage, r.cancelled.length]).toEqual(["RUNNING", 1]);
      expect((await store.listRuns(it0.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "cancelled"], ["interactive", "running"]]);
      expect((await store.listRunsByKind("interactive", ["running"])).map((x) => x.id)).toEqual([r.run.id]);
      // Refused with nothing written: stale version, open session, implement-type run, overlap with another item's session.
      expect(await start(store, { id: it0.id, version: it0.version })).toMatchObject({ ok: false, reason: "version_conflict" });
      expect(await start(store, r.item)).toMatchObject({ ok: false, reason: "session_open", run_id: r.run.id });
      const it1 = await seed(store, 2, ["src/b/"]);
      const q = await store.transition({ id: it1.id, expected_version: it1.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i2" } });
      if (!q.ok) throw new Error(q.reason);
      expect(await start(store, q.item)).toMatchObject({ ok: false, reason: "implement_run", run_id: q.enqueued!.id });
      const it2 = await seed(store, 3, ["src/a/x.ts"]);
      const before = JSON.stringify([await store.listRuns(it2.id), await store.listStateChanges(it2.id)]);
      expect(await start(store, it2)).toMatchObject({ ok: false, reason: "overlap", work_item_id: it0.id, paths: ["src/a/x.ts"] });
      expect(JSON.stringify([await store.listRuns(it2.id), await store.listStateChanges(it2.id)])).toBe(before);
    });

    it("updateSession writes notes, tokens, transcript and the last finish only while the lease is held", async () => {
      const { store } = await make();
      const r = await start(store, await seed(store, 1, ["src/a/"]));
      if (!r.ok) throw new Error(r.reason);
      await store.updateSession(r.run.id, 1, { note: "first" });
      const u = await store.updateSession(r.run.id, 1, { note: "second", tokens: 120, transcript_url: "https://example.com/u", last_finish: { ok: false, reasons: ["tests"], pr_number: null } });
      if (!u.ok) throw new Error(u.reason);
      expect(u.run).toMatchObject({ session_tokens: 120, transcript_url: "https://example.com/u", last_finish: { ok: false, reasons: ["tests"], pr_number: null } });
      expect(u.run.session_notes.map((n) => n.text)).toEqual(["first", "second"]);
      expect(await store.updateSession(r.run.id, 2, { tokens: 1 })).toEqual({ ok: false, reason: "lease_lost" });
      await store.completeRun(r.run.id, 1, { status: "failed", error_code: "abandoned", detail: "", infra: false });
      expect(await store.updateSession(r.run.id, 1, { tokens: 1 })).toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getRun(r.run.id))!.session_tokens).toBe(120);
    });

    it("claims never take a session or an implement run overlapping it; the reaper fails an expired session with session_lost", async () => {
      const { store, clock } = await make();
      const s = await start(store, await seed(store, 1, ["src/a/"]));
      if (!s.ok) throw new Error(s.reason);
      const it1 = await seed(store, 2, ["src/a/y.ts"]);
      await store.transition({ id: it1.id, expected_version: it1.version, actor: system, reason: "x", patch: { stage: "RUNNING" }, enqueue: { kind: "implement", idempotency_key: "i2" } });
      expect(await store.claimRun({ worker_id: w1, kinds: ["interactive", "implement", "update"], lease_ms: LEASE })).toBeNull();
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(5)).toEqual([s.run.id]);
      expect(await store.getRun(s.run.id)).toMatchObject({ status: "failed", lease: null, outcome: { status: "failed", error_code: "session_lost" } });
      // The session start opened the run's one attempt record; the reaper closed it with the run's code.
      expect((await store.listRunAttempts(s.item.id)).map((a) => [a.attempt, a.status, a.error_code, a.failure_class])).toEqual([
        [1, "failed", "session_lost", "task"],
      ]);
      expect((await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))?.work_item_id).toBe(it1.id);
    });
  });
});

describe("migration 19 on an existing SQLite database", () => {
  it("adds worker_processes and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig19-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 18; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)").run(
      "workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z",
    );
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const clock = new FakeClock();
    const store = new SqlFactoryStore(new SqliteDriver(path), clock);
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
      expect(await store.getCursor("poll")).toBe("c1");
      await store.reportWorkerProcess({
        process_id: "h:1", pid: 1, host: "h", slots: 1, max_slots: 1, busy: 0, index_base: 0, started_at: clock.now().toISOString() as Timestamp,
      });
      expect(await store.listWorkerProcesses(LEASE)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("MySQL step 19 (worker-processes)", () => {
  const file = "0019-worker-processes.sql";
  const sql = () => readFileSync(join(STEPS_DIR, file), "utf8");

  it("is the repo's step after 18, a .sql file", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((st) => st.name === "worker-processes")).toMatchObject({ number: 19, from: 18, kind: "sql", file });
  });

  it("creates the same columns as SQLite migration 19, idempotently (IF NOT EXISTS)", () => {
    const columns = (text: string) =>
      [...text.matchAll(/^\s+([a-z_]+)\s+(?:TEXT|INTEGER|VARCHAR|INT|CHAR)/gm)].map((m) => m[1]).sort();
    const sqlite = MIGRATIONS[18]!;
    expect(sqlite).toContain("CREATE TABLE worker_processes");
    expect(columns(sql())).toEqual(columns(sqlite));
    expect(columns(sqlite)).toEqual(["busy", "host", "index_base", "max_slots", "pid", "process_id", "reported_at", "slots", "started_at"]);
    expect(sql()).toContain("CREATE TABLE IF NOT EXISTS worker_processes");
  });

  it.skipIf(!MYSQL_URL)("npm run migrate upgrades an existing state-18 database: worker_processes added, every earlier row kept", async () => {
    const db = await newEmptyMysqlDatabase();
    const conn = await db.connect();
    // Every step before 19 applied, as on a database from before it.
    await new MysqlMigrations(conn, { dir: mysqlStepsUpTo(18) }).apply(() => undefined);
    await conn.query(
      "INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
      ["workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z"],
    );
    await conn.query("INSERT INTO cursors (name, value) VALUES (?, ?)", ["poll", "c1"]);
    const s = await new MysqlMigrations(conn).apply(() => undefined);
    expect(s.pending[0]?.number).toBe(19);
    const clock = new FakeClock();
    const store = new SqlFactoryStore(new MysqlDriver(db.options), clock);
    db.onCleanup(() => store.close());
    await store.migrate();
    expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
    expect(await store.getCursor("poll")).toBe("c1");
    await store.reportWorkerProcess({
      process_id: "h:1", pid: 1, host: "h", slots: 1, max_slots: 1, busy: 0, index_base: 0, started_at: clock.now().toISOString() as Timestamp,
    });
    expect(await store.listWorkerProcesses(LEASE)).toHaveLength(1);
  });
});

describe("MySQL steps 33 and 34 (edge and item source_updated_at)", () => {
  const steps = () => readSteps(STEPS_DIR, INLINE_STEPS);
  const sql = (file: string) => readFileSync(join(STEPS_DIR, file), "utf8");

  it("are the repo's steps after 32, in order, .sql files", () => {
    expect(steps().find((st) => st.name === "edge-source-updated-at")).toMatchObject({ number: 33, from: 32, kind: "sql" });
    expect(steps().find((st) => st.name === "item-edges-source-updated-at")).toMatchObject({ number: 34, from: 33, kind: "sql" });
  });

  it("add the same columns as SQLite migrations 33 and 34, each in one ALTER (safe to rerun after a failure)", () => {
    const added = (text: string) => [...text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(added(MIGRATIONS[32]!)).toEqual(["dependency_edges.source_updated_at"]);
    expect(added(MIGRATIONS[33]!)).toEqual(["work_items.edges_source_updated_at"]);
    expect(added(sql("0033-edge-source-updated-at.sql"))).toEqual(added(MIGRATIONS[32]!));
    expect(added(sql("0034-item-edges-source-updated-at.sql"))).toEqual(added(MIGRATIONS[33]!));
    for (const f of ["0033-edge-source-updated-at.sql", "0034-item-edges-source-updated-at.sql"]) {
      const statements = sql(f).split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      expect(statements, f).toHaveLength(1);
    }
  });

  it.skipIf(!MYSQL_URL)("npm run migrate upgrades a state-32 database: edges keep their rows and get a NULL read time", async () => {
    const db = await newEmptyMysqlDatabase();
    const conn = await db.connect();
    await new MysqlMigrations(conn, { dir: mysqlStepsUpTo(32) }).apply(() => undefined);
    const clock = new FakeClock();
    const s = await new MysqlMigrations(conn).apply(() => undefined);
    expect(s.pending.map((p) => p.number)).toEqual(expect.arrayContaining([33, 34]));
    const store = new SqlFactoryStore(new MysqlDriver(db.options), clock);
    db.onCleanup(() => store.close());
    await store.migrate();
    const a = (await store.createWorkItem(issue(1), system)).item.id;
    await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }]);
    expect(await store.dependencyLinksReadAt(a)).toBeNull();
    const at = "2026-11-07T10:00:00.000Z" as Timestamp;
    expect((await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }], at))[0]?.source_updated_at).toBe(at);
    expect(await store.dependencyLinksReadAt(a)).toBe(at);
  });
});

describe("migration 28 on an existing SQLite database", () => {
  it("adds host_sleeps and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig28-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 27; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)").run(
      "workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z",
    );
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const clock = new FakeClock();
    const store = new SqlFactoryStore(new SqliteDriver(path), clock);
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
      expect(await store.getCursor("poll")).toBe("c1");
      const s = { worker_id: w1, woke_at: clock.now().toISOString() as Timestamp, gap_ms: 90_000, run_id: null };
      await store.recordHostSleep(s);
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([s]);
    } finally {
      await store.close();
    }
  });
});

describe("MySQL step 28 (host-sleeps)", () => {
  const file = "0028-host-sleeps.sql";
  const sql = () => readFileSync(join(STEPS_DIR, file), "utf8");

  it("is the repo's step after 27, a .sql file", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((st) => st.name === "host-sleeps")).toMatchObject({ number: 28, from: 27, kind: "sql", file });
  });

  it("creates the same columns as SQLite migration 28, idempotently (IF NOT EXISTS)", () => {
    const columns = (text: string) =>
      [...text.matchAll(/^\s+([a-z_]+)\s+(?:TEXT|INTEGER|VARCHAR|INT|BIGINT|CHAR)/gm)].map((m) => m[1]).sort();
    const sqlite = MIGRATIONS[27]!;
    expect(sqlite).toContain("CREATE TABLE IF NOT EXISTS host_sleeps");
    expect(columns(sql())).toEqual(columns(sqlite));
    expect(columns(sqlite)).toEqual(["gap_ms", "run_id", "woke_at", "worker_id"]);
    expect(sql()).toContain("CREATE TABLE IF NOT EXISTS host_sleeps");
  });

  it.skipIf(!MYSQL_URL)("npm run migrate upgrades an existing state-27 database: host_sleeps added, every earlier row kept", async () => {
    const db = await newEmptyMysqlDatabase();
    const conn = await db.connect();
    await new MysqlMigrations(conn, { dir: mysqlStepsUpTo(27) }).apply(() => undefined);
    await conn.query(
      "INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
      ["workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z"],
    );
    await conn.query("INSERT INTO cursors (name, value) VALUES (?, ?)", ["poll", "c1"]);
    await new MysqlMigrations(conn).apply(() => undefined);
    const clock = new FakeClock();
    const store = new SqlFactoryStore(new MysqlDriver(db.options), clock);
    db.onCleanup(() => store.close());
    await store.migrate();
    expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
    expect(await store.getCursor("poll")).toBe("c1");
    const s = { worker_id: w1, woke_at: clock.now().toISOString() as Timestamp, gap_ms: 90_000, run_id: null };
    await store.recordHostSleep(s);
    expect(await store.listHostSleeps({ limit: 10 })).toEqual([s]);
  });
});

describe("migration 32 on an existing SQLite database", () => {
  it("adds standing_rules and standing_proposals and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig32-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 31; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const store = new SqlFactoryStore(new SqliteDriver(path), new FakeClock());
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect(await store.getCursor("poll")).toBe("c1");
      const { created } = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
      expect(created).toBe(true);
      expect((await store.putStandingRule({ gate: "spec", tier: 2, enabled: false, set_by: "github:1" as UserId })).enabled).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe("MySQL step 32 (standing-approvals)", () => {
  it.skipIf(!MYSQL_URL)("npm run migrate upgrades an existing state-31 database: both tables added, every earlier row kept", async () => {
    const db = await newEmptyMysqlDatabase();
    const conn = await db.connect();
    await new MysqlMigrations(conn, { dir: mysqlStepsUpTo(31) }).apply(() => undefined);
    await conn.query("INSERT INTO cursors (name, value) VALUES (?, ?)", ["poll", "c1"]);
    await new MysqlMigrations(conn).apply(() => undefined);
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    expect(await store.getCursor("poll")).toBe("c1");
    const first = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
    const again = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
    expect([first.created, again.created]).toEqual([true, false]);
    await store.putStandingRule({ gate: "spec", tier: 2, enabled: true, set_by: "github:1" as UserId });
    expect((await store.listStandingRules()).map((r) => [r.gate, r.tier, r.enabled])).toEqual([["spec", 2, true]]);
  });
});

describe("migration 35 (change fields) on an existing SQLite database", () => {
  const adoptedIn = (n: number, project: string) => ({
    ...issue(n),
    project,
    adopted: { pr_number: n, head_branch: "b", head_sha: "h", allowed_paths: ["a.ts"], tier: 4 as const },
  });

  it("prUrl in src/main.ts builds the same string as the backfill and the store writes", () => {
    expect(readFileSync(join(process.cwd(), "src", "main.ts"), "utf8")).toContain("prUrl: (label, n) => `https://${label}/pull/${n}`");
    expect(CHANGE_MIGRATION).toBeGreaterThan(0);
  });

  it("an item without a PR inserts as before: the change columns are listed only with a PR number", async () => {
    // A schema from before the migration, as tests of older steps build (tests/session-migration.test.ts on MySQL).
    const path = join(mkdtempSync(join(tmpdir(), "sf-mig-change-")), "factory.db");
    const raw = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, CHANGE_MIGRATION - 1)) raw.exec(m);
    raw.close();
    const store = new SqlFactoryStore(new SqliteDriver(path), new FakeClock());
    try {
      const { item } = await store.createWorkItem(issue(1), system);
      expect((await store.getWorkItem(item.id))!).toMatchObject({ id: item.id, pr_number: null });
    } finally {
      await store.close();
    }
  });

  it("backfills change_ref and change_url from pr_number and the label, adds the indexes; pr_number-only rows still resolve", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sf-mig-change-")), "factory.db");
    const clock = new FakeClock();
    const seed = new SqlFactoryStore(new SqliteDriver(path), clock);
    await seed.migrate();
    await seed.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
    const labelled = (await seed.createWorkItem(adoptedIn(5, PROJECT_KEY), human)).item;
    const unlabelled = (await seed.createWorkItem(adoptedIn(6, OTHER_PROJECT_KEY), human)).item;
    const patched = (await seed.createWorkItem(issue(7), system)).item;
    await seed.transition({ id: patched.id, expected_version: 1, patch: { pr_number: 9 }, actor: system, reason: "x" });
    const plain = (await seed.createWorkItem(issue(8), system)).item;
    const { merge } = await seed.recordUnreviewedMerge({ project: PROJECT_KEY, pr_number: 11, merge_sha: "m", merger_id: null });
    await seed.close();
    // Back to the state before the migration: no change columns or indexes, every row as it was.
    const db = new DatabaseSync(path);
    db.exec(`
      DROP INDEX work_items_change; DROP INDEX unreviewed_merges_change;
      ALTER TABLE work_items DROP COLUMN change_ref; ALTER TABLE work_items DROP COLUMN change_url;
      ALTER TABLE unreviewed_merges DROP COLUMN change_ref;
      DELETE FROM schema_migrations WHERE version >= ${CHANGE_MIGRATION};
    `);
    db.close();

    const store = new SqlFactoryStore(new SqliteDriver(path), clock);
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      const row = async (table: string, id: string) => (await store.listTableRows({ table, filter: { column: "id", value: id } }))!.rows[0]!;
      expect(await row("work_items", labelled.id)).toMatchObject({ change_ref: "5", change_url: prUrl(LABEL, 5) });
      expect(await row("work_items", unlabelled.id)).toMatchObject({ change_ref: "6", change_url: null });
      expect(await row("work_items", patched.id)).toMatchObject({ change_ref: "9", change_url: prUrl(LABEL, 9) });
      expect(await row("work_items", plain.id)).toMatchObject({ change_ref: null, change_url: null });
      expect(await row("unreviewed_merges", merge.id)).toMatchObject({ change_ref: "11" });
    } finally {
      await store.close();
    }

    const check = new DatabaseSync(path);
    const index = (name: string) => check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string } | undefined;
    expect(index("work_items_change")?.sql).toMatch(/ON work_items \(project, change_ref\)/);
    expect(index("unreviewed_merges_change")?.sql).toMatch(/UNIQUE INDEX .* ON unreviewed_merges \(project, change_ref\)/);
    // A row an older controller wrote: pr_number only, change_ref NULL. The lookup falls back to pr_number.
    check.prepare("UPDATE work_items SET pr_number = 12 WHERE id = ?").run(plain.id);
    check.close();
    const reopened = new SqlFactoryStore(new SqliteDriver(path), clock);
    try {
      expect((await reopened.getWorkItemByPr(PROJECT_KEY, 12))!).toMatchObject({ id: plain.id, pr_number: 12 });
      expect((await reopened.getWorkItemByPr(PROJECT_KEY, 5))!.id).toBe(labelled.id);
      expect(await reopened.getWorkItemByPr(OTHER_PROJECT_KEY, 12)).toBeNull();
    } finally {
      await reopened.close();
    }
  });
});

describe("MySQL step 35 (change-fields)", () => {
  it("is a .ts data step right after the SQLite migration's starting state", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((st) => st.name === "change-fields")).toMatchObject({
      number: CHANGE_MIGRATION, from: CHANGE_MIGRATION - 1, kind: "ts",
    });
  });

  it.skipIf(!MYSQL_URL)("a row written with pr_number only still resolves by PR", async () => {
    const db = await newEmptyMysqlDatabase();
    const conn = await db.connect();
    await new MysqlMigrations(conn).apply(() => undefined);
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    const { item } = await store.createWorkItem(issue(1), system);
    await conn.query("UPDATE work_items SET pr_number = 12 WHERE id = ?", [item.id]);
    expect((await store.getWorkItemByPr(PROJECT_KEY, 12))!).toMatchObject({ id: item.id, pr_number: 12 });
    expect(await store.getWorkItemByPr(OTHER_PROJECT_KEY, 12)).toBeNull();
  });
});
