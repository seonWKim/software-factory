// The MergeQueue snapshots (RFC 0015 §8; M8): `controller_merge_queues` (one row per project and base branch) and
// `controller_merge_queue_entries` (queue order by `seq`). Every state change is a conditional update on the state
// it leaves and bumps `version`, so two replicas deciding on one entry commit once; the loser reads false.

import { createHash } from "node:crypto";
import { insertOrSkip } from "../../../bus/index.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { LIVE_ENTRY_STATES, type MergeQueueEntryState } from "../merge-queue-entry/merge-queue-entry.actor.js";
import type { MergeQueueState } from "./merge-queue.actor.js";

export interface MergeQueue {
  readonly queue_id: string;
  readonly project_id: string;
  readonly base_ref: string;
  readonly state: MergeQueueState;
  readonly version: number;
  /** When its state last changed (ISO): a `merging` queue older than a lease is taken over. */
  readonly updated_at: string;
}

export interface MergeQueueEntry {
  readonly seq: number;
  readonly entry_id: string;
  readonly queue_id: string;
  readonly work_item_id: string;
  readonly state: MergeQueueEntryState;
  /** The approver's user id, or `system:auto` for auto mode's merge. */
  readonly entered_by: string;
  /** Keys the replies about this entry (the command's key). */
  readonly merge_key: string;
  /** Goes on the merge's state change (auto mode's mode change). */
  readonly detail: Record<string, unknown>;
  /** The idempotency key of its merge-check run (checking), or of the last one. */
  readonly run_key: string | null;
  /** The base its last green check ran on: the landing moves the base only from there. */
  readonly base_sha: string | null;
  /** Each branch's head its last green check merged (branch → sha): the landing merges only those commits. */
  readonly heads: Readonly<Record<string, string>>;
  /** Why it was removed (removed). */
  readonly reason: string | null;
  readonly version: number;
}

export interface NewEntry {
  readonly entry_id: string;
  readonly queue_id: string;
  readonly work_item_id: string;
  readonly entered_by: string;
  readonly merge_key: string;
  readonly detail: Record<string, unknown>;
}

/** The fields a move sets (null clears one; one left out keeps its value). */
export interface EntryFields {
  readonly run_key?: string | null;
  readonly base_sha?: string | null;
  readonly heads?: Readonly<Record<string, string>>;
  readonly reason?: string | null;
}

const LIVE = LIVE_ENTRY_STATES.map(() => "?").join(", ");

function queueOf(r: Row): MergeQueue {
  return {
    queue_id: String(r.queue_id), project_id: String(r.project_id), base_ref: String(r.base_ref),
    state: String(r.state) as MergeQueueState, version: Number(r.version), updated_at: String(r.updated_at),
  };
}

function entryOf(r: Row): MergeQueueEntry {
  return {
    seq: Number(r.seq), entry_id: String(r.entry_id), queue_id: String(r.queue_id), work_item_id: String(r.work_item_id),
    state: String(r.state) as MergeQueueEntryState, entered_by: String(r.entered_by), merge_key: String(r.merge_key),
    detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
    run_key: r.run_key == null ? null : String(r.run_key), base_sha: r.base_sha == null ? null : String(r.base_sha),
    heads: r.heads == null ? {} : (JSON.parse(String(r.heads)) as Record<string, string>),
    reason: r.reason == null ? null : String(r.reason), version: Number(r.version),
  };
}

/**
 * The queue of `project` and `base_ref`: a hash of both, so every replica finds the same row and a long project key
 * plus base ref still fits MySQL's key length (the row keeps both in their own columns).
 */
export function queueId(project: string, base_ref: string): string {
  return `mq_${createHash("sha256").update(`${project}\n${base_ref}`).digest("hex").slice(0, 32)}`;
}

export class MergeQueueStore {
  constructor(
    private readonly db: SqlDriver,
    /** The decision's time, ISO (the controller's tick). */
    private readonly now: () => string,
  ) {}

  /** The queue of `project` and `base_ref`, made idle on first use. */
  async queue(project: string, base_ref: string): Promise<MergeQueue> {
    const id = queueId(project, base_ref);
    await insertOrSkip(this.db, "controller_merge_queues (queue_id, project_id, base_ref, state, version, updated_at) VALUES (?, ?, ?, 'idle', 1, ?)", [
      id, project, base_ref, this.now(),
    ]);
    return queueOf((await this.db.all("SELECT * FROM controller_merge_queues WHERE queue_id = ?", [id]))[0]!);
  }

