import type { CalendarDay, EventRow } from "../api.js";
import { Clamp } from "../components/ui/clamp.js";
import { SUB_TITLE } from "../components/ui/card.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { dayLabel } from "./tasks/groups.js";

// The Calendar page's week and month (design 09-dashboard-tasks-calendar): plain grids inside the page's one Card,
// split by 1px `border` lines, with no box of their own and no card inside the card. Read-only.

/** The events a month cell lists before "+N more". */
const CELL_EVENTS = 3;

/** The existing token colours an event's strip is chosen from, by its source's name. */
const STRIPS = ["bg-kind-triage", "bg-kind-implement", "bg-kind-review", "bg-kind-resolve", "bg-kind-merge-check"] as const;
/** A source's strip colour: a stable hash of its name, so the same source keeps its colour across reads. */
function stripFor(source: string): string {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STRIPS[h % STRIPS.length]!;
}
const Strip = ({ source, className }: { source: string; className?: string }) => (
  <span aria-hidden data-strip className={cn("w-1 shrink-0 self-stretch rounded-pill", stripFor(source), className)} />
);

/** Today's date number: a small filled circle in the ink colour (neutral, never accent), as a macOS calendar marks it. */
const TODAY_DOT = "inline-flex size-6 items-center justify-center rounded-pill bg-text-1 text-bg";
/** The shading of a day the last syncs did not cover. */
const SHADED = "bg-surface-2";

const weekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
};
const todayMark = (date: string, today: string) => (date === today ? { "data-today": "" } : {});
/** An event's full text for its tooltip: time, title and, with several calendars, its source. */
const fullText = (e: EventRow, showSource: boolean) => `${e.time ?? t("calendarPage.allDay")} ${e.title}${showSource ? ` (${e.source})` : ""}`;

interface GridProps {
  label: string;
  days: readonly CalendarDay[];
  today: string;
  showSource: boolean;
}

/**
 * A compact event chip on `surface-2`: a colour strip, then its time first ("all day" else, and its source when several
 * calendars are connected), then its title cut at 2 lines; the full text is its tooltip.
 */
function EventChip({ event, showSource }: { event: EventRow; showSource: boolean }) {
  return (
    <li data-event={`${event.source}:${event.id}`} title={fullText(event, showSource)} className="flex min-w-0 gap-1.5 rounded-control bg-surface-2 px-1.5 py-1">
      <Strip source={event.source} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-text-2">
          <span className="tabular-nums">{event.time ?? t("calendarPage.allDay")}</span>
          {showSource && <span data-raw> · {event.source}</span>}
        </p>
        <Clamp className="text-xs font-medium break-words text-text-1">{event.title}</Clamp>
      </div>
    </li>
  );
}

/**
 * Week: Monday to Sunday as seven flexible columns split by 1px lines from `lg` up, so the week fits the card with no
 * sideways scroll; below `lg` the days stack as a list, one under the other. A day's heading is its weekday and date
 * number (today's on the ink dot); an unsynced day is shaded.
 */
export function WeekDays({ label, days, today, showSource }: GridProps) {
  return (
    <ol aria-label={label} className="grid grid-cols-1 divide-y divide-border lg:grid-cols-7 lg:divide-x lg:divide-y-0">
      {days.map((d) => (
        <li
          key={d.date}
          data-day={d.date}
          {...(d.synced ? {} : { "data-not-synced": "" })}
          className={cn("flex min-w-0 flex-col gap-2 px-2 py-3 lg:min-h-48 lg:py-1", !d.synced && SHADED)}
        >
          <h3 className={cn(SUB_TITLE, "flex items-center gap-1.5")}>
            <span className="sr-only">{dayLabel(d.date)}</span>
            <span aria-hidden>{weekday(d.date)}</span>
            <span aria-hidden {...todayMark(d.date, today)} className={cn("inline-flex size-6 items-center justify-center text-sm font-semibold tabular-nums", d.date === today ? TODAY_DOT : "-mx-1 text-text-1")}>
              {Number(d.date.slice(8))}
            </span>
          </h3>
          {d.synced && d.events.length > 0 && (
            <ul aria-label={dayLabel(d.date)} className="space-y-1">
              {d.events.map((e) => (
                <EventChip key={`${e.source}:${e.id}`} event={e} showSource={showSource} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * One month cell: the day's number (today's on the ink dot), then up to CELL_EVENTS one-line events and "+N more"; an
 * unsynced cell is shaded. Below `sm` an event shows only its strip (its text stays for screen readers and its tooltip).
 */
function MonthCell({ day, today, showSource }: { day: CalendarDay; today: string; showSource: boolean }) {
  const shown = day.synced ? day.events.slice(0, CELL_EVENTS) : [];
  const more = day.synced ? day.events.length - shown.length : 0;
  return (
    <div role="cell" data-day={day.date} {...(day.synced ? {} : { "data-not-synced": "" })} className={cn("min-h-16 min-w-0 space-y-1 p-1 sm:min-h-24 sm:p-1.5", !day.synced && SHADED)}>
      <p className="text-xs font-medium tabular-nums">
        <span {...todayMark(day.date, today)} className={cn("inline-flex size-6 items-center justify-center", day.date === today && TODAY_DOT)}>{Number(day.date.slice(8))}</span>
      </p>
      <ul className="space-y-0.5">
        {shown.map((e) => (
          <li key={`${e.source}:${e.id}`} data-event={`${e.source}:${e.id}`} title={fullText(e, showSource)} className="flex min-w-0 items-center gap-1 text-xs sm:h-4">
            {/* Below sm the strip is a short horizontal bar across the cell, the event's only visible mark. */}
            <Strip source={e.source} className="max-sm:h-1 max-sm:w-full max-sm:self-auto" />
            <span className="truncate max-sm:sr-only">
              {e.time !== null && <span className="tabular-nums text-text-2">{e.time} </span>}
              {e.title}
            </span>
          </li>
        ))}
        {more > 0 && <li className="truncate text-xs text-text-2">{t("calendarPage.more", { n: more })}</li>}
      </ul>
    </div>
  );
}

/** Month: a Monday-first grid of the month, 7 flexible columns split by 1px lines; the cells before its first and after its last day are empty. */
export function MonthGrid({ label, days, today, showSource }: GridProps) {
  const first = days[0];
  if (!first) return null;
  const [y, m, d] = first.date.split("-").map(Number) as [number, number, number];
  const lead = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  // 2024-01-01 is a Monday: the column heads in the viewer's locale.
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
  const row = "grid grid-cols-7 divide-x divide-border";
  return (
    <div role="table" aria-label={label} className="divide-y divide-border">
      <div role="row" className={row}>
        {weekdays.map((w) => (
          <span key={w} role="columnheader" className="truncate px-1 pb-1 text-xs font-medium text-text-2 sm:px-1.5">{w}</span>
        ))}
      </div>
      {weeks.map((week, i) => (
        <div role="row" key={i} className={row}>
          {week.map((day, j) => (day === null ? <div role="cell" key={`empty-${j}`} /> : <MonthCell key={day.date} day={day} today={today} showSource={showSource} />))}
        </div>
      ))}
    </div>
  );
}
