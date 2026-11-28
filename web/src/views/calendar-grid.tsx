import { type MouseEvent, useContext, useRef, useState } from "react";
import type { CalendarDay, CalendarEvent } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { SUB_TITLE } from "../components/ui/card.js";
import { useWide } from "../components/ui/parts.js";
import { CHIP_TITLE, ChipButton, Popover } from "../components/ui/popover.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { CalendarActionsContext, EventButton, colourOf, titleOf } from "./calendar-event.js";
import { dayLabel } from "./tasks/groups.js";

// The Calendar page's week and month (design 09-dashboard-tasks-calendar): plain grids inside the page's one Card,
// split by 1px `border` lines, with no box of their own and no card inside the card, drawn like macOS Calendar.
// Each event is a chip that opens its whole details (calendar-event.tsx). An all-day event is a filled pill
// in its calendar's colour; a timed one is a dot in that colour, its time in muted text, then its title.

/** The event rows a month cell has room for: all its events up to this many, else one less and "+N more". */
export const MONTH_SLOTS = 3;

/** How many of a month cell's `n` events it shows, and how many "+N more" names: every cell is the same height. */
export function monthFit(n: number): { shown: number; more: number } {
  return n <= MONTH_SLOTS ? { shown: n, more: 0 } : { shown: MONTH_SLOTS - 1, more: n - (MONTH_SLOTS - 1) };
}

/**
 * A day's click handler: a press on its empty area (not on an event, a button or a link, and not inside a panel opened
 * from it, which React still bubbles here) opens the New event dialog for that day. Undefined without the page's actions.
 */
function useDayClick(date: string): ((e: MouseEvent<HTMLElement>) => void) | undefined {
  const actions = useContext(CalendarActionsContext);
  if (actions === null) return undefined;
  return (e) => {
    const target = e.target as Element;
    if (e.currentTarget.contains(target) && !target.closest("button, a")) actions.newOn(date);
  };
}

/** The shading of a day the last syncs did not cover. */
const SHADED = "bg-surface-2";

const parse = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
const weekday = (date: string) => parse(date).toLocaleDateString(undefined, { weekday: "short" });
const weekend = (date: string) => [0, 6].includes(parse(date).getDay());

interface GridProps {
  label: string;
  days: readonly CalendarDay[];
  today: string;
  showSource: boolean;
}

/**
 * A day's number: 24px, centred; today's on a filled circle in the ink colour (neutral, never accent, `data-today`),
 * as macOS Calendar marks it. A weekend day's is muted (`text-2`), a day outside the month's faint (`text-3`).
 */
function DayNumber({ date, today, outside = false }: { date: string; today: string; outside?: boolean }) {
  const isToday = date === today;
  return (
    <span
      aria-hidden
      {...(isToday ? { "data-today": "" } : {})}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-sm font-semibold tabular-nums",
        isToday ? "bg-text-1 text-bg" : outside ? "text-text-3" : weekend(date) ? "text-text-2" : "text-text-1",
      )}
    >
      {Number(date.slice(8))}
    </span>
  );
}

/** The dot of an agent entry in the compact month: the Badge's info tone. */
const AGENT_DOT = "bg-current text-pill-info-fg";

/**
 * An agent entry (a schedule's run or next slot) as a chip: the time, the Badge (level info) and the title, with the
 * "Next run" label on the next slot. It opens the same details as any chip, which offer no Edit and no Delete.
 */
function AgentChip({ event, showSource, wrap }: { event: CalendarEvent; showSource: boolean; wrap: boolean }) {
  return (
    <EventButton event={event} showSource={showSource} className={cn("gap-1.5 px-1.5 text-xs hover:bg-surface-2 aria-expanded:bg-surface-2", wrap ? "items-start py-1" : "items-center")}>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-text-2">
          <span className={cn("tabular-nums", !wrap && "max-lg:sr-only")}>{event.time}</span>
          <Badge level="info">{t("calendarPage.agentBadge")}</Badge>
          {event.next === true && <span className="truncate">{t("calendarPage.nextRun")}</span>}
        </span>
        <span data-raw className={cn(wrap ? CHIP_TITLE : "block truncate", "font-medium text-text-1")}>{titleOf(event)}</span>
      </span>
    </EventButton>
  );
}

/**
 * One event as a chip that opens its details. All day: a filled pill in its calendar's colour (`text-surface` on it
 * reads in both themes). Timed: a dot in that colour, the time in muted text, then the title. `wrap` (Week, a day's
 * list) cuts the title at 2 lines under the time; else (Month) it is one line cut with an ellipsis.
 */
