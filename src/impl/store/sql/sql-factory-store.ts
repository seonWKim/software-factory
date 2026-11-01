import type { TierHistory } from "../../../core/budget.js";
import type {
  Actor,
  BudgetCheckpoint,
  BudgetCheckpointId,
  BudgetOutcome,
  CloseReason,
  Handoff,
  Run,
  RunId,
  RunOutcome,
  RunStatus,
  SourceType,
  Stage,
  StateChange,
  StateChangeDetail,
  StateChangeId,
  Tier,
  Timestamp,
  Verdict,
  VerdictId,
  VerdictSeverity,
  WorkItem,
  WorkItemId,
} from "../../../core/types.js";
import { IMPLEMENT_KINDS } from "../../../core/policy.js";
import type { StatsRecord } from "../../../core/stats.js";
import type { Clock } from "../../../interfaces/clock.js";
import type {
  AppendInboxResult,
  AnswerBudgetCheckpointInput,
  BudgetCheckpointResult,
  ClaimInput,
  FactoryStore,
  InboxRow,
  LeaseResult,
  ListenerLease,
  ListenerLeaseResult,
  NewInboxEvent,
  NewRun,
  NewWorkItem,
  OpenBudgetCheckpointInput,
  RecordVerdictInput,
  RecordVerdictResult,
  TransitionInput,
  TransitionResult,
  WorkItemFilter,
} from "../../../interfaces/factory-store.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import type { Row, SqlDriver, SqlExecutor, SqlValue } from "./driver.js";
import {
  WORK_ITEM_COLUMNS,
  diffPatch,
  newId,
  newWorkItem,
  rowToBudgetCheckpoint,
  rowToHandoff,
  rowToRun,
  rowToStateChange,
  rowToVerdict,
  rowToWorkItem,
  workItemValues,
} from "./rows.js";

/**
 * FactoryStore over any SqlDriver (SQLite, MySQL). Every write is one driver transaction. Correctness
 * never depends on the row locks alone: every state change is also a conditional UPDATE (version,
 * status, lease token), and uniqueness is enforced by keys, with a duplicate treated as "already there".
 */
