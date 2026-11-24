import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { API, type CalendarDay, type CalendarEvents, type CalendarSync, type EventRow, type Session, postCalendarSync, useApi, useCalendarEvents } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { EmptyState, Notice, PageHeader, PageToolbar } from "../components/ui/notice.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { CARD_TITLE, Card } from "../components/ui/card.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { MonthGrid, WeekDays } from "./calendar-grid.js";

// The Calendar page (design 09-dashboard-tasks-calendar): the stored calendar events of one week or one month,
// read-only, from GET /api/v1/calendar/events with the first and last day shown. One toolbar row holds the Week / Month
// switch, Previous / Today / Next (icon buttons round Today), the period ("Nov 23 – 29, 2026", the page's one h2) and a
// quiet Sync icon button at the end. The Card holds the week or month grid (calendar-grid.tsx) with no title of its own.
// Previous and next move by one week or month; Today returns to the period holding today in the browser's time zone.
// The month shows its whole weeks, the days outside it faint (read with them). Each event has a colour chosen from its source's name and names its source only when several calendars are
// connected. A day the last syncs did not cover is shaded, never drawn empty, and one note above the grid names those
// days; an empty synced day shows no text. A source whose last sync failed is named with its last sync time, and its
// stored events stay listed. A connected calendar that has not synced yet is named with "Not synced yet". The read
// lists the calendars the live `calendar` setting connects, as Settings → Integrations does; only with none connected
// the empty state links to the Integrations tab of Settings.
// Sync (shown once a calendar is connected) and the note's "Sync these days" post one request to sync every calendar
// for the days shown (POST /api/v1/calendar/sync); both show "Syncing…", disabled, until the request is done (the
// read's `sync_pending`), and a second press sends nothing.

const VIEWS = [
  { id: "week", label: t("calendarPage.week") },
  { id: "month", label: t("calendarPage.month") },
] as const;
type View = (typeof VIEWS)[number]["id"];

const CONNECT_PATH = `${BASE}settings?tab=integrations#calendar`;

const pad = (n: number) => String(n).padStart(2, "0");
/** A local date as `YYYY-MM-DD`. */
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const monthName = (d: Date, month: "short" | "long") => d.toLocaleDateString(undefined, { month });

/** The first and last day of `view` around `focus`: its Monday-to-Sunday week, or its month. */
function period(view: View, focus: Date): { from: Date; to: Date } {
  if (view === "week") return { from: monday(focus), to: addDays(monday(focus), 6) };
  return { from: new Date(focus.getFullYear(), focus.getMonth(), 1), to: new Date(focus.getFullYear(), focus.getMonth() + 1, 0) };
}

/** The days on screen: the week, or the month's whole weeks (Monday before its first day to Sunday after its last). */
function shownDays(view: View, p: { from: Date; to: Date }): { from: Date; to: Date } {
  return view === "week" ? p : { from: monday(p.from), to: addDays(monday(p.to), 6) };
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

/** The connected sources with no sync yet (none failed either): their days are unknown until the first sync. */
function UnsyncedCalendars({ unsynced }: { unsynced: readonly CalendarSync[] }) {
  if (unsynced.length === 0) return null;
  return (
    <Notice tone="info" title={t("calendar.neverSynced")}>
      {unsynced.map((c) => (
        <p key={c.source} data-calendar-unsynced={c.source} className="text-pretty break-words">
          {c.source}
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

/** The toolbar's quiet Sync: a ghost icon button named "Sync", else "Syncing…" with a turning icon, disabled while the sync is pending. */
function SyncIconButton({ s }: { s: SyncDays }) {
  const name = s.busy ? t("calendarPage.syncing") : t("calendarPage.sync");
  return (
    <Button variant="ghost" size="icon" aria-label={name} title={name} disabled={s.busy || !s.ready} aria-busy={s.busy} onClick={() => void s.sync()} className="text-text-2">
      <RefreshCw aria-hidden className={cn("size-4", s.busy && "motion-safe:animate-spin")} />
    </Button>
  );
}

function Events({ v, view, label, month, s }: { v: CalendarEvents; view: View; label: string; month: string; s: SyncDays }) {
  if (v.calendar.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("calendarPage.emptyNone")} action={<Link href={CONNECT_PATH} className={cn(LINK_CLASS, "text-sm")}>{t("calendarPage.connect")}</Link>} />;
  }
  const unsynced = v.calendar.filter((c) => c.synced_at === null && !c.failed);
  const today = iso(new Date());
  const showSource = v.calendar.length > 1;
  return (
    <div className="space-y-3">
      <StaleCalendars calendar={v.calendar} />
      <UnsyncedCalendars unsynced={unsynced} />
      {s.error !== null && <Notice tone="bad">{s.error}</Notice>}
      {unsynced.length === 0 && v.days.some((d) => !d.synced) && (
        <Notice tone="info">
          <div data-not-synced-note className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-pretty">{t("calendarPage.notSyncedDays", { days: unsyncedDays(v.days) })}</p>
            <SyncButton s={s} label={t("calendarPage.syncDays")} />
          </div>
        </Notice>
      )}
      {view === "week" ? <WeekDays label={label} days={v.days} today={today} showSource={showSource} /> : <MonthGrid key={month} label={label} days={v.days} today={today} showSource={showSource} month={month} />}
    </div>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [focus, setFocus] = useState(() => new Date());
  const label = heading(view, period(view, focus));
  const shown = shownDays(view, period(view, focus));
  const q = useCalendarEvents(iso(shown.from), iso(shown.to));
  const v = q.data;
  const s = useSyncDays(iso(shown.from), iso(shown.to), v, q.refetch);
  return (
    <>
    <PageHeader title={t("page.calendar")} />
    <PageToolbar>
      {/* One row (09-dashboard-tasks-calendar): the view switch, Previous / Today / Next, the period, then a quiet Sync at the end. */}
      <div data-calendar-toolbar className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl label={t("calendarPage.view")} options={VIEWS} value={view} onChange={setView} />
        <ButtonRow role="group" aria-label={t("calendarPage.period")} className="gap-1">
          <Button size="icon" aria-label={t(view === "week" ? "calendarPage.previousWeek" : "calendarPage.previousMonth")} title={t(view === "week" ? "calendarPage.previousWeek" : "calendarPage.previousMonth")} onClick={() => setFocus(step(view, focus, -1))}>
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <Button onClick={() => setFocus(new Date())}>{t("calendarPage.today")}</Button>
          <Button size="icon" aria-label={t(view === "week" ? "calendarPage.nextWeek" : "calendarPage.nextMonth")} title={t(view === "week" ? "calendarPage.nextWeek" : "calendarPage.nextMonth")} onClick={() => setFocus(step(view, focus, 1))}>
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </ButtonRow>
        {/* The period ("Nov 23 – 29, 2026"), the page's one h2, announced when it changes. */}
        <h2 aria-live="polite" className={cn(CARD_TITLE, "min-w-0 tabular-nums")}>{label}</h2>
        {v !== undefined && v.calendar.length > 0 && <span className="ml-auto"><SyncIconButton s={s} /></span>}
      </div>
    </PageToolbar>
    {/* The week or month, named by the period for assistive tech; the toolbar holds its visible title. */}
    <Card label={label}>
      {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={3} label="loading.calendar" onRetry={() => void q.refetch()} /> : <Events v={v} view={view} label={label} month={iso(focus).slice(0, 7)} s={s} />}
    </Card>
    </>
  );
}
