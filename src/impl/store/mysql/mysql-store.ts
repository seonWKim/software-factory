import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
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

export interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

type Db = Pool | PoolConnection;
type Param = string | number | null | readonly string[];

const ER_DUP_ENTRY = 1062;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_LOCK_DEADLOCK = 1213;
const TX_ATTEMPTS = 5;

/**
 * Multi-node FactoryStore. Every method that writes runs in one READ COMMITTED transaction with row locks
 * (`FOR UPDATE`); claims use `SKIP LOCKED`, so concurrent workers on any host never wait on each other's
 * candidate run. Deadlocks and lock-wait timeouts retry the whole transaction.
 */
export class MysqlFactoryStore implements FactoryStore {
  private readonly pool: Pool;

  constructor(
    opts: MysqlOptions,
    private readonly clock: Clock,
  ) {
    this.pool = mysql.createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      connectionLimit: opts.connectionLimit ?? 10,
      // affectedRows = rows matched, as SQLite's `changes`, even when an UPDATE writes identical values.
      flags: ["FOUND_ROWS"],
    });
  }

  async migrate(): Promise<void> {
    const c = await this.pool.getConnection();
    try {
      // DDL commits implicitly, so concurrent migrators serialize on a named lock instead of a transaction.
      await c.query("SELECT GET_LOCK('software_factory_migrate', 60)");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL PRIMARY KEY)");
      const [[row]] = await c.query<RowDataPacket[]>("SELECT MAX(version) AS v FROM schema_migrations");
      for (let v = Number(row?.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
        for (const statement of MIGRATIONS[v - 1]!) await c.query(statement);
        await c.query("INSERT INTO schema_migrations (version) VALUES (?)", [v]);
      }
    } finally {
      await c.query("SELECT RELEASE_LOCK('software_factory_migrate')").catch(() => undefined);
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // Work items

  async createWorkItem(
    input: NewWorkItem,
    actor: Actor,
    opts?: { enqueue?: Omit<NewRun, "work_item_id"> },
  ): Promise<{ item: WorkItem; created: boolean }> {
    return this.tx(async (c) => {
      const existing = await this.selectItemBySource(c, input.source.type, input.source.id);
      if (existing) return { item: existing, created: false };

      const item = newWorkItem(input, this.now());
      const values = workItemValues(item);
      try {
        await this.exec(c, `INSERT INTO work_items (${WORK_ITEM_COLUMNS}) VALUES (${values.map(() => "?").join(", ")})`, values);
      } catch (err) {
        // A concurrent intake of the same source committed first.
        if (errno(err) !== ER_DUP_ENTRY) throw err;
        return { item: (await this.selectItemBySource(c, input.source.type, input.source.id))!, created: false };
      }
      await this.insertStateChange(c, item.id, 1, actor, "intake", { stage: { from: null as never, to: "NEW" } });
      if (opts?.enqueue) await this.insertRun(c, { ...opts.enqueue, work_item_id: item.id });
      return { item, created: true };
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return this.selectItem(this.pool, id);
  }

  async getWorkItemBySource(type: SourceType, sourceId: string): Promise<WorkItem | null> {
    return this.selectItemBySource(this.pool, type, sourceId);
  }

  async listWorkItems(limit: number): Promise<WorkItem[]> {
    const rows = await this.rows(this.pool, "SELECT * FROM work_items ORDER BY created_at DESC, seq DESC LIMIT ?", [limit]);
    return rows.map(rowToWorkItem);
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.tx(async (c) => {
      const current = await this.selectItem(c, input.id, true);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== input.expected_version) return { ok: false, reason: "version_conflict", current };

      if (input.ack_run !== undefined) {
        const [row] = await this.rows(c, "SELECT * FROM runs WHERE id = ? FOR UPDATE", [input.ack_run]);
        const run = row ? rowToRun(row) : null;
        const finished = run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled");
        if (!run || run.work_item_id !== input.id || !finished || run.acknowledged_at !== null) {
          return { ok: false, reason: "run_not_ackable" };
        }
      }

      const { changes, sets, values } = diffPatch(current, input.patch);
      const now = this.now();
      const version = current.version + 1;
      const updated = await this.exec(
        c,
        `UPDATE work_items SET ${[...sets, "version = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`,
        [...values, version, now, input.id, input.expected_version],
      );
      if (updated.affectedRows !== 1) return { ok: false, reason: "version_conflict", current };

      const state_change = await this.insertStateChange(c, input.id, version, input.actor, input.reason, changes);
      if (input.ack_run !== undefined) {
        await this.exec(c, "UPDATE runs SET acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, input.ack_run]);
      }
      const enqueued = input.enqueue ? await this.insertRun(c, { ...input.enqueue, work_item_id: input.id }) : null;
      return { ok: true, item: (await this.selectItem(c, input.id))!, state_change, enqueued };
    });
  }

  async listStateChanges(id: WorkItemId): Promise<StateChange[]> {
    const rows = await this.rows(this.pool, "SELECT * FROM state_changes WHERE work_item_id = ? ORDER BY version", [id]);
    return rows.map(rowToStateChange);
  }

  // Runs

  async claimRun(input: ClaimInput): Promise<Run | null> {
    if (input.kinds.length === 0) return null;
    return this.tx(async (c) => {
      const [next] = await this.rows(
        c,
        `SELECT id FROM runs WHERE status = 'queued' AND kind IN (?) ORDER BY created_at, seq LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [input.kinds],
      );
      if (!next) return null;
      const now = this.now();
      const r = await this.exec(
        c,
        `UPDATE runs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_token = lease_token + 1,
           lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [input.worker_id, this.after(input.lease_ms), now, next.id as string],
      );
      return r.affectedRows === 1 ? this.selectRun(c, next.id as RunId) : null;
    });
  }

  async heartbeat(runId: RunId, token: number, lease_ms: number): Promise<LeaseResult> {
    return this.tx(async (c) => {
      const now = this.now();
      const r = await this.exec(
        c,
        `UPDATE runs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`,
        [this.after(lease_ms), now, runId, token, now],
      );
      return r.affectedRows === 1 ? { ok: true, run: (await this.selectRun(c, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async completeRun(runId: RunId, token: number, outcome: RunOutcome): Promise<LeaseResult> {
    return this.tx(async (c) => {
      const now = this.now();
      const r = await this.exec(
        c,
        `UPDATE runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`,
        [outcome.status, JSON.stringify(outcome), now, runId, token, now],
      );
      return r.affectedRows === 1 ? { ok: true, run: (await this.selectRun(c, runId))! } : { ok: false, reason: "lease_lost" };
    });
  }

  async listUnacknowledgedRuns(limit: number): Promise<Run[]> {
    const rows = await this.rows(
      this.pool,
      `SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND acknowledged_at IS NULL
       ORDER BY updated_at, seq LIMIT ?`,
      [limit],
    );
    return rows.map(rowToRun);
  }

  async expireLeases(max_attempts: number): Promise<RunId[]> {
    return this.tx(async (c) => {
      const now = this.now();
      // SKIP LOCKED: a run another reaper (or its worker's heartbeat) holds right now is left for the next tick.
      const expired = await this.rows(
        c,
        "SELECT id, attempt FROM runs WHERE status = 'running' AND lease_expires_at <= ? FOR UPDATE SKIP LOCKED",
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
          await this.exec(
            c,
            `UPDATE runs SET status = 'failed', outcome = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
            [JSON.stringify(failed), now, run.id as string],
          );
        } else {
          await this.exec(
            c,
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
    return this.selectRun(this.pool, id);
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    const rows = await this.rows(this.pool, "SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at, seq", [id]);
    return rows.map(rowToRun);
  }

  // Handoffs

  async appendHandoff(
    input: Omit<Handoff, "id" | "at">,
    token: number,
  ): Promise<{ ok: true; handoff: Handoff } | { ok: false; reason: "lease_lost" }> {
    return this.tx(async (c) => {
      const now = this.now();
      // FOR SHARE: the lease can't be completed or expired under us until this commits.
      const [holds] = await this.rows(
        c,
        `SELECT 1 FROM runs WHERE id = ? AND work_item_id = ? AND status = 'running' AND lease_token = ?
           AND lease_expires_at > ? FOR SHARE`,
        [input.run_id, input.work_item_id, token, now],
      );
      if (!holds) return { ok: false, reason: "lease_lost" };
      try {
        await this.exec(
          c,
          `INSERT INTO handoffs (id, run_id, work_item_id, commit_sha, worked_on, next_steps, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [newId("ho"), input.run_id, input.work_item_id, input.commit_sha, input.worked_on, input.next_steps, now],
        );
      } catch (err) {
        if (errno(err) !== ER_DUP_ENTRY) throw err;
      }
      const [row] = await this.rows(c, "SELECT * FROM handoffs WHERE run_id = ? AND commit_sha = ?", [
        input.run_id,
        input.commit_sha,
      ]);
      return { ok: true, handoff: rowToHandoff(row!) };
    });
  }

  async listHandoffs(id: WorkItemId): Promise<Handoff[]> {
    const rows = await this.rows(this.pool, "SELECT * FROM handoffs WHERE work_item_id = ? ORDER BY at, seq", [id]);
    return rows.map(rowToHandoff);
  }

  // Cursors

  async getCursor(name: string): Promise<string | null> {
    const [row] = await this.rows(this.pool, "SELECT value FROM cursors WHERE name = ?", [name]);
    return (row?.value as string | undefined) ?? null;
  }

  async advanceCursor(name: string, expected: string | null, next: string): Promise<boolean> {
    return this.tx(async (c) => {
      if (expected !== null) {
        const r = await this.exec(c, "UPDATE cursors SET value = ? WHERE name = ? AND value = ?", [next, name, expected]);
        return r.affectedRows === 1;
      }
      try {
        await this.exec(c, "INSERT INTO cursors (name, value) VALUES (?, ?)", [name, next]);
        return true;
      } catch (err) {
        if (errno(err) !== ER_DUP_ENTRY) throw err;
        return false;
      }
    });
  }

  // Internals

  private async tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.getConnection();
      try {
        await c.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await c.query("START TRANSACTION");
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        const code = errno(err);
        if (attempt < TX_ATTEMPTS && (code === ER_LOCK_DEADLOCK || code === ER_LOCK_WAIT_TIMEOUT)) continue;
        throw err;
      } finally {
        c.release();
      }
    }
  }

  private async rows(db: Db, sql: string, params: Param[]): Promise<RowDataPacket[]> {
    const [rows] = await db.query<RowDataPacket[]>(sql, params);
    return rows;
  }

  private async exec(db: Db, sql: string, params: Param[]): Promise<ResultSetHeader> {
    const [result] = await db.query<ResultSetHeader>(sql, params);
    return result;
  }

  private now(): Timestamp {
    return this.clock.now().toISOString() as Timestamp;
  }

  private after(ms: number): Timestamp {
    return new Date(this.clock.now().getTime() + ms).toISOString() as Timestamp;
  }

  private async selectItem(db: Db, id: WorkItemId, forUpdate = false): Promise<WorkItem | null> {
    const [row] = await this.rows(db, `SELECT * FROM work_items WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`, [id]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectItemBySource(db: Db, type: SourceType, sourceId: string): Promise<WorkItem | null> {
    const [row] = await this.rows(db, "SELECT * FROM work_items WHERE source_type = ? AND source_id = ?", [type, sourceId]);
    return row ? rowToWorkItem(row) : null;
  }

  private async selectRun(db: Db, id: RunId): Promise<Run | null> {
    const [row] = await this.rows(db, "SELECT * FROM runs WHERE id = ?", [id]);
    return row ? rowToRun(row) : null;
  }

  /** Returns the new run, or null if the idempotency key already existed. */
  private async insertRun(c: PoolConnection, input: NewRun): Promise<Run | null> {
    const id = newId("run") as RunId;
    const now = this.now();
    try {
      await this.exec(
        c,
        `INSERT INTO runs (id, work_item_id, kind, idempotency_key, status, attempt, lease_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?)`,
        [id, input.work_item_id, input.kind, input.idempotency_key, now, now],
      );
    } catch (err) {
      if (errno(err) !== ER_DUP_ENTRY) throw err;
      return null;
    }
    return this.selectRun(c, id);
  }

  private async insertStateChange(
    c: PoolConnection,
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
    await this.exec(
      c,
      "INSERT INTO state_changes (id, work_item_id, version, at, actor, reason, changes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [change.id, workItemId, version, change.at, JSON.stringify(actor), reason, JSON.stringify(changes)],
    );
    return change;
  }
}

function errno(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "errno" in err ? (err as { errno: number }).errno : undefined;
}
