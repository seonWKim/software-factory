import type { CalendarDay, CalendarEvent } from "../api.js";
import { SUB_TITLE } from "../components/ui/card.js";
import { CHIP_TITLE } from "../components/ui/popover.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { EventButton, Strip } from "./calendar-event.js";
import { dayLabel } from "./tasks/groups.js";

// The Calendar page's week and month (design 09-dashboard-tasks-calendar): plain grids inside the page's one Card,
// split by 1px `border` lines, with no box of their own and no card inside the card. Read-only; each event is a button
// that opens its whole details (calendar-event.tsx).

/** The events a month cell lists before "+N more". */
const CELL_EVENTS = 3;

/** Today's date number: a small filled circle in the ink colour (neutral, never accent), as a macOS calendar marks it. */
const TODAY_DOT = "inline-flex size-6 items-center justify-center rounded-pill bg-text-1 text-bg";
/** The shading of a day the last syncs did not cover. */
const SHADED = "bg-surface-2";

const weekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
};
const todayMark = (date: string, today: string) => (date === today ? { "data-today": "" } : {});

interface GridProps {
  label: string;
  days: readonly CalendarDay[];
  today: string;
  showSource: boolean;
}

/**
 * A compact event chip on `surface-2`, a button that opens the event's details: a colour strip, then its time first
 * ("all day" else, and its source when several calendars are connected), then its title cut at 2 lines.
 */
function EventChip({ event, showSource }: { event: CalendarEvent; showSource: boolean }) {
  return (
    <li className="min-w-0">
      <EventButton event={event} showSource={showSource} className="gap-1.5 bg-surface-2 px-1.5 py-1 hover:bg-border aria-expanded:bg-border">
        <Strip source={event.source} />
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-xs text-text-2">
            <span className="tabular-nums">{event.time ?? t("calendarPage.allDay")}</span>
            {showSource && <span data-raw> · {event.source}</span>}
          </span>
          <span data-raw className={cn(CHIP_TITLE, "text-xs font-medium text-text-1")}>{event.title}</span>
        </span>
      </EventButton>
    </li>
  );
}

/**
 * Week: Monday to Sunday as seven flexible columns split by 1px lines from `xl` up, so the week fits the card with no
 * sideways scroll; below `xl` the days stack as a list, one under the other. A day's heading is its weekday and date
 * number (today's on the ink dot); an unsynced day is shaded.
 */
export function WeekDays({ label, days, today, showSource }: GridProps) {
  return (
    <ol aria-label={label} className="grid grid-cols-1 divide-y divide-border xl:grid-cols-7 xl:divide-x xl:divide-y-0">
      {days.map((d) => (
        <li
          key={d.date}
          data-day={d.date}
          {...(d.synced ? {} : { "data-not-synced": "" })}
          className={cn("flex min-w-0 flex-col gap-2 px-2 py-3 xl:min-h-48 xl:py-1", !d.synced && SHADED)}
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
          <li key={`${e.source}:${e.id}`} className="min-w-0">
            <EventButton event={e} showSource={showSource} className="items-center gap-1 px-0.5 text-xs hover:bg-surface-2 aria-expanded:bg-surface-2">
              {/* Below sm the strip is a short horizontal bar across the cell, the event's only visible mark. */}
              <Strip source={e.source} className="max-sm:h-1 max-sm:w-full max-sm:self-auto sm:h-4" />
              <span className="truncate max-sm:sr-only">
                {e.time !== null && <span className="tabular-nums text-text-2">{e.time} </span>}
                <span data-raw>{e.title}</span>
              </span>
            </EventButton>
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
