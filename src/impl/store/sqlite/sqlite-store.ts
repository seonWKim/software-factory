import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
} from "../rows.js";
import { MIGRATIONS } from "./schema.js";

type Row = Record<string, SQLInputValue>;

/**
 * Single-node FactoryStore. Every method runs in one `BEGIN IMMEDIATE` transaction, which takes the
 * write lock up front, so concurrent processes on the same file serialize instead of deadlocking.
 * More than one node requires the Postgres implementation (architecture §4).
 */
export class SqliteFactoryStore implements FactoryStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly clock: Clock,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  async migrate(): Promise<void> {
    this.tx(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
      const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
      for (let v = (row.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // Work items

  async createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id"> },
  ): Promise<{ item: WorkItem; created: boolean }> {
    return this.tx(() => {
      const existing = this.selectItemBySource(input.source.type, input.source.id);
      if (existing) return { item: existing, created: false };

      const item = newWorkItem(input, this.now());
      const values = workItemValues(item);
      this.db
        .prepare(`INSERT INTO work_items (${WORK_ITEM_COLUMNS}) VALUES (${values.map(() => "?").join(", ")})`)
        .run(...values);
      this.insertStateChange(item.id, 1, actor, "intake", { stage: { from: null as never, to: "NEW" } });
      if (opts?.enqueue) this.insertRun({ ...opts.enqueue, work_item_id: item.id });
      return { item, created: true };
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return this.selectItem(id);
  }

  async getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null> {
    return this.selectItemBySource(type, sourceId);
  }

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = this.db.prepare("SELECT * FROM work_items ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToWorkItem);
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.tx(() => {
      const current = this.selectItem(input.id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

      if (input.ack_run !== undefined) {
        const run = this.selectRun(input.ack_run);
        const finished = run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
        if (!run || run.work_item_id !== input.id || !finished || run.acknowledged_at !== null) {
          return { ok: false, reason: "run_not_ackable" };
        }
      }

      const { changes, sets, values } = diffPatch(current, input.patch);

      const now = this.now();
      const version = current.version + 1;
      const updated = this.db
        .prepare(`UPDATE work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
        .run(...values, version, now, input.id, input.expected_version);
      if (updated.changes !== 1) return { ok: false, reason: "version_conflict", current };

      const state_change = this.insertStateChange(input.id, version, input.actor, input.reason, changes);
      if (input.ack_run !== undefined) {
        this.db.prepare("UPDATE runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?").run(now, now, input.ack_run);
      }
      const enqueued = input.enqueue ? this.insertRun({ ...input.enqueue, work_item_id: input.id }) : null;
      return { ok: true, item: this.selectItem(input.id)!, state_change, enqueued };
    });
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = this.db.prepare("SELECT * FROM state_changes WHERE work_item_id = ? ORDER BY version").all(id) as Row[];
    return rows.map(rowToStateChange);
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    if (input.kinds.length === 0) return null;
    return this.tx(() => {
      const placeholders = input.kinds.map(() => "?").join(", ");
      const next = this.db
        .prepare(`SELECT id FROM runs WHERE status = 'queued' AND kind IN (${placeholders}) ORDER BY created_at, rowid LIMIT 1`)
        .get(...input.kinds) as { id: string } | undefined;
      if (!next) return null;
      const now = this.now();
      const row = this.db
        .prepare(
          `UPDATE runs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_token = lease_token + 1,
             lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued' RETURNING *`,
        )
        .get(input.worker_id, this.after(input.lease_ms), now, next.id) as Row | undefined;
      return row ? rowToRun(row) : null;
    });
  }

  async heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult> {
    return this.tx(() => {
      const now = this.now();
      const row = this.db
        .prepare(
          `UPDATE runs SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ? RETURNING *`,
        )
        .get(this.after(lease_ms), now, runId, token, now) as Row | undefined;
      return row ? { ok: true, run: rowToRun(row) } : { ok: false, reason: "lease_lost" };
    });
  }

  async completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult> {
    return this.tx(() => {
      const now = this.now();
      const row = this.db
        .prepare(
          `UPDATE runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ? RETURNING *`,
        )
        .get(outcome.status, JSON.stringify(outcome), now, runId, token, now) as Row | undefined;
      return row ? { ok: true, run: rowToRun(row) } : { ok: false, reason: "lease_lost" };
    });
  }

  async listUnacknowledgedRuns(limit: number): Promise<Run[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND acknowledged_at IS NULL
         ORDER BY updated_at, rowid LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(rowToRun);
  }

  async expireLeases(max_attempts: number): Promise<RunId[]> {
    return this.tx(() => {
      const now = this.now();
      const expired = this.db
        .prepare("SELECT id, attempt FROM runs WHERE status = 'running' AND lease_expires_at <= ?")
        .all(now) as { id: string; attempt: number }[];
      const failed: RunOutcome = {
        status: "failed",
        error_code: "lease_expired",
        detail: `lease expired after ${max_attempts} attempts`,
        infra: true,
      };
      for (const run of expired) {
        if (run.attempt >= max_attempts) {
          this.db
            .prepare(
              `UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(JSON.stringify(failed), now, run.id);
        } else {
          this.db
            .prepare(
              `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(now, run.id);
        }
      }
      return expired.map((r) => r.id as RunId);
    });
  }

  async getRun(id: RunId): Promise<Run | null> {
    return this.selectRun(id);
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    const rows = this.db.prepare("SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at, rowid").all(id) as Row[];
    return rows.map(rowToRun);
  }

  // Handoffs

  async appendHandoff(
    input: Omit<Handoff, "id" | "at">,
    token: number,
  ): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }> {
    return this.tx(() => {
      const now = this.now();
      const holds = this.db
        .prepare(
          `SELECT 1 FROM runs WHERE id = ? AND work_item_id = ? AND status = 'running' AND lease_token = ?
             AND lease_expires_at > ?`,
        )
        .get(input.run_id, input.work_item_id, token, now);
      if (!holds) return { ok: false, reason: "lease_lost" };
      this.db
        .prepare(
          `INSERT INTO handoffs (id, run_id, work_item_id, commit_sha, worked_on, next_steps, at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, commit_sha) DO NOTHING`,
        )
        .run(newId("ho"), input.run_id, input.work_item_id, input.commit_sha, input.worked_on, input.next_steps, now);
      const row = this.db
        .prepare("SELECT * FROM handoffs WHERE run_id = ? AND commit_sha = ?")
        .get(input.run_id, input.commit_sha) as Row;
      return { ok: true, handoff: rowToHandoff(row) };
    });
  }

  async listHandoffs(id: WorkItemId): Promise<Handoff[]> {
    const rows = this.db.prepare("SELECT * FROM handoffs WHERE work_item_id = ? ORDER BY at, rowid").all(id) as Row[];
    return rows.map(rowToHandoff);
  }

  // Cursors

  async getCursor(name: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM cursors WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async advanceCursor(name: string, expected: string | null, next: string): Promise<boolean> {
    return this.tx(() => {
      const result =
        expected === null
          ? this.db.prepare("INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING").run(name, next)
          : this.db.prepare("UPDATE cursors SET value = ? WHERE name = ? AND value = ?").run(next, name, expected);
      return result.changes === 1;
    });
  }

  // Internals

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private now(): Timestamp {
    return this.clock.now().toISOString() as Timestamp;
  }

  private after(ms: number): Timestamp {
    return new Date(this.clock.now().getTime() + ms).toISOString() as Timestamp;
  }

  private selectItem(id: WorkItemId): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  private selectItemBySource(type: SourceType, sourceId: string): WorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE source_type = ? AND source_id = ?")
      .get(type, sourceId) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  private selectRun(id: RunId): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private insertRun(input: NewRun): Run | null {
    const now = this.now();
    const row = this.db
      .prepare(
        `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      )
      .get(newId("run"), input.work_item_id, input.kind, input.idempotency_key, now, now) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  private insertStateChange(
    workItemId: WorkItemId,
    version: number,
    actor: Actor,
    reason: string,
    changes: StateChange["changes"],
  ): StateChange {
    const change: StateChange = {
      id: newId("sc") as StateChangeId,
      work_item_id: workItemId,
      version,
      at: this.now(),
      actor,
      reason,
      changes,
    };
    this.db
      .prepare("INSERT INTO state_changes (id, work_item_id, version, at, actor, reason, changes) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(change.id, workItemId, version, change.at, JSON.stringify(actor), reason, JSON.stringify(changes));
    return change;
  }
}
