// Host test slots (local-28caa30d): the store methods of TestSlotStore over worker_test_slots
// (src/state/migrations/20261128T1000-state-test-slots), kept out of sql-factory-store.ts so that file stays within
// its line budget. Every take runs under the claim lock, so two takers never both see a free slot. A run waiting
// for a slot is a row too, its holder `waiting:<run id>` (phase 2): it counts against no cap, expires with its lease,
// and goes with the run's take or release, so the display reads who holds and who waits (readTestSlots). Store data only.

import type { RunId } from "../../../core/types.js";
import type { FactoryStore, TestSlotStore } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import { claimLock } from "./reservations.js";
import { storeSqlOrNull } from "./store-sql.js";
import type { StoreTime } from "./store-steps.js";

/** The holder prefix of a waiting run's row: `waiting:<run id>`. */
export const WAITING_PREFIX = "waiting:";

const waitingRow = (holder: RunId): string => `${WAITING_PREFIX}${holder}`;

/**
 * Under the claim lock: deletes the expired slots, then inserts the holder's slot only while the live count of held
 * slots is below the cap (waiting rows count for none); a grant deletes the holder's waiting row. A holder that
 * already holds a live slot gets true and its own lease is extended to `lease_ms` from now, no second row (the
 * worker's heartbeat renewal); no other holder's row is touched. A full host returns false and writes nothing. Safe to run twice.
 */
export async function takeTestSlot(db: SqlDriver, time: StoreTime, s: Parameters<TestSlotStore["takeTestSlot"]>[0]): Promise<boolean> {
  return db.transaction(async (tx) => {
    await claimLock(tx);
    await tx.run("DELETE FROM worker_test_slots WHERE expires_at <= ?", [time.now()]);
    const live = (await tx.all("SELECT holder FROM worker_test_slots")).filter((r) => !String(r.holder).startsWith(WAITING_PREFIX));
    if (live.some((r) => r.holder === s.holder)) {
      await tx.run("UPDATE worker_test_slots SET expires_at = ? WHERE holder = ?", [time.after(s.lease_ms), s.holder]);
      return true;
    }
    if (live.length >= s.cap) return false;
    await tx.run("DELETE FROM worker_test_slots WHERE holder = ?", [waitingRow(s.holder)]);
    await tx.run("INSERT INTO worker_test_slots (holder, expires_at) VALUES (?, ?)", [s.holder, time.after(s.lease_ms)]);
    return true;
  });
}

/** Deletes the holder's own slot and its waiting row; false when it holds no slot (no other holder's row is touched). */
export async function releaseTestSlot(db: SqlDriver, holder: RunId): Promise<boolean> {
  await db.run("DELETE FROM worker_test_slots WHERE holder = ?", [waitingRow(holder)]);
  return (await db.run("DELETE FROM worker_test_slots WHERE holder = ?", [holder])) > 0;
}

/**
 * Records that `holder` waits for a slot: its waiting row, expiring `lease_ms` after `now`, so a waiter that died
 * disappears with the next take. Written on each poll of the wait; a run that holds a slot writes none. A store that
 * is not a SQL store records nothing.
 */
export async function recordTestSlotWait(store: TestSlotStore, now: Date, s: { holder: RunId; lease_ms: number }): Promise<void> {
  const db = storeSqlOrNull(store as FactoryStore); // reads only the store's driver mark
  if (!db) return;
  const expires = new Date(now.getTime() + s.lease_ms).toISOString();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM worker_test_slots WHERE holder = ?", [waitingRow(s.holder)]);
    await tx.run("INSERT INTO worker_test_slots (holder, expires_at) VALUES (?, ?)", [waitingRow(s.holder), expires]);
  });
}

/** The runs that hold a live slot and the runs that wait for one, each sorted by run ID: what the display reads. */
export async function readTestSlots(db: SqlDriver, now: string): Promise<{ held: RunId[]; waiting: RunId[] }> {
  const rows = (await db.all("SELECT holder FROM worker_test_slots WHERE expires_at > ? ORDER BY holder", [now])).map((r) => String(r.holder));
  return {
    held: rows.filter((h) => !h.startsWith(WAITING_PREFIX)) as RunId[],
    waiting: rows.filter((h) => h.startsWith(WAITING_PREFIX)).map((h) => h.slice(WAITING_PREFIX.length)) as RunId[],
  };
}
