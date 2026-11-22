import { CalendarDays } from "lucide-react";
import { useRef, useState } from "react";
import { API, type CalendarDay, type CalendarEvents, type CalendarSync, type EventRow, type Session, postCalendarSync, useApi, useCalendarEvents } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { EmptyState, Notice, PageHeader, PageToolbar } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading, Table, Td, Tr } from "../components/ui/parts.js";
import { Card, SUB_TITLE } from "../components/ui/card.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { dayLabel } from "./tasks/groups.js";

// The Calendar page (design 09-dashboard-app, Calendar page): the stored calendar events of one week or one month,
// read-only, from GET /api/v1/calendar/events with the first and last day shown. Week: Monday to Sunday as seven columns.
// Month: a Monday-first grid, up to 3 events a day and then "+N more". Previous and next move by one week or month;
// Today returns to the period holding today in the browser's time zone, and today's date is circled. The period's
// heading is the Card's h2; the view switch and the period buttons are the page's PageToolbar. Each event has a colour strip chosen from its source's name and names its source only when
// several calendars are connected. A day the last syncs did not cover is shaded, never drawn empty, and one note above the
// grid names those days; an empty synced day shows no text. A source whose last sync failed is named with its last sync time, and its stored
// events stay listed. With no calendar connected the empty state links to the Integrations tab of Settings.
// Sync (after Today, shown once a calendar is connected) and the note's "Sync these days" post one request to sync
// every calendar for the days shown (POST /api/v1/calendar/sync); both show "Syncing…", disabled, until the request
// is done (the read's `sync_pending`), and a second press sends nothing.

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

/** The existing token colours an event's strip is chosen from, by its source's name. */
const STRIPS = ["bg-kind-triage", "bg-kind-implement", "bg-kind-review", "bg-kind-resolve", "bg-kind-merge-check"] as const;
/** A source's strip colour: a stable hash of its name, so the same source keeps its colour across reads. */
function stripFor(source: string): string {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STRIPS[h % STRIPS.length]!;
}
const Strip = ({ source }: { source: string }) => <span aria-hidden data-strip className={cn("w-1 shrink-0 self-stretch rounded-pill", stripFor(source))} />;

/** The outline that circles today's date. */
const TODAY_RING = "rounded-pill px-1.5 outline outline-2 outline-accent";
/** The shading of a day the last syncs did not cover. */
const SHADED = "bg-surface-2";

/** A calendar event: a colour strip, its title, its time that day or "all day", and its source's name when several calendars are connected. Read-only. */
function EventCard({ event, showSource }: { event: EventRow; showSource: boolean }) {
  return (
    <li data-event={`${event.source}:${event.id}`} className="flex items-start gap-2 p-3">
      <Strip source={event.source} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-pretty break-words">{event.title}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-pretty text-text-2">
          <span className="tabular-nums">{event.time ?? t("calendarPage.allDay")}</span>
          {showSource && <span className="break-all">{event.source}</span>}
        </p>
      </div>
    </li>
  );
}