function EventChip({ event, showSource, wrap = false }: { event: CalendarEvent; showSource: boolean; wrap?: boolean }) {
  if (event.kind === "agent") return <AgentChip event={event} showSource={showSource} wrap={wrap} />;
  const colour = colourOf(event.source);
  const source = showSource ? <span data-raw> · {event.source}</span> : null;
  if (event.all_day) {
    return (
      <EventButton event={event} showSource={showSource} className={cn("items-center px-1.5 text-xs font-medium text-surface hover:brightness-95 aria-expanded:brightness-90", wrap && "py-1", colour)}>
        <span className={cn("min-w-0", wrap ? CHIP_TITLE : "truncate")}>
          <span data-raw>{titleOf(event)}</span>
          {wrap && source}
        </span>
      </EventButton>
    );
  }
  return (
    <EventButton event={event} showSource={showSource} className={cn("gap-1.5 px-1.5 text-xs hover:bg-surface-2 aria-expanded:bg-surface-2", wrap ? "items-start py-1" : "items-center")}>
      <span aria-hidden data-colour className={cn("size-1.5 shrink-0 rounded-pill", wrap && "mt-1", colour)} />
      {wrap ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-text-2">
            <span className="tabular-nums">{event.time}</span>
            {source}
          </span>
          <span data-raw className={cn(CHIP_TITLE, "font-medium text-text-1")}>{titleOf(event)}</span>
        </span>
      ) : (
        <>
          {/* A narrow cell (below lg) keeps its room for the title; the time is in the chip's name and its details. */}
          <span className="shrink-0 text-text-2 tabular-nums max-lg:sr-only">{event.time}</span>
          <span data-raw className="min-w-0 flex-1 truncate text-text-1">{titleOf(event)}</span>
        </>
      )}
    </EventButton>
  );
}

/** A day's events as a list of chips, 2px apart. */
function EventList({ events, label, showSource, wrap, className }: { events: readonly CalendarEvent[]; label: string; showSource: boolean; wrap?: boolean; className?: string }) {
  return (
    <ul aria-label={label} className={cn("min-w-0 space-y-0.5", className)}>
      {events.map((e) => (
        <li key={`${e.source}:${e.id}`} className="min-w-0">
          <EventChip event={e} showSource={showSource} wrap={wrap === true} />
        </li>
      ))}
    </ul>
  );
}

/** One day of the Week: its heading and events; a click on its empty area opens New event for it. */
function WeekDay({ d, today, showSource }: { d: CalendarDay; today: string; showSource: boolean }) {
  const onClick = useDayClick(d.date);
  return (
    <li
      data-day={d.date}
      {...(d.synced ? {} : { "data-not-synced": "" })}
      {...(onClick ? { onClick } : {})}
      className={cn("grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 px-2 py-2 xl:flex xl:min-h-48 xl:flex-col xl:gap-2 xl:px-1.5", !d.synced && SHADED)}
    >
      <h3 className={cn(SUB_TITLE, "flex flex-col items-center gap-0.5 xl:flex-row xl:gap-1.5 xl:px-1.5")}>
        <span className="sr-only">{dayLabel(d.date)}</span>
        <span aria-hidden className={cn(weekend(d.date) && "text-text-3")}>{weekday(d.date)}</span>
        <DayNumber date={d.date} today={today} />
      </h3>
      {d.synced && d.events.length > 0 && <EventList events={d.events} label={dayLabel(d.date)} showSource={showSource} wrap className="xl:w-full" />}
    </li>
  );
}

/**
 * Week: Monday to Sunday as seven columns split by 1px lines from `xl` up, so the week fits the card with no sideways
 * scroll, each a heading (weekday and number) over its events; below `xl` one row per day, the weekday over the number
 * in a narrow column at the left and the events beside it, so every day's events start on one line. An unsynced day
 * is shaded.
 */
export function WeekDays({ label, days, today, showSource }: GridProps) {
  return (
    <ol aria-label={label} className="grid grid-cols-1 divide-y divide-border xl:grid-cols-7 xl:divide-x xl:divide-y-0">
      {days.map((d) => (
        <WeekDay key={d.date} d={d} today={today} showSource={showSource} />
      ))}
    </ol>
  );
}

