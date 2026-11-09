// The alarm patterns across items and the restart list.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { RERAISE_WINDOW_MS, RESTART_WINDOW_MS, alarmStep, stallPatterns } from "../../../core/alarms.js";
import { ALARM_DEFAULTS, STALL_DEFAULTS } from "../../../core/config.js";
import { patternKey } from "../../../core/improver.js";
import { RECURRING_FAILURE, type WorkItem, type WorkItemId } from "../../../core/types.js";
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
        hold: (ids, key) => this.holdItems(ids, key),
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
   * Holds the items a recurring pattern hit (design 05-alarms): each open item with nothing else blocking it gets
   * `blocked_on: upstream`, `recurring_failure`, the pattern key in the state change, so its queued runs are not
   * claimed and other items keep running. An item filed as a fix is never held. A conditional transition per item,
   * so a second call changes nothing.
   */
  async holdItems(ids: readonly WorkItemId[], pattern_key: string): Promise<void> {
    const fixes = new Set<string>();
    for (const id of ids) {
      await this.c.unit("transitions").decide(id, async (it) => {
        if (it.stage === "CLOSED" || it.blocked_on !== "none") return null;
        if (fixes.size === 0) for (const p of await this.c.k.d.store.listFiledPatterns(it.project)) if (p.filed_ref) fixes.add(sourceKey(p.filed_ref));
        if (fixes.has(sourceKey(it.source))) return null;
        return { patch: { blocked_on: "upstream", blocked_reason: RECURRING_FAILURE }, actor: SYSTEM, reason: RECURRING_FAILURE, detail: { pattern_key } };
      });
    }
  }

  /**
   * Once the model answered its stall probe (design 05-restarts): the stall patterns of the last hour hold their
   * items, so the next stall of one of them pauses no other item's claims.
   */
  async holdStalled(): Promise<void> {
    const store = this.c.k.d.store;
    for (const g of stallPatterns(await store.listRunsFinishedWithin(RERAISE_WINDOW_MS), this.c.k.d.clock.now())) await this.holdItems(g.work_item_ids, patternKey(g));
  }

  /**
   * Releases held items whose pattern's fix item merged (closed with a merge sha): `blocked_on: none`, so their
   * queued runs are claimed again for a retry. Reads the held items and their hold's pattern key; safe to run twice.
   */
  async releaseStep(): Promise<void> {
    const store = this.c.k.d.store;
    const held = (await store.listWorkItemsWhere({ blocked_on: "upstream", exclude_closed: true, limit: 500 })).filter((it) => it.blocked_reason === RECURRING_FAILURE);
    for (const it of held) {
      const key = (await this.c.k.reader.listStateChanges(it.id)).filter((c) => c.reason === RECURRING_FAILURE).at(-1)?.detail?.pattern_key;
      if (typeof key !== "string") continue;
      const fix = await this.fixItem(it, key);
      if (!fix || fix.stage !== "CLOSED" || !fix.merge_sha) continue;
      await this.c.unit("transitions").decide(it.id, (cur) =>
        cur.blocked_reason === RECURRING_FAILURE
          ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "recurring_failure_released", detail: { pattern_key: key, fix_work_item_id: fix.id } }
          : null,
      );
    }
  }

  /** The item filed as the fix of `pattern_key` in the item's project, when the store holds it. */
  private async fixItem(it: WorkItem, pattern_key: string): Promise<WorkItem | null> {
    const ref = (await this.c.k.d.store.getFiledPattern(it.project, pattern_key))?.filed_ref;
    return ref ? this.c.k.d.store.getWorkItemBySource(ref.type, ref.id) : null;
  }
}

const sourceKey = (ref: { type: string; id: string }) => `${ref.type}\n${ref.id}`;

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
