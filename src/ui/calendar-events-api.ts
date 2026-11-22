// The Calendar page's read (design 09-dashboard-app, Calendar page): GET /api/v1/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
// answers each local day from `from` through `to` (the calendar component's rangeError: at most MAX_SPAN_DAYS) with
// the stored events that overlap it (core/tasks.ts calendarDays, in this server's time zone) and whether the day is synced, plus each calendar source's last sync (the same list GET
// /api/v1/tasks answers as `calendar`). Read-only: it reads the stored copy the calendar sync left, calls no calendar
// source and writes no row, so moving the page's period costs no remote call.
//
// A day is synced only when every listed source has a successful read whose window covers the whole local day: its
// last scheduled sync's (calendar-sync.ts syncWindow, the one the sync itself asks for) or one of its on-demand syncs'
// (calendar_synced_ranges); a source never synced leaves every day not synced. The page shows such a day as not
// synced, never as an empty one. `sync_pending` says whether a sync request for exactly `from` through `to` waits.

import { type SourceSync, type StoredCalendar, rangeError, readCalendar, syncWindow } from "../calendar/index.js";
import { calendarDays, dayBounds } from "../core/tasks.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";
import { Withholder } from "./withhold.js";

export const CALENDAR_EVENTS_PATH = "/api/v1/calendar/events";

/** Whether every source has a successful read whose window covered the whole local day `date`; false with no source. */
function synced(calendar: StoredCalendar, date: string): boolean {
  const day = dayBounds(date);
  const covers = (w: { from: string; to: string }) => Date.parse(w.from) <= day.from && day.to <= Date.parse(w.to);
  const windows = (s: SourceSync) => [...(s.synced_at === null ? [] : [syncWindow(Date.parse(s.synced_at))]), ...calendar.ranges.filter((r) => r.source === s.source)];
  return calendar.sources.length > 0 && calendar.sources.every((s) => windows(s).some(covers));
}

/** GET /api/v1/calendar/events: 400 with the reason for a bad range; else 200 with each day's events and synced flag. */
export async function readCalendarEvents(d: UiDeps, from: string | null, to: string | null): Promise<ApiResult> {
  const error = rangeError(from, to);
  if (error !== null) return { status: 400, value: { error } };
  const calendar = await readCalendar(storeSql(d.store));
  const w = new Withholder(d.scanner);
  const events = await Promise.all(calendar.events.map(async (e) => ({ ...e, title: (await w.plain(e.title)).text })));
  const days = calendarDays(events, from!, to!).map((day) => ({ ...day, synced: synced(calendar, day.date) }));
  const pending = calendar.pending.some((p) => p.from === from && p.to === to);
  return { status: 200, value: { from, to, days, calendar: calendar.sources, sync_pending: pending } };
}
