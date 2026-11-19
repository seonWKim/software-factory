import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { type CalendarDay, type CalendarEvents, type CalendarSync, type EventRow, useCalendarEvents } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { EmptyState, Notice, PageHeader } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading, Table, Td, Tr } from "../components/ui/parts.js";
import { Card } from "../components/ui/card.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { dayLabel } from "./tasks/groups.js";

// The Calendar page (design 09-dashboard-app, Calendar page): the stored calendar events of one week or one month,
// read-only, from GET /api/v1/calendar/events with the first and last day shown. Week: Monday to Sunday as seven columns.
// Month: a Monday-first grid, up to 3 events a day and then "+N more". Previous and next move by one week or month;
// Today returns to the period holding today in the browser's time zone. A day the last syncs did not cover shows
// "Not synced", never an empty day. A source whose last sync failed is named with its last sync time, and its stored
// events stay listed. With no calendar connected the empty state links to the Integrations tab of Settings.

const VIEWS = [
  { id: "week", label: t("calendarPage.week") },
  { id: "month", label: t("calendarPage.month") },
] as const;
type View = (typeof VIEWS)[number]["id"];

const CONNECT_PATH = `${BASE}settings?tab=integrations#calendar`;
/** The events a month cell lists before "+N more". */
const CELL_EVENTS = 3;

const pad = (n: number) => String(n).padStart(2, "0");
/** A local date as `YYYY-MM-DD`. */
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const monthName = (d: Date, month: "short" | "long") => d.toLocaleDateString(undefined, { month });

/** The first and last day shown for `view` around `focus`: its Monday-to-Sunday week, or its month. */
function period(view: View, focus: Date): { from: Date; to: Date } {
  if (view === "week") return { from: monday(focus), to: addDays(monday(focus), 6) };
  return { from: new Date(focus.getFullYear(), focus.getMonth(), 1), to: new Date(focus.getFullYear(), focus.getMonth() + 1, 0) };
}

/** `focus` moved by one period: a week, or a month (to its first day, so no month is skipped). */
function step(view: View, focus: Date, by: 1 | -1): Date {
  return view === "week" ? addDays(focus, 7 * by) : new Date(focus.getFullYear(), focus.getMonth() + by, 1);
}

