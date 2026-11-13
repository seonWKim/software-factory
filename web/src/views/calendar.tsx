import { useState } from "react";
import { type DayRow, type EventRow, type TasksView, isEventRow, useTasks } from "../api.js";
import { EmptyState, Notice } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { dayLabel } from "./tasks.js";

// The Calendar page (design 09-dashboard-app and 02-tasks): the stored calendar events, read-only, from the same
// GET /api/v1/tasks the Tasks page reads (no project filter; no new route). Day: today's events. Upcoming: each of
// today through 7 days ahead with its events. All-day events come first, then timed ones by time, each with its time
// or "all day" and its source. A source whose last sync failed is named with its last sync time, and its stored
// events stay listed. With no calendar connected the empty state links to Settings → Calendar.

const VIEWS = [
  { id: "day", label: t("calendarPage.day") },
  { id: "upcoming", label: t("calendarPage.upcoming") },
] as const;
type View = (typeof VIEWS)[number]["id"];

const CONNECT_PATH = `${BASE}settings#calendar`;

/** The events among a day's rows, all-day first, then timed ones by time (the server orders them so; a stable sort keeps that). */
function eventsOf(rows: readonly DayRow[]): EventRow[] {
  return rows.filter(isEventRow).sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.time ?? "").localeCompare(b.time ?? ""));
}

/** A calendar event: its title, its time that day or "all day", and its source's name. Read-only. */
function EventCard({ event }: { event: EventRow }) {
  return (
    <li data-event={`${event.source}:${event.id}`} className="flex flex-wrap items-start gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-pretty break-words">{event.title}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-pretty text-text-2">
          <span className="tabular-nums">{event.time ?? t("calendarPage.allDay")}</span>
          <span className="break-all">{event.source}</span>
        </p>
      </div>
    </li>
  );
}

function EventList({ label, events }: { label: string; events: readonly EventRow[] }) {
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-control border border-border">
      {events.map((e) => (
        <EventCard key={`${e.source}:${e.id}`} event={e} />
      ))}
    </ul>
  );
}

/** The sources whose last sync failed, each with its last sync time: their events shown are the last stored ones. */
function StaleCalendars({ v }: { v: TasksView }) {
  const failed = (v.calendar ?? []).filter((c) => c.failed);
  if (failed.length === 0) return null;
  const when = (at: string | null) =>
    at === null ? t("calendarPage.neverSynced") : t("calendarPage.lastSynced", { at: new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) });
  return (
    <Notice tone="warn" title={t("calendarPage.syncFailed")}>
      {failed.map((c) => (
        <p key={c.source} data-calendar-stale={c.source} className="text-pretty break-words">
          {t("calendarPage.stale", { source: c.source, when: when(c.synced_at) })}
        </p>
      ))}
    </Notice>
  );
}

function Empty({ v, view }: { v: TasksView; view: View }) {
  const none = (v.calendar ?? []).length === 0;
  return (
    <EmptyState
      title={none ? t("calendarPage.emptyNone") : view === "day" ? t("calendarPage.emptyDay") : t("calendarPage.emptyUpcoming")}
      action={none ? <Link href={CONNECT_PATH} className={cn(LINK_CLASS, "text-sm")}>{t("calendarPage.connect")}</Link> : undefined}
    />
  );
}

function Events({ v, view }: { v: TasksView; view: View }) {
  const today = eventsOf(v.today.due);
  const days = v.upcoming.map((d) => ({ date: d.date, events: eventsOf(d.tasks) })).filter((d) => d.events.length > 0);
  if (view === "day" ? today.length === 0 : days.length === 0) return <Empty v={v} view={view} />;
  if (view === "day") return <EventList label={t("calendarPage.today", { day: dayLabel(v.today_date) })} events={today} />;
  return (
    <div className="space-y-3">
      {days.map((d) => (
        <div key={d.date} className="space-y-1">
          <h3 className="text-xs font-medium text-text-2">{dayLabel(d.date)}</h3>
          <EventList label={dayLabel(d.date)} events={d.events} />
        </div>
      ))}
    </div>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<View>("day");
  const q = useTasks<TasksView>(null);
  const v = q.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl label={t("calendarPage.view")} options={VIEWS} value={view} onChange={setView} />
      </div>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !v ? (
        <Loading rows={3} />
      ) : (
        <>
          <StaleCalendars v={v} />
          <Events v={v} view={view} />
        </>
      )}
    </div>
  );
}
