// The daily retention pass (design 08-retention): delivered outbox rows, handled commands and old records (claim
// decisions, host sleeps, alerts) deleted in bounded batches, at most once per UTC day, under the store lease
// `retention`, with the day it finished in the store cursor `retention`. The controller role's `retention` tick runs
// it and hands it the store's retention calls: the unit reaches no store of its own (unit-purity).

import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The store lease and the store cursor (the day mark) of the pass. */
export const RETENTION = "retention";
/** Rows deleted per table per store call. */
export const RETENTION_BATCH = 500;
/** Full batches one class runs per pass at most; past it the day stays unmarked and the next tick goes on. */
const MAX_ROUNDS = 200;
const DAY_MS = 86_400_000;
/** The lease owner of a process with no replica_id (a solo process): as the sync lease's. */
const OWNER = "controller";

/** What the pass calls on the store (the role's, handed in): the lease, the day mark and the three classes. */
export type RetentionStore = Pick<
  Ctx["k"]["d"]["store"],
  "acquireSyncLease" | "releaseSyncLease" | "getCursor" | "advanceCursor" | "pruneDeliveredOutbox" | "pruneHandledCommands" | "pruneRecords"
>;

/** The daily retention pass. */
export class RetentionUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The UTC day this process finished or saw marked: a cache only, so a tick after it costs no store call. The
   * cursor `retention` is the shared mark; a restart or another replica reads it again.
   */
  doneDay: string | null = null;

  /**
   * Runs today's pass unless it is marked done: takes the lease (a replica that cannot does nothing), reads the
   * mark, prunes each class whose days are above 0, advances the mark (conditional) and releases the lease. Safe
   * to run twice: every delete is conditional, so a second pass on the same rows deletes nothing.
   */
  async retentionStep(store: RetentionStore): Promise<void> {
    const k = this.c.k;
    const day = new Date(k.nowMs()).toISOString().slice(0, 10); // the UTC day
    if (this.doneDay === day) return;
    const lease = await store.acquireSyncLease(RETENTION, k.d.replica_id ?? OWNER, k.cfg.lease_ms);
    if (!lease.ok) return;
    try {
      const mark = await store.getCursor(RETENTION);
      if (mark === null || mark < day) {
        if (!(await this.prune(store))) return;
        // A false advance means another holder marked the day first (a lease that expired mid-pass): done either way.
        await store.advanceCursor(RETENTION, mark, day);
      }
      this.doneDay = day;
    } finally {
      await store.releaseSyncLease(RETENTION, lease.lease.token);
    }
  }

  /** Each class with days above 0, batch after batch while one comes back full. False when a class hit MAX_ROUNDS. */
  private async prune(store: RetentionStore): Promise<boolean> {
    const days = this.c.k.cfg.retention;
    const classes: [number, (ms: number, limit: number) => Promise<Record<string, number>>][] = [
      [days.outbox_days, (ms, limit) => store.pruneDeliveredOutbox(ms, limit)],
      [days.commands_days, (ms, limit) => store.pruneHandledCommands(ms, limit)],
      [days.records_days, (ms, limit) => store.pruneRecords(ms, limit)],
    ];
    const deleted: Record<string, number> = {};
    let complete = true;
    for (const [d, prune] of classes) {
      if (d === 0) continue;
      let full = true;
      for (let round = 0; full && round < MAX_ROUNDS; round++) {
        const counts = await prune(d * DAY_MS, RETENTION_BATCH);
        for (const [table, n] of Object.entries(counts)) deleted[table] = (deleted[table] ?? 0) + n;
        full = Object.values(counts).some((n) => n >= RETENTION_BATCH);
      }
      if (full) complete = false;
    }
    if (Object.values(deleted).some((n) => n > 0)) this.c.k.d.log.info("retention pass", { ...deleted, complete });
    return complete;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "retention": RetentionUnit;
  }
}

export default controllerUnit({
  name: "retention",
  create: (c: Ctx) => new RetentionUnit(c),
});