/** Week: the seven days as columns in one row (scrolling sideways inside the card on a narrow window); today's heading is circled, an unsynced day is shaded. */
function WeekDays({ label, days, today, showSource }: { label: string; days: readonly CalendarDay[]; today: string; showSource: boolean }) {
  return (
    <div className="overflow-x-auto">
    <ol aria-label={label} className="grid min-w-[56rem] grid-cols-7 gap-2">
      {days.map((d) => (
        <li key={d.date} data-day={d.date} {...(d.synced ? {} : { "data-not-synced": "" })} className={cn("min-w-0 space-y-1 rounded-control p-1", !d.synced && SHADED)}>
          <h3 className={SUB_TITLE}>
            <span {...(d.date === today ? { "data-today": "" } : {})} className={cn(d.date === today && TODAY_RING)}>{dayLabel(d.date)}</span>
          </h3>
          {d.synced && d.events.length > 0 && (
            <ul aria-label={dayLabel(d.date)} className="divide-y divide-border rounded-control border border-border">
              {d.events.map((e) => (
                <EventCard key={`${e.source}:${e.id}`} event={e} showSource={showSource} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
    </div>
  );
}

/** One month cell: the day's number (circled for today), then up to CELL_EVENTS events with a strip and "+N more"; an unsynced cell is shaded. */
function MonthCell({ day, today, showSource }: { day: CalendarDay; today: string; showSource: boolean }) {
  const shown = day.synced ? day.events.slice(0, CELL_EVENTS) : [];
  const more = day.synced ? day.events.length - shown.length : 0;
  return (
    <Td data-day={day.date} {...(day.synced ? {} : { "data-not-synced": "" })} className={cn("h-20 p-1", !day.synced && SHADED)}>
      <p className="text-xs font-medium tabular-nums">
        <span {...(day.date === today ? { "data-today": "" } : {})} className={cn(day.date === today && TODAY_RING)}>{Number(day.date.slice(8))}</span>
      </p>
      <ul className="space-y-0.5">
        {shown.map((e) => (
          <li key={`${e.source}:${e.id}`} data-event={`${e.source}:${e.id}`} title={`${e.time ?? t("calendarPage.allDay")} ${e.title}${showSource ? ` (${e.source})` : ""}`} className="flex items-center gap-1 text-xs">
            <Strip source={e.source} />
            <span className="truncate">
              {e.time !== null && <span className="tabular-nums text-text-2">{e.time} </span>}
              {e.title}
            </span>
          </li>
        ))}
        {more > 0 && <li className="text-xs text-text-2">{t("calendarPage.more", { n: more })}</li>}
      </ul>
    </Td>
  );
}

/** Month: a Monday-first grid of the month's days; the cells before its first and after its last day are empty. */
function MonthGrid({ label, days, today, showSource }: { label: string; days: readonly CalendarDay[]; today: string; showSource: boolean }) {
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
        <Tr key={i}>{week.map((day, j) => (day === null ? <Td key={`empty-${j}`} /> : <MonthCell key={day.date} day={day} today={today} showSource={showSource} />))}</Tr>
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
        <p key={c.source} data-calendar-stale={c.source} data-raw className="text-pretty break-words">
          {t("calendarPage.stale", { source: c.source, when: when(c.synced_at) })}
        </p>
      ))}
    </Notice>
  );
}

/** The unsynced days as short dates, a run of days as one range: "Nov 2 – 8, Nov 10". */
function unsyncedDays(days: readonly CalendarDay[]): string {
  const short = (date: string) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const runs: string[][] = [];
  let prev = "";
  for (const { date, synced } of days) {
    if (synced) { prev = ""; continue; }
    const last = runs.at(-1);
    if (last && prev !== "") last[1] = date;
    else runs.push([date, date]);
    prev = date;
  }
  return runs.map(([a, b]) => (a === b ? short(a!) : t("calendarPage.dayRange", { from: short(a!), to: short(b!) }))).join(", ");
}

/** The days on screen synced on request: the POST, then the read's `sync_pending` until the controller ran it. */
function useSyncDays(from: string, to: string, v: CalendarEvents | undefined, reread: () => unknown) {
  const token = useApi<Session>(API.session, false).data?.csrf_token;
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set at once on a press, so a second press before the next render sends nothing.
  const sending = useRef(false);
  const busy = posting || (v?.from === from && v.to === to && v.sync_pending);
  const sync = async () => {
    if (sending.current || busy || !token) return;
    sending.current = true;
    setPosting(true);
    setError(null);
    try {
      const r = await postCalendarSync(token, from, to);
      if (!r.ok) setError(r.error);
      await reread();
    } finally {
      sending.current = false;
      setPosting(false);
    }
  };
  return { busy, error, sync, ready: token !== undefined };
}

type SyncDays = ReturnType<typeof useSyncDays>;

/** A Sync button: its label, else "Syncing…" and disabled while the sync is pending. */
function SyncButton({ s, label }: { s: SyncDays; label: string }) {
  return (
    <Button disabled={s.busy || !s.ready} aria-busy={s.busy} onClick={() => void s.sync()}>
      {s.busy ? t("calendarPage.syncing") : label}
    </Button>
  );
}

function Events({ v, view, label, s }: { v: CalendarEvents; view: View; label: string; s: SyncDays }) {
  if (v.calendar.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("calendarPage.emptyNone")} action={<Link href={CONNECT_PATH} className={cn(LINK_CLASS, "text-sm")}>{t("calendarPage.connect")}</Link>} />;
  }
  const today = iso(new Date());
  const showSource = v.calendar.length > 1;
  return (
    <div className="space-y-3">
      <StaleCalendars calendar={v.calendar} />
      {s.error !== null && <Notice tone="bad">{s.error}</Notice>}
      {v.days.some((d) => !d.synced) && (
        <Notice tone="info">
          <div data-not-synced-note className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-pretty">{t("calendarPage.notSyncedDays", { days: unsyncedDays(v.days) })}</p>
            <SyncButton s={s} label={t("calendarPage.syncDays")} />
          </div>
        </Notice>
      )}
      {view === "week" ? <WeekDays label={label} days={v.days} today={today} showSource={showSource} /> : <MonthGrid label={label} days={v.days} today={today} showSource={showSource} />}
    </div>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [focus, setFocus] = useState(() => new Date());
  const shown = period(view, focus);
  const label = heading(view, shown);
  const q = useCalendarEvents(iso(shown.from), iso(shown.to));
  const v = q.data;
  const s = useSyncDays(iso(shown.from), iso(shown.to), v, q.refetch);
  return (
    <>
    <PageHeader title={t("page.calendar")} />
    <PageToolbar>
      {/* The page's controls (09-dashboard-tasks, Calendar): the view switch, the period buttons, then Sync, in one row. */}
      <div data-calendar-toolbar className="flex min-w-0 flex-wrap items-center gap-2">
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
        {v !== undefined && v.calendar.length > 0 && <SyncButton s={s} label={t("calendarPage.sync")} />}
      </div>
    </PageToolbar>
    {/* The period ("Nov 9 – 15, 2026") is the Card's h2, announced when it changes. */}
    <Card title={label} live>
      {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} /> : <Events v={v} view={view} label={label} s={s} />}
    </Card>
    </>
  );
}
