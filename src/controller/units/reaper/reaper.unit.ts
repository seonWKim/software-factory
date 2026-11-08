// Requeues runs whose worker stopped renewing its lease. A pure step (RFC 0015 §6.2): it decides on the tick's time
// and the settings, and the router commits the lease expiry.

import { retryDelayMs } from "../../../core/policy.js";
import type { ControllerDecision, Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The settings a reaper tick decides on. */
interface ReaperSettings {
  lease_ms: number;
  heartbeat_ms: number;
  retry_base_ms: number;
  retry_max_ms: number;
  max_attempts: number;
}

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

  /** The settings in effect this tick. One repository per factory today, so the configured repo's limit applies to every lease. */
  settings(): ReaperSettings {
    const { lease_ms, heartbeat_ms, retry_base_ms, retry_max_ms } = this.c.k.cfg;
    const { max_attempts } = this.c.k.settings(this.c.k.project());
    return { lease_ms, heartbeat_ms, retry_base_ms, retry_max_ms, max_attempts };
  }

  /** The lease expiry at `now`, unless this process just woke from a sleep longer than a lease. */
  decide(s: ReaperSettings, now: number): ControllerDecision {
    const previous = this.lastReaperTick;
    this.lastReaperTick = now;
    const writes: ControllerDecision["writes"][number][] = [];
    if (previous !== null && now - previous > s.lease_ms) {
      // This process slept (or stalled) longer than a lease: every lease looks expired, including those of
      // workers that slept with us and are about to renew. Give them one heartbeat_ms first.
      this.reaperGraceUntil = now + s.heartbeat_ms;
      writes.push({ kind: "log", level: "warn", msg: "reaper woke after a gap; grace before expiring leases", fields: { gap_ms: now - previous } });
    }
    if (now < this.reaperGraceUntil) return { writes };
    // An expired lease waits out the same backoff as any retry before another claim (design §5 Restarts).
    const backoff_ms = (attempt: number) => retryDelayMs(attempt, s.retry_base_ms, s.retry_max_ms);
    writes.push({ kind: "expire_leases", max_attempts: s.max_attempts, backoff_ms });
    return { writes };
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
    {
      name: "reaper", every: "tick", order: 100,
      load: async (u) => u.settings(),
      decide: (u, s: ReaperSettings, t) => u.decide(s, Date.parse(t.now)),
    },
  ],
});