  /**
   * Moves the queue from `from` to `to`; false when another decision moved it first. With `version`, only from that
   * version: the same state again then takes the queue over (a stale `merging`), bumping its version and time.
   */
  async setQueue(queue_id: string, from: MergeQueueState, to: MergeQueueState, version?: number): Promise<boolean> {
    if (from === to && version === undefined) return true;
    const n = await this.db.run(
      `UPDATE controller_merge_queues SET state = ?, version = version + 1, updated_at = ? WHERE queue_id = ? AND state = ?${version === undefined ? "" : " AND version = ?"}`,
      [to, this.now(), queue_id, from, ...(version === undefined ? [] : [version])],
    );
    return n > 0;
  }

  /**
   * Puts a change at the end of its queue. The same `entry_id` again (the same command delivered twice) returns the
   * entry it made; an item with a live entry under another id is refused.
   */
  async enter(e: NewEntry): Promise<{ entry: MergeQueueEntry; created: boolean } | { refused: MergeQueueEntry }> {
    return this.db.transaction(async (tx) => {
      // The queue row first: entries of one queue are made one at a time (MySQL's gap locks let two inserts through).
      await tx.all(`SELECT queue_id FROM controller_merge_queues WHERE queue_id = ?${this.db.dialect.forUpdate}`, [e.queue_id]);
      const same = await tx.all(`SELECT * FROM controller_merge_queue_entries WHERE entry_id = ?${this.db.dialect.forUpdate}`, [e.entry_id]);
      if (same[0]) return { entry: entryOf(same[0]), created: false };
      const live = await tx.all(
        `SELECT * FROM controller_merge_queue_entries WHERE work_item_id = ? AND state IN (${LIVE})${this.db.dialect.forUpdate}`,
        [e.work_item_id, ...LIVE_ENTRY_STATES],
      );
      if (live[0]) return { refused: entryOf(live[0]) };
      const at = this.now();
      await tx.run(
        `INSERT INTO controller_merge_queue_entries (entry_id, queue_id, work_item_id, state, entered_by, merge_key, detail, version, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, 1, ?, ?)`,
        [e.entry_id, e.queue_id, e.work_item_id, e.entered_by, e.merge_key, JSON.stringify(e.detail), at, at],
      );
      const row = (await tx.all("SELECT * FROM controller_merge_queue_entries WHERE entry_id = ?", [e.entry_id]))[0]!;
      return { entry: entryOf(row), created: true };
    });
  }

  /** The queue's live entries (queued, checking, passed, merging), in queue order. */
  async live(queue_id: string): Promise<MergeQueueEntry[]> {
    const rows = await this.db.all(
      `SELECT * FROM controller_merge_queue_entries WHERE queue_id = ? AND state IN (${LIVE}) ORDER BY seq`,
      [queue_id, ...LIVE_ENTRY_STATES],
    );
    return rows.map(entryOf);
  }

  async entry(entry_id: string): Promise<MergeQueueEntry | null> {
    const r = (await this.db.all("SELECT * FROM controller_merge_queue_entries WHERE entry_id = ?", [entry_id]))[0];
    return r ? entryOf(r) : null;
  }

  /** The entry whose merge-check run has the idempotency key `run_key`, if any (indexed). */
  async byRun(run_key: string): Promise<MergeQueueEntry | null> {
    const r = (await this.db.all("SELECT * FROM controller_merge_queue_entries WHERE run_key = ? ORDER BY seq DESC LIMIT 1", [run_key]))[0];
    return r ? entryOf(r) : null;
  }

  /** Every entry of the item, oldest first (the status page and tests). */
  async ofItem(work_item_id: string): Promise<MergeQueueEntry[]> {
    const rows = await this.db.all("SELECT * FROM controller_merge_queue_entries WHERE work_item_id = ? ORDER BY seq", [work_item_id]);
    return rows.map(entryOf);
  }

  /**
   * Moves the entry from `from` (one state, or any of several) to `to` with `set`; false when another decision
   * moved it first. `run_key` also requires that check run, so a stale run's result or timer never moves an entry
   * that was rebuilt and is checked again.
   */
  async move(
    entry_id: string,
    from: MergeQueueEntryState | readonly MergeQueueEntryState[],
    to: MergeQueueEntryState,
    set: EntryFields = {},
    run_key?: string,
  ): Promise<boolean> {
    const cols = Object.keys(set) as (keyof EntryFields)[];
    const states: readonly MergeQueueEntryState[] = typeof from === "string" ? [from] : from;
    const value = (c: keyof EntryFields) => (c === "heads" ? JSON.stringify(set.heads) : ((set[c] as string | null | undefined) ?? null));
    const n = await this.db.run(
      `UPDATE controller_merge_queue_entries SET state = ?, ${cols.map((c) => `${c} = ?, `).join("")}version = version + 1, updated_at = ?
       WHERE entry_id = ? AND state IN (${states.map(() => "?").join(", ")})${run_key === undefined ? "" : " AND run_key = ?"}`,
      [to, ...cols.map(value), this.now(), entry_id, ...states, ...(run_key === undefined ? [] : [run_key])],
    );
    return n > 0;
  }
}
