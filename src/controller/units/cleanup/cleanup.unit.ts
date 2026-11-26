// The cleanup of closed items' leftovers (design 08-cleanup). The controller role ticks `cleanupStep` each poll
// interval and hands it the cleanup (built by compose from src/cleanup/, so this unit imports none of it) and the
// store's lease and cursor calls: the unit reaches no store of its own (unit-purity). Each step runs the close
// callback (items whose keep_hours just passed), then the daily sweep at most once per UTC day under the store lease
// `cleanup:<host>`, with the day it finished in the store cursor of the same name, as the retention unit does.
// A pass that removed or failed on a resource writes one `cleanup` Activity row (design 08-schedules-actions) after
// it: the removals are on disk, outside any store transaction; each already wrote its item's history line.

import { activityOf, logRef } from "../../background-jobs.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The lease and the day mark's prefix; each host has its own, as each host sweeps the folders it made. */
export const CLEANUP = "cleanup";
/** The lease owner of a process with no replica_id (a solo process): as the retention lease's. */
const OWNER = "controller";

/** What the step calls on the store (the role's, handed in): the lease and the day mark. */
export type CleanupLeaseStore = Pick<Ctx["k"]["d"]["store"], "acquireSyncLease" | "releaseSyncLease" | "getCursor" | "advanceCursor" | "recordActivity">;

/** What a pass reports (src/cleanup's PassResult), as far as its Activity row reads it. */
type Pass = { removed: { resource: { label: string } }[]; failed: { resource: { label: string }; error: string }[] };
const isPass = (v: unknown): v is Pass => Array.isArray((v as Pass | null)?.removed) && Array.isArray((v as Pass | null)?.failed);

/** The pass's `cleanup` Activity row, when it removed or failed on any resource; nothing otherwise. */
async function recordPass(store: CleanupLeaseStore, host: string, pass: "close" | "sweep", result: unknown): Promise<void> {
  if (!isPass(result) || result.removed.length + result.failed.length === 0) return;
  const removed = result.removed.map((r) => r.resource.label), failed = result.failed.map((f) => `${f.resource.label} (${f.error})`);
  const why = pass === "close" ? "their items closed more than cleanup.keep_hours ago" : "the daily sweep found them unused past cleanup.keep_hours";
  const parts = [removed.length ? `removed ${removed.join(", ")}` : "", failed.length ? `failed on ${failed.join(", ")}` : ""].filter(Boolean);
  await store.recordActivity(activityOf("cleanup", {
    subject: `${CLEANUP}:${host}`, outcome: failed.length === 0 ? "removed" : removed.length === 0 ? "failed" : "partial",
    reason: `${why}: ${parts.join("; ")}`, ref: logRef("controller", `cleanup ${pass}`),
  }));
}

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
    await recordPass(store, cleanup.host, "close", await cleanup.closeStep());
    const k = this.c.k;
    const day = new Date(k.nowMs()).toISOString().slice(0, 10); // the UTC day
    if (this.doneDay === day) return;
    const name = `${CLEANUP}:${cleanup.host}`;
    const lease = await store.acquireSyncLease(name, k.d.replica_id ?? OWNER, k.cfg.lease_ms);
    if (!lease.ok) return;
    try {
      const mark = await store.getCursor(name);
      if (mark === null || mark < day) {
        await recordPass(store, cleanup.host, "sweep", await cleanup.sweep());
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