export class SqlFactoryStore implements FactoryStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
  ) {}

  migrate(): Promise<void> {
    return this.db.migrate();
  }

  close(): Promise<void> {
    return this.db.close();
  }

  // Work items

  async createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id"> },
  ): Promise<{ item: WorkItem; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await this.selectItemBySource(tx, input.source.type, input.source.id);
      if (existing) return { item: existing, created: false };

      const item = newWorkItem(input, this.now());
      const values = workItemValues(item);
      const inserted = await this.insertOnce(
        tx,
        `INSERT INTO work_items (${WORK_ITEM_COLUMNS}) VALUES (${placeholders(values.length)})`,
        values,
      );
      // A concurrent intake of the same source committed first.
      if (!inserted) return { item: (await this.selectItemBySource(tx, input.source.type, input.source.id))!, created: false };

      await this.insertStateChange(tx, item.id, 1, actor, "intake", { stage: { from: null as never, to: "NEW" } });
      if (opts?.enqueue) await this.insertRun(tx, { ...opts.enqueue, work_item_id: item.id });
      return { item, created: true };
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return this.selectItem(this.db, id);
  }

  async getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null> {
    return this.selectItemBySource(this.db, type, sourceId);
  }

  async getWorkItemByPr(project: string, pr_number: number): Promise<WorkItem | null> {
    const [row] = await this.db.all(
      `SELECT * FROM work_items WHERE project = ? AND pr_number = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`,
      [project, pr_number],
    );
    return row ? rowToWorkItem(row) : null;
  }

  async getWorkItemByMergeSha(project: string, sha: string): Promise<WorkItem | null> {
    const [row] = await this.db.all(
      `SELECT * FROM work_items WHERE merge_sha = ? AND project = ? ORDER BY created_at, ${this.db.dialect.seq} LIMIT 1`,
      [sha, project],
    );
    return row ? rowToWorkItem(row) : null;
  }

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM work_items ORDER BY created_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map(rowToWorkItem);
  }

  async listWorkItemsWhere(filter: WorkItemFilter): Promise<WorkItem[]> {
    const { where, params } = whereOf(filter);
    const rows = await this.db.all(
      `SELECT * FROM work_items${where} ORDER BY updated_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`,
      [...params, filter.limit],
    );
    return rows.map(rowToWorkItem);
  }

  async countWorkItemsWhere(filter: Omit<WorkItemFilter, "limit">): Promise<number> {
    const { where, params } = whereOf(filter);
    const [row] = await this.db.all(`SELECT COUNT(*) AS n FROM work_items${where}`, params);
    return Number(row?.n ?? 0);
  }

  async countWorkItemsByStage(): Promise<Record<Stage, number>> {
    const counts: Record<Stage, number> = { NEW: 0, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 0 };
    const rows = await this.db.all("SELECT stage, COUNT(*) AS n FROM work_items GROUP BY stage");
    for (const r of rows) counts[r.stage as Stage] = Number(r.n);
    return counts;
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.db.transaction((tx) => this.applyTransition(tx, input));
  }

  /** transition() inside a caller's transaction. A refusal returns before anything is written. */
  private async applyTransition(tx: SqlExecutor, input: TransitionInput): Promise<TransitionResult> {
    const { forUpdate } = this.db.dialect;
    const current = await this.selectItem(tx, input.id, forUpdate);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

    if (input.ack_run !== undefined) {
      const run = await this.selectRun(tx, input.ack_run, forUpdate);
      const finished = run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
      if (!run || run.work_item_id !== input.id || !finished || run.acknowledged_at !== null) {
        return { ok: false, reason: "run_not_ackable" };
      }
    }

    const { changes, sets, values } = diffPatch(current, input.patch);
    const now = this.now();
    const version = current.version + 1;
    const updated = await tx.run(
      `UPDATE work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
      [...values, version, now, input.id, input.expected_version],
    );
    if (updated !== 1) return { ok: false, reason: "version_conflict", current };

    const state_change = await this.insertStateChange(
      tx, input.id, version, input.actor, input.reason, changes, input.detail ?? null,
    );
    if (input.ack_run !== undefined) {
      await tx.run("UPDATE runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, input.ack_run]);
    }
    const enqueued = input.enqueue ? await this.insertRun(tx, { ...input.enqueue, work_item_id: input.id }) : null;
    const cancelled = input.cancel_queued_runs ? await this.cancelQueuedRuns(tx, input.id, now) : [];
    const item = (await this.selectItem(tx, input.id))!;
    // Closing the item settles its checkpoints that have no outcome yet (design §6).
    const outcome = item.close_reason === null ? null : OUTCOME[item.close_reason];
    if (current.stage !== "CLOSED" && item.stage === "CLOSED" && outcome) {
      await tx.run("UPDATE budget_checkpoints SET outcome = ? WHERE work_item_id = ? AND outcome IS NULL", [outcome, input.id]);
    }
    return { ok: true, item, state_change, enqueued, cancelled };
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = await this.db.all("SELECT * FROM state_changes WHERE work_item_id = ? ORDER BY version", [id]);
    return rows.map(rowToStateChange);
  }

  async recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictResult> {
    const { forUpdate } = this.db.dialect;
    try {
      return await this.db.transaction(async (tx): Promise<RecordVerdictResult> => {
        const current = await this.selectItem(tx, input.id, forUpdate);
        if (!current) return { ok: false, reason: "not_found" };
        // Before the version: a redelivered comment is a no-op whatever happened to the item since.
        const existing = await this.selectVerdictByComment(tx, input.comment_id);
        if (existing) return { ok: false, reason: "duplicate", verdict: existing };
        if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

        const now = this.now();
        const version = current.version + 1;
        const updated = await tx.run("UPDATE work_items SET version = ?, updated_at = ? WHERE id = ? AND version = ?", [
          version, now, input.id, input.expected_version,
        ]);
        if (updated !== 1) return { ok: false, reason: "version_conflict", current };

        const state_change = await this.insertStateChange(tx, input.id, version, input.actor, "human_verdict", {});
        const verdict: Verdict = {
          id: newId("vd") as VerdictId,
          work_item_id: input.id,
          state_change_id: state_change.id,
          verdict: input.verdict,
          severity: input.severity,
          reason: input.reason,
          comment_id: input.comment_id,
          target: input.target,
          at: now,
        };
        const inserted = await this.insertOnce(
          tx,
          `INSERT INTO verdicts (id, work_item_id, state_change_id, verdict, severity, reason, comment_id, target, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            verdict.id, verdict.work_item_id, verdict.state_change_id, verdict.verdict, verdict.severity,
            verdict.reason, verdict.comment_id, verdict.target, verdict.at,
          ],
        );
        // A concurrent delivery of the same comment committed first: undo the version bump and state change.
        if (!inserted) throw new DuplicateVerdict();
        return { ok: true, item: (await this.selectItem(tx, input.id))!, state_change, verdict };
      });
    } catch (err) {
      if (!(err instanceof DuplicateVerdict)) throw err;
      return { ok: false, reason: "duplicate", verdict: (await this.selectVerdictByComment(this.db, input.comment_id))! };
    }
  }

  async listVerdicts(id: WorkItemId): Promise<Verdict[]> {
    const rows = await this.db.all(`SELECT * FROM verdicts WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToVerdict);
  }

  // Budget checkpoints

  async openBudgetCheckpoint(input: OpenBudgetCheckpointInput): Promise<BudgetCheckpointResult> {
    const { checkpoint, ...transition } = input;
    return this.db.transaction(async (tx): Promise<BudgetCheckpointResult> => {
      const [pending] = await tx.all("SELECT id FROM budget_checkpoints WHERE work_item_id = ? AND answer = 'pending'", [input.id]);
      if (pending) return { ok: false, reason: "checkpoint_pending" };
      const r = await this.applyTransition(tx, transition);
      if (!r.ok) return r;
      const id = newId("bc") as BudgetCheckpointId;
      await tx.run(
        `INSERT INTO budget_checkpoints (id, work_item_id, tier, tokens_spent, budget, suggested_budget, answer, granted_budget,
           held_run_kind, held_run_key, held_run_not_before, outcome, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, ?, NULL)`,
        [
          id, input.id, checkpoint.tier, checkpoint.tokens_spent, checkpoint.budget, checkpoint.suggested_budget,
          checkpoint.held_run_kind, checkpoint.held_run_key, checkpoint.held_run_not_before, this.now(),
        ],
      );
      return { ...r, checkpoint: (await this.selectCheckpoint(tx, id))! };
    });
  }

  async answerBudgetCheckpoint(input: AnswerBudgetCheckpointInput): Promise<BudgetCheckpointResult> {
    const { checkpoint_id, answer, granted_budget, ...transition } = input;
    try {
      return await this.db.transaction(async (tx): Promise<BudgetCheckpointResult> => {
        const cp = await this.selectCheckpoint(tx, checkpoint_id, this.db.dialect.forUpdate);
        if (!cp || cp.work_item_id !== input.id || cp.answer !== "pending") return { ok: false, reason: "checkpoint_not_pending" };
        const r = await this.applyTransition(tx, transition);
        if (!r.ok) return r;
        const answered = await tx.run(
          "UPDATE budget_checkpoints SET answer = ?, granted_budget = ?, answered_at = ? WHERE id = ? AND answer = 'pending'",
          [answer, granted_budget, this.now(), checkpoint_id],
        );
        // A concurrent answer committed first: undo this transition.
        if (answered !== 1) throw new CheckpointAnswered();
        return { ...r, checkpoint: (await this.selectCheckpoint(tx, checkpoint_id))! };
      });
    } catch (err) {
      if (!(err instanceof CheckpointAnswered)) throw err;
      return { ok: false, reason: "checkpoint_not_pending" };
    }
  }

  async listBudgetCheckpoints(id: WorkItemId): Promise<BudgetCheckpoint[]> {
    const rows = await this.db.all(
      `SELECT * FROM budget_checkpoints WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`,
      [id],
    );
    return rows.map(rowToBudgetCheckpoint);
  }

  async getTierHistory(project: string, tier: Tier): Promise<TierHistory> {
    const rows = await this.db.all(
      "SELECT close_reason, token_cost FROM work_items WHERE project = ? AND tier = ? AND stage = 'CLOSED'",
      [project, tier],
    );
    return {
      finished: rows.length,
      merged_token_costs: rows.filter((r) => r.close_reason === "completed").map((r) => Number(r.token_cost)),
    };
  }

  async listStatsRecords(reasons: readonly string[]): Promise<StatsRecord[]> {
    const { seq } = this.db.dialect;
    // Three plain reads, no transaction: a read-only command takes no write lock (SQLite) and no row lock.
    const items = await this.db.all(`SELECT id, tier, stage, token_cost FROM work_items ORDER BY created_at, ${seq}`);
    const records = new Map<string, StatsRecord>();
    for (const r of items) {
      records.set(r.id as string, {
        id: r.id as WorkItemId,
        tier: r.tier === null ? null : (Number(r.tier) as Tier),
        stage: r.stage as Stage,
        token_cost: Number(r.token_cost),
        reasons: [],
        severities: [],
      });
    }
    if (reasons.length > 0) {
      const changes = await this.db.all(
        `SELECT work_item_id, reason FROM state_changes WHERE reason IN (${placeholders(reasons.length)})
         ORDER BY work_item_id, version`,
        [...reasons],
      );
      for (const c of changes) records.get(c.work_item_id as string)?.reasons.push(c.reason as string);
    }
    const verdicts = await this.db.all(`SELECT work_item_id, severity FROM verdicts ORDER BY at, ${seq}`);
    for (const v of verdicts) records.get(v.work_item_id as string)?.severities.push(v.severity as VerdictSeverity);
    return [...records.values()];
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    if (input.kinds.length === 0) return null;
    const { seq, forUpdate } = this.db.dialect;
    const writeKinds = placeholders(IMPLEMENT_KINDS.length);
    return this.db.transaction(async (tx) => {
      // The lock row first: claimers run the same-item check below one at a time, so two of them can never both
      // see "nothing of this item is running" and claim two runs of one item. Only a claim moves a run to 'running',
      // so the running set read under the lock stays true until this commits. (SQLite: BEGIN IMMEDIATE already
      // serializes; the select is a no-op.)
      await tx.all(`SELECT name FROM claim_locks WHERE name = ?${forUpdate}`, [CLAIM_LOCK]);
      const now = this.now();
      // A usage or rate limit pauses every claim, for every item, on every replica (design §5 Restarts).
      const [pause] = await tx.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [RATE_LIMIT_PAUSE]);
      if (pause && (pause.resume_at as string) > now) return null;

      // Items with an implement-type run in progress (architecture §4, one branch writer per item). Items whose
      // allowed_paths overlap do run side by side; their conflicts are resolved at merge.
      const busy = new Set(
        (
          await tx.all(`SELECT work_item_id FROM runs WHERE status = 'running' AND kind IN (${writeKinds})`, [...IMPLEMENT_KINDS])
        ).map((r) => r.work_item_id as string),
      );

      // Queued runs in FIFO order. not_before: a retry waits out its backoff, whichever worker looks.
      const queued = await tx.all(
        `SELECT r.id, r.kind, r.work_item_id FROM runs r
         WHERE r.status = 'queued' AND r.kind IN (${placeholders(input.kinds.length)})
           AND (r.not_before IS NULL OR r.not_before <= ?)
         ORDER BY r.created_at, r.${seq}`,
        [...input.kinds, now],
      );
      for (const next of queued) {
        // An implement-type run waits while its own item has one running; it stays queued. Triage and review never wait.
        if ((IMPLEMENT_KINDS as readonly string[]).includes(next.kind as string) && busy.has(next.work_item_id as string)) continue;
        const id = next.id as RunId;
        const claimed = await tx.run(
          `UPDATE runs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_token = lease_token + 1,
             lease_expires_at = ?, started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
          [input.worker_id, this.after(input.lease_ms), now, now, id],
        );
        if (claimed === 1) return this.selectRun(tx, id);
      }
      return null;
    });
  }

  async pauseClaims(resume_at: Timestamp): Promise<{ extended: boolean; resume_at: Timestamp }> {
    return this.db.transaction(async (tx) => {
      if (await this.insertOnce(tx, "INSERT INTO claim_pauses (name, resume_at) VALUES (?, ?)", [RATE_LIMIT_PAUSE, resume_at])) {
        return { extended: true, resume_at };
      }
      // Conditional: only a later time moves it, so concurrent pauses keep the latest.
      const moved = await tx.run("UPDATE claim_pauses SET resume_at = ? WHERE name = ? AND resume_at < ?", [
        resume_at, RATE_LIMIT_PAUSE, resume_at,
      ]);
      if (moved === 1) return { extended: true, resume_at };
      const [row] = await tx.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [RATE_LIMIT_PAUSE]);
      return { extended: false, resume_at: row!.resume_at as Timestamp };
    });
  }

  async getClaimPause(): Promise<Timestamp | null> {
    const [row] = await this.db.all("SELECT resume_at FROM claim_pauses WHERE name = ?", [RATE_LIMIT_PAUSE]);
    const at = (row?.resume_at as Timestamp | undefined) ?? null;
    return at !== null && at > this.now() ? at : null;
  }

  // Lease checks below test status and token only, never lease_expires_at. Fencing comes from the token:
  // the reaper moves an expired run out of 'running' and only a claim bumps lease_token. So a holder whose
  // lease ran out (host sleep) but was not reaped yet can still renew and finish (design §5).
  async heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const extended = await tx.run(
        `UPDATE runs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [this.after(lease_ms), now, runId, token],
      );
      return extended === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const completed = await tx.run(
        `UPDATE runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [outcome.status, JSON.stringify(outcome), now, now, runId, token],
      );
      return completed === 1 ? { ok: true, run: (await this.selectRun(tx, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async listUnacknowledgedRuns(limit: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND acknowledged_at IS NULL
       ORDER BY updated_at, ${this.db.dialect.seq} LIMIT ?`,
      [limit],
    );
    return rows.map(rowToRun);
  }

  async expireLeases(max_attempts: number, backoff_ms?: (attempt: number) => number): Promise<RunId[]> {
    const { forUpdateSkipLocked } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // A run another reaper holds right now is left for the next tick.
      const expired = await tx.all(
        `SELECT id, attempt, work_item_id FROM runs WHERE status = 'running' AND lease_expires_at <= ?${forUpdateSkipLocked}`,
        [now],
      );
      const failed: RunOutcome = {
        status: "failed",
        error_code: "lease_expired",
        detail: `lease expired after ${max_attempts} attempts`,
        infra: true,
      };
      for (const run of expired) {
        const item = await this.selectItem(tx, run.work_item_id as WorkItemId);
        if (item?.stage === "CLOSED") {
          // A closed item never runs again: its expired run is cancelled, not requeued.
          await tx.run(
            `UPDATE runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [now, run.id as string],
          );
        } else if (Number(run.attempt) >= max_attempts) {
          await tx.run(
            `UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?,
               updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [JSON.stringify(failed), now, now, run.id as string],
          );
        } else {
          // Same backoff as any other retry, so a lasting outage does not use up the attempts at once.
          const not_before = backoff_ms ? this.after(backoff_ms(Number(run.attempt))) : null;
          await tx.run(
            `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, not_before = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [not_before, now, run.id as string],
          );
        }
      }
      return expired.map((r) => r.id as RunId);
    });
  }

  async getRun(id: RunId): Promise<Run | null> {
    return this.selectRun(this.db, id);
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    const rows = await this.db.all(`SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToRun);
  }

  async listRunsByStatus(statuses: readonly RunStatus[], limit: number): Promise<Run[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE status IN (${placeholders(statuses.length)}) ORDER BY created_at, ${this.db.dialect.seq} LIMIT ?`,
      [...statuses, limit],
    );
    return rows.map(rowToRun);
  }

  async listRunsFinishedWithin(window_ms: number): Promise<Run[]> {
    const rows = await this.db.all(
      `SELECT * FROM runs WHERE finished_at IS NOT NULL AND finished_at >= ? ORDER BY finished_at DESC, ${this.db.dialect.seq} DESC`,
      [this.after(-window_ms)],
    );
    return rows.map(rowToRun);
  }

  // Handoffs

  async appendHandoff(
    input: Omit<Handoff, "id" | "at">,
    token: number,
  ): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }> {
    const { forShare } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // FOR SHARE: status and token are what fence the holder; the row lock keeps the reaper and a
      // completion from moving the run out of 'running' (and a reclaim from bumping the token) until this commits.
      const [holds] = await tx.all(
        `SELECT 1 AS held FROM runs WHERE id = ? AND work_item_id = ? AND status = 'running' AND lease_token = ?${forShare}`,
        [input.run_id, input.work_item_id, token],
      );
      if (!holds) return { ok: false, reason: "lease_lost" };
      await this.insertOnce(
        tx,
        `INSERT INTO handoffs (id, run_id, work_item_id, commit_sha, worked_on, next_steps, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("ho"), input.run_id, input.work_item_id, input.commit_sha, input.worked_on, input.next_steps, now],
      );
      const [row] = await tx.all("SELECT * FROM handoffs WHERE run_id = ? AND commit_sha = ?", [input.run_id, input.commit_sha]);
      return { ok: true, handoff: rowToHandoff(row!) };
    });
  }

  async listHandoffs(id: WorkItemId): Promise<Handoff[]> {
    const rows = await this.db.all(`SELECT * FROM handoffs WHERE work_item_id = ? ORDER BY at, ${this.db.dialect.seq}`, [id]);
    return rows.map(rowToHandoff);
  }

  // Cursors

  async getCursor(name: string): Promise<string | null> {
    const [row] = await this.db.all("SELECT value FROM cursors WHERE name = ?", [name]);
    return (row?.value as string | undefined) ?? null;
  }

  async advanceCursor(name: string, expected: string | null, next: string): Promise<boolean> {
    return this.db.transaction(async (tx) =>
      expected === null
        ? this.insertOnce(tx, "INSERT INTO cursors (name, value) VALUES (?, ?)", [name, next])
        : (await tx.run("UPDATE cursors SET value = ? WHERE name = ? AND value = ?", [next, name, expected])) === 1,
    );
  }

  // Stream intake

  async appendInbox(input: NewInboxEvent): Promise<AppendInboxResult> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx): Promise<AppendInboxResult> => {
      // FOR UPDATE on the lease row: a takeover (token + 1) waits for this append to commit, and appends of
      // one source type commit one at a time, so their seqs commit in order and a cursor never skips one.
      const [held] = await tx.all(
        `SELECT token FROM listener_leases WHERE source_type = ? AND token = ?${forUpdate}`,
        [input.source_type, input.lease_token],
      );
      if (!held) return { ok: false, reason: "lease_lost" };
      const existing = await this.selectInbox(tx, input.source_type, input.dedupe_key);
      if (existing) return { ok: true, row: existing, duplicate: true };
      const inserted = await this.insertOnce(
        tx,
        "INSERT INTO source_inbox (source_type, dedupe_key, event, received_at) VALUES (?, ?, ?, ?)",
        [input.source_type, input.dedupe_key, JSON.stringify(input.event), this.now()],
      );
      const row = (await this.selectInbox(tx, input.source_type, input.dedupe_key))!;
      return { ok: true, row, duplicate: !inserted };
    });
  }

  async listInboxAfter(source_type: SourceType, after_seq: number, limit: number): Promise<InboxRow[]> {
    const rows = await this.db.all("SELECT * FROM source_inbox WHERE source_type = ? AND seq > ? ORDER BY seq LIMIT ?", [
      source_type, after_seq, limit,
    ]);
    return rows.map(rowToInbox);
  }

  async pruneInbox(source_type: SourceType, through_seq: number, older_than_ms: number): Promise<number> {
    return this.db.transaction((tx) =>
      tx.run("DELETE FROM source_inbox WHERE source_type = ? AND seq <= ? AND received_at < ?", [
        source_type, through_seq, this.after(-older_than_ms),
      ]),
    );
  }

  async acquireListenerLease(source_type: SourceType, owner: string, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const expires_at = this.after(lease_ms);
      const created = await this.insertOnce(
        tx,
        "INSERT INTO listener_leases (source_type, owner, token, expires_at) VALUES (?, ?, 1, ?)",
        [source_type, owner, expires_at],
      );
      if (created) return { ok: true, lease: { source_type, owner, token: 1, expires_at } };
      // Conditional: only an expired (or released) lease can be taken, and taking it bumps the token.
      const taken = await tx.run(
        "UPDATE listener_leases SET owner = ?, token = token + 1, expires_at = ? WHERE source_type = ? AND expires_at <= ?",
        [owner, expires_at, source_type, this.now()],
      );
      const lease = await this.selectListenerLease(tx, source_type);
      return taken === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "held", holder: lease };
    });
  }

  async renewListenerLease(source_type: SourceType, token: number, lease_ms: number): Promise<ListenerLeaseResult> {
    return this.db.transaction(async (tx): Promise<ListenerLeaseResult> => {
      const renewed = await tx.run("UPDATE listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [
        this.after(lease_ms), source_type, token,
      ]);
      const lease = await this.selectListenerLease(tx, source_type);
      return renewed === 1 ? { ok: true, lease: lease! } : { ok: false, reason: "lease_lost", holder: lease };
    });
  }

  async releaseListenerLease(source_type: SourceType, token: number): Promise<void> {
    await this.db.transaction((tx) =>
      tx.run("UPDATE listener_leases SET expires_at = ? WHERE source_type = ? AND token = ?", [this.now(), source_type, token]),
    );
  }

  // Internals

  private async selectInbox(q: SqlExecutor, source_type: SourceType, dedupe_key: string): Promise<InboxRow | null> {
    const [row] = await q.all("SELECT * FROM source_inbox WHERE source_type = ? AND dedupe_key = ?", [source_type, dedupe_key]);
    return row ? rowToInbox(row) : null;
  }

  private async selectListenerLease(q: SqlExecutor, source_type: SourceType): Promise<ListenerLease | null> {
    const [row] = await q.all("SELECT * FROM listener_leases WHERE source_type = ?", [source_type]);
    return row
      ? {
          source_type: row.source_type as SourceType,
          owner: row.owner as string,
          token: Number(row.token),
          expires_at: row.expires_at as Timestamp,
        }
      : null;
  }

  /** False if a unique key says the row is already there. */
  private async insertOnce(tx: SqlExecutor, sql: string, params: (string | number | null)[]): Promise<boolean> {
    try {
      await tx.run(sql, params);
      return true;
    } catch (err) {
      if (this.db.isDuplicateKey(err)) return false;
      throw err;
    }
  }

  private now(): Timestamp {
    return this.clock.now().toISOString() as Timestamp;
  }

  private after(ms: number): Timestamp {
    return new Date(this.clock.now().getTime() + ms).toISOString() as Timestamp;
  }

  private async selectItem(q: SqlExecutor, id: WorkItemId, lock = ""): Promise<WorkItem | null> {
    const [row] = await q.all(`SELECT * FROM work_items WHERE id = ?${lock}`, [id]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectItemBySource(q: SqlExecutor, type: SourceType, sourceId: string): Promise<WorkItem | null> {
    const [row] = await q.all("SELECT * FROM work_items WHERE source_type = ? AND source_id = ?", [type, sourceId]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectVerdictByComment(q: SqlExecutor, commentId: string): Promise<Verdict | null> {
    const [row] = await q.all("SELECT * FROM verdicts WHERE comment_id = ?", [commentId]);
    return row ? rowToVerdict(row) : null;
  }

  private async selectCheckpoint(q: SqlExecutor, id: BudgetCheckpointId, lock = ""): Promise<BudgetCheckpoint | null> {
    const [row] = await q.all(`SELECT * FROM budget_checkpoints WHERE id = ?${lock}`, [id]);
    return row ? rowToBudgetCheckpoint(row) : null;
  }

  private async selectRun(q: SqlExecutor, id: RunId, lock = ""): Promise<Run | null> {
    const [row] = await q.all(`SELECT * FROM runs WHERE id = ?${lock}`, [id]);
    return row ? rowToRun(row) : null;
  }

  /**
   * Cancels the item's queued runs. Each update is conditional on `queued`, so a run a concurrent claim
   * took first stays running and is not reported.
   */
  private async cancelQueuedRuns(tx: SqlExecutor, workItemId: WorkItemId, now: Timestamp): Promise<RunId[]> {
    const rows = await tx.all(`SELECT id FROM runs WHERE work_item_id = ? AND status = 'queued'${this.db.dialect.forUpdate}`, [
      workItemId,
    ]);
    const cancelled: RunId[] = [];
    for (const r of rows) {
      const n = await tx.run(
        "UPDATE runs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
        [now, r.id as string],
      );
      if (n === 1) cancelled.push(r.id as RunId);
    }
    return cancelled;
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private async insertRun(tx: SqlExecutor, input: NewRun): Promise<Run | null> {
    const id = newId("run") as RunId;
    const now = this.now();
    const inserted = await this.insertOnce(
      tx,
      `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, not_before, input, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)`,
      [
        id, input.work_item_id, input.kind, input.idempotency_key, input.not_before ?? null,
        input.input ? JSON.stringify(input.input) : null, now, now,
      ],
    );
    return inserted ? this.selectRun(tx, id) : null;
  }

  private async insertStateChange(
    tx: SqlExecutor,
    workItemId: WorkItemId,
    version: number,
    actor: Actor,
    reason: string,
    changes: StateChange["changes"],
    detail: StateChangeDetail | null = null,
  ): Promise<StateChange> {
    const change: StateChange = {
      id: newId("sc") as StateChangeId,
      work_item_id: workItemId,
      version,
      at: this.now(),
      actor,
      reason,
      changes,
      detail,
    };
    await tx.run(
      "INSERT INTO state_changes (id, work_item_id, version, at, actor, reason, changes, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        change.id, workItemId, version, change.at, JSON.stringify(actor), reason, JSON.stringify(changes),
        detail === null ? null : JSON.stringify(detail),
      ],
    );
    return change;
  }
}

/** Thrown inside recordVerdict's transaction to roll it back when the verdict's comment id is already taken. */
class DuplicateVerdict extends Error {}

/** Thrown inside answerBudgetCheckpoint's transaction to roll it back when another answer won. */
class CheckpointAnswered extends Error {}

/** A closed item's checkpoint outcome, by close_reason. Other close reasons leave it null. */
const OUTCOME: Partial<Record<CloseReason, BudgetOutcome>> = { completed: "merged", rejected: "rejected", failed: "failed" };

/** The one claim pause today: a usage or rate limit on the agent harness. */
const RATE_LIMIT_PAUSE = "rate_limit";

function rowToInbox(row: Row): InboxRow {
  return {
    seq: Number(row.seq),
    source_type: row.source_type as SourceType,
    dedupe_key: row.dedupe_key as string,
    event: JSON.parse(row.event as string) as SourceEvent,
    received_at: row.received_at as Timestamp,
  };
}

/** The WHERE clause (with leading space, or empty) for a WorkItemFilter. */
function whereOf(filter: Omit<WorkItemFilter, "limit">): { where: string; params: SqlValue[] } {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filter.stage !== undefined) {
    where.push("stage = ?");
    params.push(filter.stage);
  } else if (filter.exclude_closed) {
    where.push("stage <> 'CLOSED'");
  }
  if (filter.blocked_on !== undefined) {
    where.push("blocked_on = ?");
    params.push(filter.blocked_on);
  }
  return { where: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

/** The one row in `claim_locks`: every claim takes it first (migration 7). */
const CLAIM_LOCK = "claim";

/** A JSON string array column (allowed_paths). */
function parseList(value: unknown): string[] {
  return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
