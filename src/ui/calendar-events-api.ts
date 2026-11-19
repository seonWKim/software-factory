// The Calendar page's read (design 09-dashboard-app, Calendar page): GET /api/v1/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
// answers each local day from `from` through `to` with the stored events that overlap it (core/tasks.ts calendarDays,
// in this server's time zone) and whether the day is synced, plus each connected calendar's last sync as `calendar`.
// Read-only: it reads the stored copy the calendar sync left, calls no calendar source and writes no row, so moving
// the page's period costs no remote call.
//
// Connected means listed in the live `calendar` setting, the same resolve Settings → Integrations reads
// (calendar-api.ts readCalendarStatus), not "has a sync row": a source gets its row only when its first sync claims
// it, and a disconnect keeps the rows. So a connected source with no row yet is listed with synced_at null, and a
// source no longer listed is left out with its stored events (design 09-dashboard-tasks, Calendar page).
//
// A day is synced only when every listed source has a successful sync whose window (calendar-sync.ts syncWindow, the
// one the sync itself asks for) covers the whole local day; a source never synced leaves every day not synced. The
// page shows such a day as not synced, never as an empty one.

import { type SourceSync, readCalendar } from "../calendar/index.js";
import { syncWindow } from "../calendar/calendar-sync.js";
import { validDate } from "../core/quick-add.js";
import { calendarDays, dayBounds } from "../core/tasks.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";
import { effectiveGlobal } from "./settings-api.js";
import { Withholder } from "./withhold.js";

export const CALENDAR_EVENTS_PATH = "/api/v1/calendar/events";
/** The most days one read covers, `from` and `to` included: a month grid needs 31. */
export const MAX_SPAN_DAYS = 62;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Why the range is refused, or null: each a `YYYY-MM-DD` date, `from` not after `to`, at most MAX_SPAN_DAYS days. */
function rangeError(from: string | null, to: string | null): string | null {
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v === null || !DATE.test(v) || !validDate(v)) return `${name} must be a date as YYYY-MM-DD, e.g. 2026-11-09`;
  }
  if (from! > to!) return "from must not be later than to";
  if (span(from!, to!) > MAX_SPAN_DAYS) return `from through to must span at most ${MAX_SPAN_DAYS} days`;
  return null;
}

/** The days from `from` through `to`, both included. */
function span(from: string, to: string): number {
  const utc = (date: string) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / DAY_MS) + 1;
}

/** Whether every source's last successful sync covered the whole local day `date`; false with no source. */
function synced(sources: readonly SourceSync[], date: string): boolean {
  const day = dayBounds(date);
  return sources.length > 0 && sources.every((s) => {
    if (s.synced_at === null) return false;
    const w = syncWindow(Date.parse(s.synced_at));
    return Date.parse(w.from) <= day.from && day.to <= Date.parse(w.to);
  });
}

/** GET /api/v1/calendar/events: 400 with the reason for a bad range; else 200 with each day's events and synced flag. */
export async function readCalendarEvents(d: UiDeps, from: string | null, to: string | null): Promise<ApiResult> {
  const error = rangeError(from, to);
  if (error !== null) return { status: 400, value: { error } };
  const connected = new Set((await effectiveGlobal(d, "calendar")).value);
  const stored = await readCalendar(storeSql(d.store));
  const rows = new Map(stored.sources.map((s) => [s.source, s]));
  const sources = [...connected].sort().map((source) => rows.get(source) ?? { source, synced_at: null, failed: false });
  const w = new Withholder(d.scanner);
  const kept = stored.events.filter((e) => connected.has(e.source));
  const events = await Promise.all(kept.map(async (e) => ({ ...e, title: (await w.plain(e.title)).text })));
  const days = calendarDays(events, from!, to!).map((day) => ({ ...day, synced: synced(sources, day.date) }));
  return { status: 200, value: { from, to, days, calendar: sources } };
}
