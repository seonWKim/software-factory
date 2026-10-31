import type {
  Actor,
  Handoff,
  Run,
  RunId,
  RunOutcome,
  SourceType,
  StateChange,
  StateChangeId,
  Timestamp,
  WorkItem,
  WorkItemId,
} from "../../../core/types.js";
import type { Clock } from "../../../interfaces/clock.js";
import type {
  ClaimInput,
  FactoryStore,
  LeaseResult,
  NewRun,
  NewWorkItem,
  TransitionInput,
  TransitionResult,
} from "../../../interfaces/factory-store.js";
import type { SqlDriver, SqlExecutor } from "./driver.js";
import {
  WORK_ITEM_COLUMNS,
  diffPatch,
  newId,
  newWorkItem,
  rowToHandoff,
  rowToRun,
  rowToStateChange,
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

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = await this.db.all(`SELECT * FROM work_items ORDER BY created_at DESC, ${this.db.dialect.seq} DESC LIMIT ?`, [
      limit,
    ]);
    return rows.map(rowToWorkItem);
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    const { forUpdate } = this.db.dialect;
    return this.db.transaction(async (tx) => {
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

      const state_change = await this.insertStateChange(tx, input.id, version, input.actor, input.reason, changes);
      if (input.ack_run !== undefined) {
        await tx.run("UPDATE runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, input.ack_run]);
      }
      const enqueued = input.enqueue ? await this.insertRun(tx, { ...input.enqueue, work_item_id: input.id }) : null;
      return { ok: true, item: (await this.selectItem(tx, input.id))!, state_change, enqueued };
    });
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = await this.db.all("SELECT * FROM state_changes WHERE work_item_id = ? ORDER BY version", [id]);
    return rows.map(rowToStateChange);
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    if (input.kinds.length === 0) return null;
    const { seq, forUpdateSkipLocked } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      // SKIP LOCKED: concurrent workers each take a different candidate instead of queueing on one.
      const [next] = await tx.all(
        `SELECT id FROM runs WHERE status = 'queued' AND kind IN (${placeholders(input.kinds.length)})
         ORDER BY created_at, ${seq} LIMIT 1${forUpdateSkipLocked}`,
        input.kinds,
      );
      if (!next) return null;
      const id = next.id as RunId;
      const claimed = await tx.run(
        `UPDATE runs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_token = lease_token + 1,
           lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [input.worker_id, this.after(input.lease_ms), this.now(), id],
      );
      return claimed === 1 ? this.selectRun(tx, id) : null;
    });
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
        `UPDATE runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
        [outcome.status, JSON.stringify(outcome), now, runId, token],
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

  async expireLeases(max_attempts: number): Promise<RunId[]> {
    const { forUpdateSkipLocked } = this.db.dialect;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      // A run another reaper holds right now is left for the next tick.
      const expired = await tx.all(
        `SELECT id, attempt FROM runs WHERE status = 'running' AND lease_expires_at <= ?${forUpdateSkipLocked}`,
        [now],
      );
      const failed: RunOutcome = {
        status: "failed",
        error_code: "lease_expired",
        detail: `lease expired after ${max_attempts} attempts`,
        infra: true,
      };
      for (const run of expired) {
        if (Number(run.attempt) >= max_attempts) {
          await tx.run(
            `UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [JSON.stringify(failed), now, run.id as string],
          );
        } else {
          await tx.run(
            `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [now, run.id as string],
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

  // Internals

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

  private async selectRun(q: SqlExecutor, id: RunId, lock = ""): Promise<Run | null> {
    const [row] = await q.all(`SELECT * FROM runs WHERE id = ?${lock}`, [id]);
    return row ? rowToRun(row) : null;
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private async insertRun(tx: SqlExecutor, input: NewRun): Promise<Run | null> {
    const id = newId("run") as RunId;
    const now = this.now();
    const inserted = await this.insertOnce(
      tx,
      `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?)`,
      [id, input.work_item_id, input.kind, input.idempotency_key, now, now],
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
  ): Promise<StateChange> {
    const change: StateChange = {
      id: newId("sc") as StateChangeId,
      work_item_id: workItemId,
      version,
      at: this.now(),
      actor,
      reason,
      changes,
    };
    await tx.run(
      "INSERT INTO state_changes (id, work_item_id, version, at, actor, reason, changes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [change.id, workItemId, version, change.at, JSON.stringify(actor), reason, JSON.stringify(changes)],
    );
    return change;
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
