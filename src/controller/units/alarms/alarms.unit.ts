// The alarm patterns across items and the restart list.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { type HeldPattern, RESTART_WINDOW_MS, alarmStep, heldKey, holdPatch, recurringStalls, releasePatch } from "../../../core/alarms.js";
import { ALARM_DEFAULTS, STALL_DEFAULTS } from "../../../core/config.js";
import { RECURRING_FAILURE } from "../../../core/types.js";
import { SYSTEM } from "../support.js";
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
      {
        store, scanner: this.c.k.d.scanner, clock: this.c.k.d.clock, log: this.c.k.d.log, project: this.c.k.project(), restarts,
        hold: (p) => this.holdItems(p),
        comment: (ref, body, marker) => this.c.unit("improve").commentFiled(ref, body, marker),
      },
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
    await this.releaseStep();
  }

  /**
   * Holds the items a filed or recurring pattern hit (design 05-alarms): each open item nothing else blocks gets
   * `blocked_on: human`, `recurring_failure`, the pattern key in the state change, so its queued runs are not
   * claimed and other items keep running. An item filed as a fix is never held. A conditional transition per item,
   * so a second call changes nothing.
   */
  async holdItems(p: HeldPattern): Promise<void> {
    for (const id of p.work_item_ids) {
      await this.c.unit("transitions").decide(id, async (it) => {
        const hold = holdPatch(it, p.pattern_key);
        return hold && !(await this.c.unit("improve").fixPattern(it)) ? { ...hold, actor: SYSTEM } : null;
      });
    }
  }

  /**
   * Once the model answered its stall probe (design 05-restarts): the recurring stall patterns of the last hour hold
   * their items, so the next stall of one of them pauses no other item's claims.
   */
  async holdStalled(): Promise<void> {
    const d = this.c.k.d;
    for (const p of await recurringStalls({ store: d.store, project: this.c.k.project(), clock: d.clock })) await this.holdItems(p);
  }

  /**
   * Releases held items whose pattern's fix item merged (closed with a merge sha): `blocked_on: none`, so their
   * queued runs are claimed again for a retry. Reads the held items (by their reason, so a hold from before holds were for a person, `upstream`,
   * is released too) and their hold's pattern key; safe to run twice.
   */
  async releaseStep(): Promise<void> {
    const store = this.c.k.d.store;
    for (const it of await store.listWorkItemsWhere({ blocked_reason: RECURRING_FAILURE, exclude_closed: true, limit: 500 })) {
      const key = await heldKey(it, () => this.c.k.reader.listStateChanges(it.id));
      if (key === null) continue;
      const ref = (await store.getFiledPattern(it.project, key))?.filed_ref;
      const fix = ref ? await store.getWorkItemBySource(ref.type, ref.id) : null;
      if (!releasePatch(it, key, fix)) continue;
      await this.c.unit("transitions").decide(it.id, (cur) => {
        const release = releasePatch(cur, key, fix);
        return release ? { ...release, actor: SYSTEM } : null;
      });
    }
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