/** The period's name: "Nov 9 – 15, 2026" for a week (months and years named where they differ), "November 2026" for a month. */
function heading(view: View, { from, to }: { from: Date; to: Date }): string {
  if (view === "month") return from.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const [fromMonth, toMonth] = [monthName(from, "short"), monthName(to, "short")];
  if (from.getFullYear() !== to.getFullYear()) {
    return t("calendarPage.weekTwoYears", { fromMonth, from: from.getDate(), fromYear: from.getFullYear(), toMonth, to: to.getDate(), toYear: to.getFullYear() });
  }
  if (from.getMonth() !== to.getMonth()) return t("calendarPage.weekSameYear", { fromMonth, from: from.getDate(), toMonth, to: to.getDate(), year: from.getFullYear() });
  return t("calendarPage.weekSameMonth", { month: fromMonth, from: from.getDate(), to: to.getDate(), year: from.getFullYear() });
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

const NotSynced = () => <p data-not-synced className="text-xs text-text-2">{t("calendarPage.notSynced")}</p>;

/** Week: the seven days as columns in one row (scrolling sideways inside the card on a narrow window), each with its events, "No events", or "Not synced". */
function WeekDays({ label, days }: { label: string; days: readonly CalendarDay[] }) {
  return (
    <div className="overflow-x-auto">
    <ol aria-label={label} className="grid min-w-[56rem] grid-cols-7 gap-2">
      {days.map((d) => (
        <li key={d.date} data-day={d.date} className="min-w-0 space-y-1">
          <h3 className="text-xs font-medium text-text-2">{dayLabel(d.date)}</h3>
          {!d.synced ? (
            <NotSynced />
          ) : d.events.length === 0 ? (
            <p className="text-xs text-text-2">{t("calendarPage.noEvents")}</p>
          ) : (
            <ul aria-label={dayLabel(d.date)} className="divide-y divide-border rounded-control border border-border">
              {d.events.map((e) => (
                <EventCard key={`${e.source}:${e.id}`} event={e} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
    </div>
  );
}

/** One month cell: the day's number, then up to CELL_EVENTS events and "+N more", or "Not synced". */
function MonthCell({ day }: { day: CalendarDay }) {
  const shown = day.events.slice(0, CELL_EVENTS);
  const more = day.events.length - shown.length;
  return (
    <Td data-day={day.date} className="h-20 p-1">
      <p className="text-xs font-medium tabular-nums">{Number(day.date.slice(8))}</p>
      {!day.synced ? (
        <NotSynced />
      ) : (
        <ul className="space-y-0.5">
          {shown.map((e) => (
            <li key={`${e.source}:${e.id}`} data-event={`${e.source}:${e.id}`} title={`${e.time ?? t("calendarPage.allDay")} ${e.title} (${e.source})`} className="truncate text-xs">
              {e.time !== null && <span className="tabular-nums text-text-2">{e.time} </span>}
              {e.title}
            </li>
          ))}
          {more > 0 && <li className="text-xs text-text-2">{t("calendarPage.more", { n: more })}</li>}
        </ul>
      )}
    </Td>
  );
}

/** Month: a Monday-first grid of the month's days; the cells before its first and after its last day are empty. */
function MonthGrid({ label, days }: { label: string; days: readonly CalendarDay[] }) {
  const first = days[0];
  if (!first) return null;
  const [y, m, d] = first.date.split("-").map(Number) as [number, number, number];
  const lead = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  // 2024-01-01 is a Monday: the column heads in the viewer's locale.
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
  return (
    <Table label={label} head={weekdays}>
      {weeks.map((week, i) => (
        <Tr key={i}>{week.map((day, j) => (day === null ? <Td key={`empty-${j}`} /> : <MonthCell key={day.date} day={day} />))}</Tr>
      ))}
    </Table>
  );
}

/** The sources whose last sync failed, each with its last sync time: their events shown are the last stored ones. */
function StaleCalendars({ calendar }: { calendar: readonly CalendarSync[] }) {
  const failed = calendar.filter((c) => c.failed);
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

function Events({ v, view, label }: { v: CalendarEvents; view: View; label: string }) {
  if (v.calendar.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("calendarPage.emptyNone")} action={<Link href={CONNECT_PATH} className={cn(LINK_CLASS, "text-sm")}>{t("calendarPage.connect")}</Link>} />;
  }
  return (
    <>
      <StaleCalendars calendar={v.calendar} />
      {v.days.every((d) => !d.synced) && <Notice tone="info">{t("calendarPage.periodNotSynced")}</Notice>}
      {view === "week" ? <WeekDays label={label} days={v.days} /> : <MonthGrid label={label} days={v.days} />}
    </>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [focus, setFocus] = useState(() => new Date());
  const shown = period(view, focus);
  const label = heading(view, shown);
  const q = useCalendarEvents(iso(shown.from), iso(shown.to));
  const v = q.data;
  return (
    <>
    <PageHeader title={t("page.calendar")} />
    <div className="flex flex-col gap-6">
      <div data-calendar-toolbar className="flex flex-wrap items-center gap-2">
        <SegmentedControl label={t("calendarPage.view")} options={VIEWS} value={view} onChange={setView} />
        <ButtonRow role="group" aria-label={t("calendarPage.period")}>
          <Button aria-label={t(view === "week" ? "calendarPage.previousWeek" : "calendarPage.previousMonth")} onClick={() => setFocus(step(view, focus, -1))}>
            {t("calendarPage.previous")}
          </Button>
          <Button aria-label={t(view === "week" ? "calendarPage.nextWeek" : "calendarPage.nextMonth")} onClick={() => setFocus(step(view, focus, 1))}>
            {t("calendarPage.next")}
          </Button>
          <Button onClick={() => setFocus(new Date())}>{t("calendarPage.today")}</Button>
        </ButtonRow>
      </div>
      <Card title={label} live>
        {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <Events v={v} view={view} label={label} />}
      </Card>
    </div>
    </>
  );
}
