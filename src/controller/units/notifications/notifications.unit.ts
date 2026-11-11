// Owner notices (design 09-notifications). A pure step: `load` reads the items waiting on the owner, their stored
// notices and the held notices, and the state changes of each item whose wait may be new (one with a notice newer
// than its last update is unchanged since); `decide` (src/core/notifications.ts) returns the notices to write, which
// the router commits, each an insert that skips a stored (work item, wait key) in case another replica wrote it
// first. It writes nothing else: no state change, intent or item field. The shell shows them (phase 2).

import { type NoticeSettings, SUMMARY_ITEM, type WaitingItem, decideNotices, noticedSince } from "../../../core/notifications.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { ControllerReader } from "../kernel.js";
import type { ControllerDecision, Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Items read per pass: far more than wait on one owner at once. */
const WAITING_LIMIT = 500;

interface Loaded {
  readonly waiting: readonly WaitingItem[];
  readonly stored: Parameters<typeof decideNotices>[0]["stored"];
  readonly settings: NoticeSettings;
}

/** Writes the owner's notices. */
export class NotificationsUnit {
  constructor(private readonly c: Ctx) {}

  async load(r: ControllerReader): Promise<Loaded> {
    const { notice_kinds, quiet_hours } = this.c.k.live.values();
    const items = await r.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, limit: WAITING_LIMIT });
    const stored = [...(await r.listNoticesFor([SUMMARY_ITEM, ...items.map((it) => it.id)])), ...(await r.listHeldNotices())];
    const waiting: WaitingItem[] = [];
    for (const item of items) waiting.push({ item, changes: noticedSince(stored, item.id, item.updated_at) ? [] : await r.listStateChanges(item.id) });
    return { waiting, stored, settings: { notice_kinds, quiet_hours } };
  }

  decide(l: Loaded, tick: Tick): ControllerDecision {
    return { writes: decideNotices({ ...l, now: new Date(tick.now) }).map((notice) => ({ kind: "notice", notice })) };
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "notifications": NotificationsUnit;
  }
}

export default controllerUnit({
  name: "notifications",
  create: (c: Ctx) => new NotificationsUnit(c),
  steps: [
    {
      name: "notifications", every: "poll", order: 80,
      load: (u, r) => u.load(r),
      decide: (u, loaded: Loaded, tick) => u.decide(loaded, tick),
    },
  ],
});
