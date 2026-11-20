// Session reservations (design 05-interactive-sessions, 2026-11-21): a waiting `session start --spec <file> --wait`
// holds its NEW item, so no claim takes the item's queued triage run while the session waits for its files. One
// `worker_claim_pauses` row per reservation: named `session_reserved:<item id>:<owner>`, `resume_at` its expiry. It is
// a claim pause of one item's runs, so it needs no schema step. Every read and write runs under the claim lock, and an
// expired row is deleted where it is met. SqlRunOutputStore extends SqlReservationStore, so these methods add no line
// to sql-factory-store.ts's budget.

import type { ReserveResult, SessionReservation, SessionReservationStore } from "../../../core/session.js";
import type { Timestamp, WorkItemId } from "../../../core/types.js";
import type { SqlDriver, SqlExecutor } from "../../../state/index.js";
import { SqlProjectStore } from "./projects.js";

/** The one row in `claim_locks` (migration 7). */
const CLAIM_LOCK = "claim";
const PREFIX = "session_reserved:";

/**
 * Takes the claim lock row first. Claimers then run their checks one at a time, so two of them can never both see
 * "nothing of this item is running" and claim two runs of one item: only a claim moves a run to 'running', so what is
 * read under the lock stays true until the transaction commits. (SQLite: BEGIN IMMEDIATE already serializes; the select is a no-op.)
 */
export async function claimLock(tx: SqlExecutor): Promise<void> {
  await tx.all("SELECT name FROM worker_claim_locks WHERE name = ?", [CLAIM_LOCK]);
}

/** Every reservation in effect at `now`, by item id, after deleting the expired ones (`item`: only that item's). Under the claim lock. */
export async function liveReservations(tx: SqlExecutor, now: Timestamp, item?: WorkItemId): Promise<Map<string, SessionReservation>> {
  const prefix = item === undefined ? PREFIX : `${PREFIX}${item}:`;
  const match = "substr(name, 1, ?) = ?";
  await tx.run(`DELETE FROM worker_claim_pauses WHERE ${match} AND resume_at <= ?`, [prefix.length, prefix, now]);
  const live = new Map<string, SessionReservation>();
  for (const r of await tx.all(`SELECT name, resume_at FROM worker_claim_pauses WHERE ${match} ORDER BY name`, [prefix.length, prefix])) {
    const rest = String(r.name).slice(PREFIX.length);
    const at = rest.indexOf(":");
    const id = rest.slice(0, at);
    live.set(id, { work_item_id: id as WorkItemId, owner: rest.slice(at + 1), expires_at: r.resume_at as Timestamp });
  }
  return live;
}

/** The item's reservation in effect, or null; deletes an expired one. Under the claim lock. */
export async function reservationOf(tx: SqlExecutor, id: WorkItemId, now: Timestamp): Promise<SessionReservation | null> {
  return (await liveReservations(tx, now, id)).get(id) ?? null;
}

/** Ends every reservation of the item (a started session, design 05-interactive-sessions). */
export async function endReservations(tx: SqlExecutor, id: WorkItemId): Promise<void> {
  const prefix = `${PREFIX}${id}:`;
  await tx.run("DELETE FROM worker_claim_pauses WHERE substr(name, 1, ?) = ?", [prefix.length, prefix]);
}

/** SessionReservationStore over a SqlDriver; `reserveStamp` is the store's injected Clock's time. */
export class SqlReservationStore extends SqlProjectStore implements SessionReservationStore {
  constructor(db: SqlDriver, private readonly reserveStamp: () => Timestamp) {
    super(db, reserveStamp);
  }

  async reserveItem(input: { id: WorkItemId; owner: string; ttl_ms: number }): Promise<ReserveResult> {
    return this.db.transaction(async (tx): Promise<ReserveResult> => {
      await claimLock(tx);
      const now = this.reserveStamp();
      const [item] = await tx.all("SELECT stage, blocked_on FROM controller_work_items WHERE id = ?", [input.id]);
      if (!item) return { ok: false, reason: "not_found" };
      if (item.stage !== "NEW" || item.blocked_on !== "none") return { ok: false, reason: "not_new" };
      const held = await reservationOf(tx, input.id, now);
      if (held) return held.owner === input.owner ? { ok: true, reservation: held } : { ok: false, reason: "reserved", reservation: held };
      const expires_at = new Date(Date.parse(now) + input.ttl_ms).toISOString() as Timestamp;
      await tx.run("INSERT INTO worker_claim_pauses (name, resume_at) VALUES (?, ?)", [`${PREFIX}${input.id}:${input.owner}`, expires_at]);
      return { ok: true, reservation: { work_item_id: input.id, owner: input.owner, expires_at } };
    });
  }

  async getReservation(id: WorkItemId): Promise<SessionReservation | null> {
    return this.db.transaction(async (tx) => {
      await claimLock(tx);
      return reservationOf(tx, id, this.reserveStamp());
    });
  }

  async releaseReservation(id: WorkItemId, owner: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await claimLock(tx);
      const held = await reservationOf(tx, id, this.reserveStamp());
      if (held?.owner !== owner) return false;
      await tx.run("DELETE FROM worker_claim_pauses WHERE name = ?", [`${PREFIX}${id}:${owner}`]);
      return true;
    });
  }
}
