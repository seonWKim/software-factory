// The scheduler (design 08-schedules, phase 2): one step on each controller tick claims the schedules due at the
// tick's time (runDueSchedules, never a clock read; the controller's tick_ms is how late a `skip` schedule's claim
// may be) and runs the selected ScheduleAction (`plugins.schedule_action`) once per fired occurrence. No action selected: the step returns before any read, so a due occurrence stays
// unclaimed and the factory runs as before. Compose binds the action to the store's claim pass (scheduledAction,
// src/core/controller-deps.ts), so this unit imports no core code. The pass runs in `load`, as the calendar unit's
// sync runs in its step, because only a load gets the tick; `decide` commits nothing.

import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

export class ScheduleUnit {
  constructor(private readonly c: Ctx) {}

  /** Claims and runs the occurrences due at `tick.now`, late after one tick period (`tick_ms`); nothing without a selected action. */
  async scheduleStep(tick: Tick): Promise<void> {
    await this.c.k.d.schedule_action?.fireDue(new Date(tick.now), this.c.k.cfg.tick_ms);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "schedule": ScheduleUnit;
  }
}

export default controllerUnit({
  name: "schedule",
  create: (c: Ctx) => new ScheduleUnit(c),
  steps: [
    {
      name: "schedules", every: "tick", order: 87,
      load: (u, _r, tick) => u.scheduleStep(tick),
      decide: () => ({ writes: [] }),
    },
  ],
});
