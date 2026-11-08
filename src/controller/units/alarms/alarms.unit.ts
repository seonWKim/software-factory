// The alarm patterns across items and the restart list.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { RESTART_WINDOW_MS, alarmStep } from "../../../core/alarms.js";
import { ALARM_DEFAULTS, STALL_DEFAULTS } from "../../../core/config.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The alarm patterns across items and the restart list. */
export class AlarmsUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * Looks across items for the three alarm patterns; reads only the store and the restart list. This host's
   * restarts are stored first, one conditional insert each (design 05-restarts, restart history), and counted as
   * the host lists them. A process with no restart list of its own counts the store's restarts of every host.
   */
  async alarmsStep(): Promise<void> {
    const c = this.c.k.cfg;
    const store = this.c.k.d.store;
    const own = this.c.k.d.restarts;
    const restarts = async () => {
      if (!own) return store.listChildRestartsWithin(RESTART_WINDOW_MS);
      const list = await own();
      for (const r of list) await store.recordChildRestart(r);
      return list;
    };
    const stored = await alarmStep(
      { store, scanner: this.c.k.d.scanner, clock: this.c.k.d.clock, log: this.c.k.d.log, restarts },
      {
        alarm_repeat_count: c.alarm_repeat_count ?? ALARM_DEFAULTS.alarm_repeat_count,
        alarm_window_minutes: c.alarm_window_minutes ?? ALARM_DEFAULTS.alarm_window_minutes,
        alarm_restart_count: c.alarm_restart_count ?? ALARM_DEFAULTS.alarm_restart_count,
        probe_interval_ms: c.probe_interval_ms ?? STALL_DEFAULTS.probe_interval_ms,
      },
    );
    // A failure burst stops auto mode (design 03-risk).
    const burst = stored.find((a) => a.pattern !== "auto_stopped");
    if (burst) await this.c.unit("local-merge").stopAuto(this.c.k.cfg.project.key, "failure_alert", `the ${burst.pattern} alarm (${burst.error_code}, ${burst.count})`);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "alarms": AlarmsUnit;
  }
}

export default controllerUnit({
  name: "alarms",
  create: (c: Ctx) => new AlarmsUnit(c),
  steps: [
    { name: "alarms", every: "poll", order: 70, run: (u) => u.alarmsStep() },
  ],
});
