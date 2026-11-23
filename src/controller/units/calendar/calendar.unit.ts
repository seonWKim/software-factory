// The calendar sync step (design 02-tasks, calendar): each poll, the calendar component syncs every configured
// source that is due (at most once per 5 minutes per source, by the due time it stores), then runs every pending
// sync request the dashboard or the CLI stored (design 02-tasks-calendar, 2026-11-22). No source configured: the
// step returns before any read. The unit holds no schedule of its own and reaches no store: the component owns its
// tables and their SQL.

import { type NamedFeed, runSyncRequests, syncCalendars } from "../../../calendar/index.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

declare module "../../../core/controller-deps.js" {
  interface ControllerDeps {
    /** The calendar sources the top-level `calendar` key selects, by name, in config order. Absent or empty: none. */
    calendar?: readonly NamedFeed[];
  }
}

export class CalendarUnit {
  constructor(private readonly c: Ctx) {}

  /** Syncs the due sources, then the pending requests, at the tick's time; a source's failure is stored by the component and logged here. */
  async calendarStep(): Promise<void> {
    const k = this.c.k;
    const feeds = k.d.calendar ?? [];
    if (feeds.length === 0) return;
    const db = k.db;
    if (db === null) {
      k.d.log.warn("calendar sources are configured but the store has no SQL database: nothing is synced", {});
      return;
    }
    const now = k.nowMs();
    for (const r of [...(await syncCalendars(db, feeds, now)), ...(await runSyncRequests(db, feeds, now))]) {
      if (!r.ok) k.d.log.warn("calendar sync failed", { source: r.source, error: r.error });
    }
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "calendar": CalendarUnit;
  }
}

export default controllerUnit({
  name: "calendar",
  create: (c: Ctx) => new CalendarUnit(c),
  steps: [{ name: "calendar", every: "poll", order: 85, run: (u) => u.calendarStep() }],
});
