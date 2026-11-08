// Requeues runs whose worker stopped renewing its lease.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { retryDelayMs } from "../../../core/policy.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Requeues runs whose worker stopped renewing its lease. */
export class ReaperUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * Reaper grace after this process's own sleep. Per process, not shared between replicas, and not stored:
   * it only stops this reaper from reaping workers on the same host that slept with it before they can
   * renew. Losing it (restart) just means no grace for one tick. A reaper on a host that did not sleep
   * gets no grace and can still requeue a sleeping worker's run once lease_ms passes (design §5).
   */
  lastReaperTick: number | null = null;

  reaperGraceUntil = -Infinity;

  async reaperStep(): Promise<void> {
    const now = this.c.k.d.clock.now().getTime();
    const previous = this.lastReaperTick;
    this.lastReaperTick = now;
    if (previous !== null && now - previous > this.c.k.cfg.lease_ms) {
      // This process slept (or stalled) longer than a lease: every lease looks expired, including those of
      // workers that slept with us and are about to renew. Give them one heartbeat_ms first.
      this.reaperGraceUntil = now + this.c.k.cfg.heartbeat_ms;
      this.c.k.d.log.warn("reaper woke after a gap; grace before expiring leases", { gap_ms: now - previous });
    }
    if (now < this.reaperGraceUntil) return;
    const { retry_base_ms, retry_max_ms } = this.c.k.cfg;
    // One repository per factory today, so the configured repo's limit applies to every lease.
    const { max_attempts } = this.c.k.settings(this.c.k.project());
    // An expired lease waits out the same backoff as any retry before another claim (design §5 Restarts).
    // Each attempt the store's conditional update cut off gets its end line (issue #210): the run's last
    // heartbeat is its end. The reaper sees only an expired lease, so the reason is always lease_expired.
    const ids = await this.c.k.d.store.expireLeases(
      max_attempts,
      (attempt) => retryDelayMs(attempt, retry_base_ms, retry_max_ms),
      (a) =>
        this.c.k.d.log.warn("run abandoned", {
          run_id: a.run_id,
          work_item_id: a.work_item_id,
          attempt: a.attempt,
          status: "abandoned",
          reason: "lease_expired",
          started_at: a.started_at,
          ended_at: a.ended_at,
          duration_ms: a.duration_ms,
        }),
    );
    for (const id of ids) this.c.k.d.log.warn("lease expired", { run_id: id });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "reaper": ReaperUnit;
  }
}

export default controllerUnit({
  name: "reaper",
  create: (c: Ctx) => new ReaperUnit(c),
  steps: [
    { name: "reaper", every: "tick", order: 100, run: (u) => u.reaperStep() },
  ],
});
