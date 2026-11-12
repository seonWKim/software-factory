// Owner notices (design 09-notifications). A pure step: `load` reads the items waiting on the owner, the items closed
// since `finishedSince` (the later of the cutover and the 7-day lookback), their stored notices and the held notices,
// and the state changes of each item whose wait or close may be new (one with a notice newer than its last update is
// unchanged since); `decide` (src/core/notifications.ts) returns the notices to write, which the router commits, each
// an insert that skips a stored (work item, wait key) in case another replica wrote it first. Each notice quiet hours
// do not hold also gets one outbox intent per `notify_channels` adapter that has `notifyOwner` (notifiers.ts, design
// 12-notification-channels), keyed so a second pass or replica stores it once, and written before its notice. It
// writes no state change or item field. The shell shows the notices; outbound sends the intents.

import {
  FINISHED_KIND, NOTIFY_REF, type ClosedItem, type NewNotice, type NoticeSettings, SUMMARY_ITEM, SUMMARY_KIND, type WaitingItem, WAIT_KINDS,
  closeOutcome, decideNotices, finishedSince, noticedSince, waitReason,
} from "../../../core/notifications.js";
import type { NewAction } from "../../../outbound/index.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { ControllerReader, ControllerWrite } from "../kernel.js";
import type { ControllerDecision, Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { type Notifier, notifiers } from "./notifiers.js";

/** Items read per pass: far more than wait on one owner, or close in 7 days, at once. */
const WAITING_LIMIT = 500;

type WorkItem = Awaited<ReturnType<ControllerReader["listWorkItemsWhere"]>>[number];
type Item = Pick<WorkItem, "id" | "title" | "source" | "close_reason">;

interface Loaded {
  readonly waiting: readonly WaitingItem[];
  readonly closed: readonly ClosedItem[];
  readonly items: ReadonlyMap<string, Item>;
  readonly stored: Parameters<typeof decideNotices>[0]["stored"];
  readonly settings: NoticeSettings;
  readonly channels: readonly string[];
}

/** Writes the owner's notices, and their intents for the notify channels. */
export class NotificationsUnit {
  /** The `notify_channels` names that reach an adapter with notifyOwner, with its type. */
  private readonly notifiers: (names: readonly string[]) => Notifier[];

  constructor(private readonly c: Ctx) {
    this.notifiers = notifiers(c.k);
  }

  async load(r: ControllerReader, tick: Tick): Promise<Loaded> {
    const { notice_kinds, quiet_hours, notify_channels } = this.c.k.live.values();
    const items = await r.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, limit: WAITING_LIMIT });
    const closes = await r.listWorkItemsWhere({ stage: "CLOSED", updated_since: finishedSince(new Date(tick.now)), limit: WAITING_LIMIT });
    const ids = [...items, ...closes].map((it) => it.id);
    const stored = [...(await r.listNoticesFor([SUMMARY_ITEM, ...ids])), ...(await r.listHeldNotices())];
    const changes = async (it: WorkItem) => (noticedSince(stored, it.id, it.updated_at) ? [] : await r.listStateChanges(it.id));
    const waiting: WaitingItem[] = [];
    for (const item of items) waiting.push({ item, changes: await changes(item) });
    const closed: ClosedItem[] = [];
    for (const item of closes) closed.push({ item, changes: await changes(item) });
    return { waiting, closed, items: new Map([...items, ...closes].map((it) => [it.id, it])), stored, settings: { notice_kinds, quiet_hours }, channels: notify_channels };
  }

  decide(l: Loaded, tick: Tick): ControllerDecision {
    const notices = decideNotices({ ...l, now: new Date(tick.now) });
    const to = this.notifiers(l.channels);
    const writes: ControllerWrite[] = [];
    for (const notice of notices) {
      // Held by quiet hours: no intent; the summary that covers it gets one.
      if (notice.held_until === null) for (const n of to) writes.push({ kind: "intent", action: intent(notice, l.items, n) });
      writes.push({ kind: "notice", notice });
    }
    return { writes };
  }
}

/** One notice's intent for one channel: neutral args, keyed on (item, wait key, channel). */
function intent(n: NewNotice, items: ReadonlyMap<string, Item>, to: Notifier): NewAction {
  const item = items.get(n.work_item_id);
  const finished = n.kind === FINISHED_KIND;
  const wait = (WAIT_KINDS as readonly string[]).includes(n.kind) ? (n.kind as (typeof WAIT_KINDS)[number]) : null;
  return {
    action: "notify",
    target: { type: to.type, id: NOTIFY_REF, link: "" },
    work_item_id: n.work_item_id === SUMMARY_ITEM ? null : n.work_item_id,
    key: `notify:${n.work_item_id}:${n.wait_key}:${to.channel}`,
    args: {
      kind: finished ? FINISHED_KIND : n.kind === SUMMARY_KIND ? SUMMARY_KIND : "needs_you",
      work_item_id: n.work_item_id === SUMMARY_ITEM ? null : n.work_item_id,
      title: n.kind === SUMMARY_KIND ? "" : (item?.title ?? "Untitled item"),
      reason: finished ? closeOutcome(item?.close_reason ?? null) : wait ? waitReason(wait) : "",
      close_reason: finished ? (item?.close_reason ?? null) : null,
      source_type: item?.source.type ?? null,
      thread_url: item?.source.link || null,
      count: n.count,
    },
  };
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
      load: (u, r, tick) => u.load(r, tick),
      decide: (u, loaded: Loaded, tick) => u.decide(loaded, tick),
    },
  ],
});
