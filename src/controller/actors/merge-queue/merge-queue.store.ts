// The MergeQueue snapshots (RFC 0015 §8; M8): `controller_merge_queues` (one row per project and base branch) and
// `controller_merge_queue_entries` (queue order by `seq`). Every state change is a conditional update on the state
// it leaves and bumps `version`, so two replicas deciding on one entry commit once; the loser reads false.

import type { Row, SqlDriver } from "../../../state/index.js";
import { LIVE_ENTRY_STATES, type MergeQueueEntryState } from "../merge-queue-entry/merge-queue-entry.actor.js";
import type { MergeQueueState } from "./merge-queue.actor.js";

export interface MergeQueue {
  readonly queue_id: string;
  readonly project_id: string;
  readonly base_ref: string;
  readonly state: MergeQueueState;
  readonly version: number;
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

const LIVE = LIVE_ENTRY_STATES.map(() => "?").join(", ");

function queueOf(r: Row): MergeQueue {
  return {
    queue_id: String(r.queue_id), project_id: String(r.project_id), base_ref: String(r.base_ref),
    state: String(r.state) as MergeQueueState, version: Number(r.version),
  };
}

function entryOf(r: Row): MergeQueueEntry {
  return {
    seq: Number(r.seq), entry_id: String(r.entry_id), queue_id: String(r.queue_id), work_item_id: String(r.work_item_id),
    state: String(r.state) as MergeQueueEntryState, entered_by: String(r.entered_by), merge_key: String(r.merge_key),
    detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
    run_key: r.run_key == null ? null : String(r.run_key), base_sha: r.base_sha == null ? null : String(r.base_sha),
    reason: r.reason == null ? null : String(r.reason), version: Number(r.version),
  };
}

/** The queue of `project` and `base_ref`: its id names both, so every replica finds the same row. */
export function queueId(project: string, base_ref: string): string {
  return `mq:${project}:${base_ref}`;
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
    const insert = this.db.dialect.name === "mysql" ? "INSERT IGNORE INTO" : "INSERT OR IGNORE INTO";
    await this.db.run(
      `${insert} controller_merge_queues (queue_id, project_id, base_ref, state, version, updated_at) VALUES (?, ?, ?, 'idle', 1, ?)`,
      [id, project, base_ref, this.now()],
    );
    return queueOf((await this.db.all("SELECT * FROM controller_merge_queues WHERE queue_id = ?", [id]))[0]!);
  }

  /** Moves the queue from `from` to `to`; false when another decision moved it first. */
  async setQueue(queue_id: string, from: MergeQueueState, to: MergeQueueState): Promise<boolean> {
    if (from === to) return true;
    const n = await this.db.run(
      "UPDATE controller_merge_queues SET state = ?, version = version + 1, updated_at = ? WHERE queue_id = ? AND state = ?",
      [to, this.now(), queue_id, from],
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
      const same =await tx.all(`SELECT * FROM controller_merge_queue_entries WHERE entry_id = ?${this.db.dialect.forUpdate}`, [e.entry_id]);
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

  /** The queue's live entries (queued, checking, merging), in queue order. */
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

  /** The entry whose merge-check run has the idempotency key `run_key`, if any. */
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
   * Moves the entry from `from` to `to` with the given fields (null clears one); false when another decision moved
   * it first.
   */
  async move(
    entry_id: string,
    from: MergeQueueEntryState,
    to: MergeQueueEntryState,
    set: { run_key?: string | null; base_sha?: string | null; reason?: string | null } = {},
  ): Promise<boolean> {
    const cols = Object.keys(set) as (keyof typeof set)[];
    const n = await this.db.run(
      `UPDATE controller_merge_queue_entries SET state = ?, ${cols.map((c) => `${c} = ?, `).join("")}version = version + 1, updated_at = ?
       WHERE entry_id = ? AND state = ?`,
      [to, ...cols.map((c) => set[c] ?? null), this.now(), entry_id, from],
    );
    return n > 0;
  }
}