/** "+N more" in a month cell: a chip that opens the day's whole list in a Popover, each event opening its details over it. */
function MoreButton({ day, more, showSource }: { day: CalendarDay; more: number; showSource: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const name = dayLabel(day.date);
  return (
    <>
      <ChipButton ref={ref} open={open} data-more={day.date} aria-label={t("calendarPage.moreOn", { n: more, day: name })} onClick={() => setOpen((o) => !o)} className="items-center px-1.5 text-xs font-medium text-text-2 hover:bg-surface-2 hover:text-text-1 aria-expanded:bg-surface-2">
        {t("calendarPage.more", { n: more })}
      </ChipButton>
      {open && (
        <Popover anchor={ref} title={parse(day.date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} onClose={() => setOpen(false)}>
          <EventList events={day.events} label={name} showSource={showSource} wrap />
        </Popover>
      )}
    </>
  );
}

/**
 * One month cell from `sm` up, every cell the same height: the day's number at the top right, then its events, all of
 * them up to MONTH_SLOTS rows, else one less and "+N more" (monthFit). A day outside the month is faint; an unsynced
 * cell is shaded.
 */
function MonthCell({ day, today, outside, showSource }: { day: CalendarDay; today: string; outside: boolean; showSource: boolean }) {
  const events = day.synced ? day.events : [];
  const { shown, more } = monthFit(events.length);
  const onClick = useDayClick(day.date);
  return (
    <div
      role="cell"
      data-day={day.date}
      {...(onClick ? { onClick } : {})}
      {...(day.synced ? {} : { "data-not-synced": "" })}
      {...(outside ? { "data-outside": "" } : {})}
      className={cn("flex h-28 min-w-0 flex-col gap-0.5 overflow-hidden p-1", !day.synced && SHADED)}
    >
      <p className="flex justify-end">
        <span className="sr-only">{dayLabel(day.date)}</span>
        <DayNumber date={day.date} today={today} outside={outside} />
      </p>
      {shown > 0 && <EventList events={events.slice(0, shown)} label={dayLabel(day.date)} showSource={showSource} />}
      {more > 0 && <MoreButton day={day} more={more} showSource={showSource} />}
    </div>
  );
}

/**
 * One month cell below `sm`: a button that selects the day, its number over up to three dots in its events' colours;
 * the selected day's list shows under the grid.
 */
function CompactCell({ day, today, outside, selected, onSelect }: { day: CalendarDay; today: string; outside: boolean; selected: boolean; onSelect: () => void }) {
  const events = day.synced ? day.events : [];
  const n = events.length;
  const name = t(n === 0 ? "calendarPage.dayNone" : n === 1 ? "calendarPage.dayOne" : "calendarPage.dayMany", { day: dayLabel(day.date), n });
  return (
    <div role="cell" data-day={day.date} {...(day.synced ? {} : { "data-not-synced": "" })} {...(outside ? { "data-outside": "" } : {})} className={cn("min-w-0 p-0.5", !day.synced && SHADED)}>
      <ChipButton
        open={false}
        aria-haspopup={undefined}
        aria-expanded={undefined}
        aria-pressed={selected}
        aria-label={name}
        onClick={onSelect}
        className={cn("h-11 flex-col items-center justify-start gap-0.5 pt-1", selected ? "bg-surface-2" : "hover:bg-surface-2")}
      >
        <DayNumber date={day.date} today={today} outside={outside} />
        <span aria-hidden className="flex h-1.5 gap-0.5">
          {events.slice(0, 3).map((e) => (
            <span key={`${e.source}:${e.id}`} data-colour className={cn("size-1.5 rounded-pill", e.kind === "agent" ? AGENT_DOT : colourOf(e.source))} />
          ))}
        </span>
      </ChipButton>
    </div>
  );
}

/**
 * Month: a Monday-first `role=table` grid of whole weeks, 7 columns split by 1px lines, the days before and after the
 * month (`month`, "YYYY-MM") faint. From `sm` up each cell lists its events (MonthCell); below `sm` the grid is compact
 * (CompactCell: numbers and dots) and the selected day's events list under it, today's on load when shown.
 */
export function MonthGrid({ label, days, today, showSource, month }: GridProps & { month: string }) {
  const wide = useWide();
  const [picked, setPicked] = useState<string | null>(null);
  if (days.length === 0) return null;
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => days.slice(w * 7, w * 7 + 7));
  const outside = (d: CalendarDay) => !d.date.startsWith(month);
  const selected = days.find((d) => d.date === picked) ?? days.find((d) => d.date === today) ?? days.find((d) => !outside(d))!;
  // 2024-01-01 is a Monday: the column heads in the viewer's locale.
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
  const row = "grid grid-cols-7 divide-x divide-border";
  return (
    <div className="space-y-3">
      <div role="table" aria-label={label} className="divide-y divide-border">
        <div role="row" className={row}>
          {weekdays.map((w, i) => (
            <span key={w} role="columnheader" className={cn("truncate px-1 pb-1 text-xs font-medium sm:text-right sm:px-2", i >= 5 ? "text-text-3" : "text-text-2")}>{w}</span>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={week[0]!.date} className={row}>
            {week.map((day) =>
              wide ? (
                <MonthCell key={day.date} day={day} today={today} outside={outside(day)} showSource={showSource} />
              ) : (
                <CompactCell key={day.date} day={day} today={today} outside={outside(day)} selected={day.date === selected.date} onSelect={() => setPicked(day.date)} />
              ),
            )}
          </div>
        ))}
      </div>
      {!wide && (
        <section data-selected-day={selected.date} aria-label={dayLabel(selected.date)} className="space-y-1.5 border-t border-border pt-3">
          <h3 className={SUB_TITLE}>{parse(selected.date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
          {selected.synced && selected.events.length > 0 ? (
            <EventList events={selected.events} label={dayLabel(selected.date)} showSource={showSource} wrap />
          ) : (
            <p className="text-sm text-text-2">{t(selected.synced ? "calendarPage.noEvents" : "calendarPage.dayNotSynced")}</p>
          )}
        </section>
      )}
    </div>
  );
}
