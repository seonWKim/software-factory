// Host test slots (phase 1 of 3 of local-28caa30d): the store methods of TestSlotStore over worker_test_slots
// (src/state/migrations/20261128T1000-state-test-slots), kept out of sql-factory-store.ts so that file stays within
// its line budget. Every take runs under the claim lock, so two takers never both see a free slot. Store data only.

import type { RunId } from "../../../core/types.js";
import type { TestSlotStore } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import { claimLock } from "./reservations.js";
import type { StoreTime } from "./store-steps.js";

/**
 * Under the claim lock: deletes the expired slots, then inserts the holder's slot only while the live count is
 * below the cap. A holder that already holds a live slot gets true and nothing is written (safe to run twice).
 */
export async function takeTestSlot(db: SqlDriver, time: StoreTime, s: Parameters<TestSlotStore["takeTestSlot"]>[0]): Promise<boolean> {
  return db.transaction(async (tx) => {
    await claimLock(tx);
    await tx.run("DELETE FROM worker_test_slots WHERE expires_at <= ?", [time.now()]);
    const live = await tx.all("SELECT holder FROM worker_test_slots");
    if (live.some((r) => r.holder === s.holder)) return true;
    if (live.length >= s.cap) return false;
    await tx.run("INSERT INTO worker_test_slots (holder, expires_at) VALUES (?, ?)", [s.holder, time.after(s.lease_ms)]);
    return true;
  });
}

/** Deletes the holder's own slot; false when it holds none (no other holder's row is touched). */
export async function releaseTestSlot(db: SqlDriver, holder: RunId): Promise<boolean> {
  return (await db.run("DELETE FROM worker_test_slots WHERE holder = ?", [holder])) > 0;
}
