// The cleanup of closed items' leftovers (design 08-cleanup). The controller role ticks `cleanupStep` each poll
// interval and hands it the cleanup (built by compose from src/cleanup/, so this unit imports none of it) and the
// store's lease and cursor calls: the unit reaches no store of its own (unit-purity). Each step runs the close
// callback (items whose keep_hours just passed), then the daily sweep at most once per UTC day under the store lease
// `cleanup:<host>`, with the day it finished in the store cursor of the same name, as the retention unit does.

import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The lease and the day mark's prefix; each host has its own, as each host sweeps the folders it made. */
export const CLEANUP = "cleanup";
/** The lease owner of a process with no replica_id (a solo process): as the retention lease's. */
const OWNER = "controller";

/** What the step calls on the store (the role's, handed in): the lease and the day mark. */
export type CleanupLeaseStore = Pick<Ctx["k"]["d"]["store"], "acquireSyncLease" | "releaseSyncLease" | "getCursor" | "advanceCursor">;

/** The cleanup as the unit uses it (src/cleanup's Cleaner). */
export interface CleanupPort {
  readonly host: string;
  enabled(): boolean;
  closeStep(): Promise<unknown>;
  sweep(): Promise<unknown>;
}

export class CleanupUnit {
  constructor(private readonly c: Ctx) {}

  /** The UTC day this process finished or saw marked: a cache only; the cursor is the shared mark. */
  doneDay: string | null = null;

  /** The close callback, then today's sweep unless marked. Off (`cleanup.enabled` false): nothing, no store call. */
  async cleanupStep(store: CleanupLeaseStore, cleanup: CleanupPort): Promise<void> {
    if (!cleanup.enabled()) return;
    await cleanup.closeStep();
    const k = this.c.k;
    const day = new Date(k.nowMs()).toISOString().slice(0, 10); // the UTC day
    if (this.doneDay === day) return;
    const name = `${CLEANUP}:${cleanup.host}`;
    const lease = await store.acquireSyncLease(name, k.d.replica_id ?? OWNER, k.cfg.lease_ms);
    if (!lease.ok) return;
    try {
      const mark = await store.getCursor(name);
      if (mark === null || mark < day) {
        await cleanup.sweep();
        // A false advance means another holder marked the day first: done either way.
        await store.advanceCursor(name, mark, day);
      }
      this.doneDay = day;
    } finally {
      await store.releaseSyncLease(name, lease.lease.token);
    }
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "cleanup": CleanupUnit;
  }
}

export default controllerUnit({
  name: "cleanup",
  create: (c: Ctx) => new CleanupUnit(c),
});
