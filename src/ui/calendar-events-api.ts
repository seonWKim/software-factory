// The Calendar page's read (design 09-dashboard-app, Calendar page): GET /api/v1/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
// answers each local day from `from` through `to` (the calendar component's rangeError: at most MAX_SPAN_DAYS) with
// the stored events that overlap it (core/tasks.ts calendarDays, in this server's time zone) and whether the day is
// synced, plus each connected calendar's last sync as `calendar`. Read-only: it reads the stored copy the calendar
// sync left, calls no calendar source and writes no row, so moving the page's period costs no remote call.
//
// Connected means listed in the live `calendar` setting, read through the one list Settings → Integrations reads
// (calendar-api.ts readCalendarStatus, `flow.listed`), not "has a sync row": a source gets its row only when its first
// sync claims it, and a disconnect keeps the rows. Without the Calendar section wired none is connected, as Settings
// then has no calendar to show. So a connected source with no row yet is listed with synced_at null, and a
// source no longer listed is left out with its stored events (design 09-dashboard-tasks, Calendar page).
//
// A day is synced only when every listed source has a successful read whose window covers the whole local day: its
// last scheduled sync's (calendar-sync.ts syncWindow, the one the sync itself asks for) or one of its on-demand syncs'
// (calendar_synced_ranges); a source never synced leaves every day not synced. The page shows such a day as not
// synced, never as an empty one. `sync_pending` says whether a sync request for exactly `from` through `to` waits.
// Each event carries its `starts_at`, `ends_at` and `details` (src/calendar/event-details.ts) for the page's detail
// view; every text in them passes the egress scan as the title does.
//
// The owner's own events (design 02-tasks-calendar, local events) are added to each day whether or not a calendar is
// connected, each repeat expanded inside the range (src/calendar/calendar-local.ts), with source `local` and their
// `repeats`; a day's `synced` still reflects only the calendar sources. `time_zone` is this process's zone, the one
// every local day here is counted in.
//
// Schedules are shown too, as agent entries (kind `agent`, source `agent`, the schedule's title, no details): each run on
// the day of its occurrence_at, each unpaused schedule's next_due_at on its day (`next` true), read from the store only
// (schedules-api.ts readScheduleSlots) and computed at read time. Every other entry keeps its kind `event`.
//
// A local event copied to a connected calendar (design 02-tasks-calendar, copy to a connected calendar) is shown once:
// the stored copy that calendar's read brought back is left out (calendar-write.ts hideCopies). `copy` names the
// calendar a new event's switch copies to and whether it takes writes (calendar-api.ts UiCalendar.copyTarget, from the
// stored write access: this read never calls the provider), or null when no connected calendar can take copies.

import {
  type EventDetails, type EventPerson, type SourceSync, type SyncedRange, expandLocalEvents, localEvents, processTimeZone, rangeError, readCalendar, readLocalEvents, syncWindow,
} from "../calendar/index.js";
import { calendarDays, dayBounds } from "../core/tasks.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";
import { Withholder } from "./withhold.js";

export const CALENDAR_EVENTS_PATH = "/api/v1/calendar/events";

/** The source name of an agent entry (a schedule's run or next slot). */
const AGENT_SOURCE = "agent";

/** The agent entries as calendar events: zero-length at the slot, so each falls on the day of its instant. */
async function agentEvents(d: UiDeps) {
  // Loaded inside the read, as schedules-api.ts loads its modules: a top-level import would add a feature→feature edge to the layering ratchet.
  const { readScheduleSlots } = await import("./schedules-api.js");
  return (await readScheduleSlots(d)).map((s) => ({
    source: AGENT_SOURCE, id: `${s.schedule_id}:${s.next ? "next" : s.at}`, title: s.title, starts_at: s.at, ends_at: s.at, all_day: false, details: null, next: s.next,
  }));
}

/** Whether every source has a successful read whose window covered the whole local day `date`; false with no source. */
function synced(sources: readonly SourceSync[], ranges: readonly SyncedRange[], date: string): boolean {
  const day = dayBounds(date);
  const covers = (w: { from: string; to: string }) => Date.parse(w.from) <= day.from && day.to <= Date.parse(w.to);
  const windows = (s: SourceSync) => [...(s.synced_at === null ? [] : [syncWindow(Date.parse(s.synced_at))]), ...ranges.filter((r) => r.source === s.source)];
  return sources.length > 0 && sources.every((s) => windows(s).some(covers));
}

/** The connected calendars: the live `calendar` list Settings' Calendar section reads; none without that section. */
async function connectedCalendars(d: UiDeps): Promise<ReadonlySet<string>> {
  return new Set((await d.settings?.calendar?.flow.listed()) ?? []);
}

/** Every text of an event's details through the egress scan (Withholder), as its title; null stays null. */
async function shownDetails(w: Withholder, d: EventDetails | null): Promise<EventDetails | null> {
  if (d === null) return null;
  const plain = async (v: string | null) => (v === null ? null : (await w.plain(v)).text);
  const who = async (p: EventPerson): Promise<EventPerson> => ({ ...p, name: await plain(p.name), email: await plain(p.email) });
  return {
    calendar: await plain(d.calendar), location: await plain(d.location), description: await plain(d.description),
    organizer: d.organizer ? await who(d.organizer) : null, attendees: await Promise.all((d.attendees ?? []).map(who)),
    conference_url: await plain(d.conference_url), link: await plain(d.link), time_zone: await plain(d.time_zone),
  };
}

/** GET /api/v1/calendar/events: 400 with the reason for a bad range; else 200 with each day's events (local ones too) and synced flag, and the time zone. */
export async function readCalendarEvents(d: UiDeps, from: string | null, to: string | null): Promise<ApiResult> {
  const error = rangeError(from, to);
  if (error !== null) return { status: 400, value: { error } };
  const connected = await connectedCalendars(d);
  const db = storeSql(d.store);
  const stored = await readCalendar(db);
  const rows = new Map(stored.sources.map((s) => [s.source, s]));
  const sources = [...connected].sort().map((source) => rows.get(source) ?? { source, synced_at: null, failed: false });
  const w = new Withholder(d.scanner);
  const local = expandLocalEvents(await readLocalEvents(db, from!, to!), from!, to!);
  const kept = [...(await localEvents(db).hideCopies(stored.events.filter((e) => connected.has(e.source)))), ...local, ...(await agentEvents(d))];
  const plain = async (v: string | null | undefined) => (v == null ? v : (await w.plain(v)).text);
  const events = await Promise.all(kept.map(async (e) => ({
    ...e, title: (await w.plain(e.title)).text, details: await shownDetails(w, e.details), ...("sync_error" in e ? { sync_error: await plain(e.sync_error as string | null) } : {}),
  })));
  const days = calendarDays(events, from!, to!).map((day) => ({
    ...day, synced: synced(sources, stored.ranges, day.date), events: day.events.map((e) => ({ ...e, kind: e.source === AGENT_SOURCE ? "agent" : "event" })),
  }));
  const pending = stored.pending.some((p) => p.from === from && p.to === to);
  const copy = (await d.settings?.calendar?.copyTarget?.()) ?? null;
  return { status: 200, value: { from, to, time_zone: processTimeZone(), days, calendar: sources, sync_pending: pending, copy } };
}
