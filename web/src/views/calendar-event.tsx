import { AlignLeft, CalendarDays, Clock, ExternalLink, MapPin, Users, Video } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { CalendarEvent, EventDetails, EventPerson } from "../api.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ChipButton, Popover } from "../components/ui/popover.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { linkParts, plainText } from "../lib/plain-text.js";

// One Calendar page event as a button and its details (design 09-dashboard-tasks-calendar, event details, 2026-11-24):
// pressing an event chip (Week or Month) opens a Popover beside it (a sheet below `sm`) with the whole event: its full
// title, the date and time range (or all day) with the time zone, its calendar, place, meeting link, people, notes and
// a link to the event's own page. Every text is shown as text: notes written as HTML are turned into plain text with
// their http(s) addresses as links (lib/plain-text.ts), never put on the page as HTML.

/** The existing token colours an event's strip is chosen from, by its source's name. */
const STRIPS = ["bg-kind-triage", "bg-kind-implement", "bg-kind-review", "bg-kind-resolve", "bg-kind-merge-check"] as const;
/** A source's strip colour: a stable hash of its name, so the same source keeps its colour across reads. */
function stripFor(source: string): string {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STRIPS[h % STRIPS.length]!;
}
export const Strip = ({ source, className }: { source: string; className?: string }) => (
  <span aria-hidden data-strip className={cn("w-1 shrink-0 self-stretch rounded-pill", stripFor(source), className)} />
);

/** An event's name in its button and its panel's heading; an event with no title says so. */
const titleOf = (e: CalendarEvent) => (e.title.trim() === "" ? t("calendarPage.untitled") : e.title);

/**
 * An event chip as a button (ChipButton) that opens its details in a Popover; pressing it again, Esc or the close
 * button closes them and focus returns to it. `children` is what the chip shows.
 */
export function EventButton({ event, showSource, className, children }: { event: CalendarEvent; showSource: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ChipButton ref={ref} open={open} data-event={`${event.source}:${event.id}`} data-capture-open="calendar-event" onClick={() => setOpen((o) => !o)} className={className}>
        {children}
      </ChipButton>
      {open && (
        <Popover anchor={ref} title={titleOf(event)} onClose={() => setOpen(false)}>
          <EventDetail event={event} showSource={showSource} />
        </Popover>
      )}
    </>
  );
}

/** Text with its http(s) addresses as links that open in a new tab; the rest stays plain text. */
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((p, i) =>
        "url" in p ? (
          <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className={cn(LINK_CLASS, "wrap-anywhere")}>
            {p.url}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const DAY = { weekday: "long", month: "long", day: "numeric", year: "numeric" } as const;
const TIME = { hour: "numeric", minute: "2-digit" } as const;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** `a` to `b` in one format, the shared parts written once ("5:00 – 6:00 PM"). */
const range = (opts: Intl.DateTimeFormatOptions, a: Date, b: Date) => new Intl.DateTimeFormat(undefined, opts).formatRange(a, b);

/**
 * The event's day and time in the viewer's time zone: an all-day event as its day (or days) and "All day"; a timed one
 * as its day and its time range with the zone's short name, or one range when it ends on a later day.
 */
export function eventWhen(e: Pick<CalendarEvent, "starts_at" | "ends_at" | "all_day">): { day: string; time: string } {
  const start = new Date(e.starts_at);
  const end = new Date(e.ends_at);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (e.all_day) {
    // An all-day event ends at the midnight after its last day.
    const last = new Date(Math.max(start.getTime(), end.getTime() - 1));
    return { day: sameDay(start, last) ? start.toLocaleDateString(undefined, DAY) : range(DAY, start, last), time: t("calendarPage.eventAllDay") };
  }
  const zone = { ...TIME, timeZoneName: "short" } as const;
  if (sameDay(start, end) || end.getTime() - start.getTime() <= 0) return { day: start.toLocaleDateString(undefined, DAY), time: range(zone, start, end) };
  return { day: range({ ...DAY, ...zone }, start, end), time: "" };
}

const RESPONSE: Readonly<Record<NonNullable<EventPerson["response"]>, string>> = {
  accepted: t("calendarPage.eventGoing"),
  declined: t("calendarPage.eventNotGoing"),
  tentative: t("calendarPage.eventMaybe"),
  waiting: t("calendarPage.eventNoAnswer"),
};

/** One row of the details: a quiet icon (the term, named for screen readers), then its content. */
function Row({ icon: Icon, term, children, ...rest }: { icon: typeof Clock; term: string; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div {...rest} className="flex gap-3">
      <dt className="mt-0.5 shrink-0">
        <Icon aria-hidden className="size-4 text-text-3" />
        <span className="sr-only">{term}</span>
      </dt>
      <dd className="min-w-0 flex-1 space-y-0.5 wrap-anywhere">{children}</dd>
    </div>
  );
}

/** A person's line: their name (else address), their address under it, and their answer; the organizer marked. */
function Person({ p, organizer }: { p: EventPerson; organizer: boolean }) {
  const name = p.name ?? p.email ?? "";
  const note = [organizer ? t("calendarPage.eventOrganizer") : null, p.response ? RESPONSE[p.response] : null].filter(Boolean).join(" · ");
  return (
    <li data-person className="min-w-0">
      <p data-raw className="wrap-anywhere">{name}</p>
      {(p.name !== null && p.email !== null) || note !== "" ? (
        <p className="text-xs text-text-2 wrap-anywhere">
          {p.name !== null && p.email !== null && <span data-raw>{p.email}</span>}
          {p.name !== null && p.email !== null && note !== "" && " · "}
          {note}
        </p>
      ) : null}
    </li>
  );
}

/** The organizer first, then every other attendee (the organizer is not listed twice). */
function people(d: EventDetails): { p: EventPerson; organizer: boolean }[] {
  const org = d.organizer;
  const same = (a: EventPerson) => org !== null && a.email !== null && a.email === org.email;
  const fromList = org === null ? undefined : d.attendees.find(same);
  return [...(org === null ? [] : [{ p: fromList ?? org, organizer: true }]), ...d.attendees.filter((a) => !same(a)).map((p) => ({ p, organizer: false }))];
}

/** The label of the event's own page: Google Calendar's by its address, else a plain "Open in calendar". */
function openLabel(link: string): string {
  try {
    return new URL(link).hostname.endsWith("google.com") ? t("calendarPage.eventOpenGoogle") : t("calendarPage.eventOpen");
  } catch {
    return t("calendarPage.eventOpen");
  }
}

/** The event's details, row by row; rows the event has nothing for are left out. */
export function EventDetail({ event, showSource }: { event: CalendarEvent; showSource: boolean }) {
  const d = event.details;
  const when = eventWhen(event);
  const zone = d?.time_zone && !event.all_day && d.time_zone !== browserZone() ? d.time_zone : null;
  const calendar = d?.calendar ?? event.source;
  const notes = d?.description ? plainText(d.description) : "";
  const guests = d ? people(d) : [];
  return (
    <div data-event-detail className="space-y-3">
      <dl className="space-y-3">
        <Row icon={Clock} term={t("calendarPage.eventWhen")} data-event-when="">
          <p>{when.day}</p>
          {when.time !== "" && <p className="text-text-2 tabular-nums">{when.time}</p>}
          {zone !== null && <p className="text-xs text-text-2">{t("calendarPage.eventZone", { zone })}</p>}
        </Row>
        <Row icon={CalendarDays} term={t("calendarPage.eventCalendar")}>
          <p className="flex items-center gap-2">
            <span aria-hidden data-strip className={cn("size-2 shrink-0 rounded-pill", stripFor(event.source))} />
            <span data-raw className="min-w-0 wrap-anywhere">{calendar}</span>
          </p>
          {showSource && calendar !== event.source && <p data-raw className="text-xs text-text-2">{event.source}</p>}
        </Row>
        {d?.location && (
          <Row icon={MapPin} term={t("calendarPage.eventLocation")} data-event-location="">
            <p data-raw><LinkedText text={d.location} /></p>
          </Row>
        )}
        {d?.conference_url && (
          <Row icon={Video} term={t("calendarPage.eventMeeting")}>
            <a href={d.conference_url} target="_blank" rel="noopener noreferrer" data-event-meeting className={LINK_CLASS}>
              {t("calendarPage.eventJoin")}
            </a>
            <p data-raw className="text-xs text-text-2 wrap-anywhere">{d.conference_url}</p>
          </Row>
        )}
        {guests.length > 0 && (
          <Row icon={Users} term={t("calendarPage.eventPeople")}>
            <p className="text-xs text-text-2">{t(guests.length === 1 ? "calendarPage.eventGuest" : "calendarPage.eventGuests", { n: guests.length })}</p>
            <ul className="space-y-1.5 pt-1">
              {guests.map((g, i) => (
                <Person key={`${g.p.email ?? g.p.name ?? ""}:${i}`} p={g.p} organizer={g.organizer} />
              ))}
            </ul>
          </Row>
        )}
        {notes !== "" && (
          <Row icon={AlignLeft} term={t("calendarPage.eventNotes")}>
            <p data-raw data-event-notes className="whitespace-pre-wrap">
              <LinkedText text={notes} />
            </p>
          </Row>
        )}
      </dl>
      {d?.link && (
        <p className="border-t border-border pt-3">
          <a href={d.link} target="_blank" rel="noopener noreferrer" data-event-link className={cn(LINK_CLASS, "inline-flex min-h-6 items-center gap-1.5")}>
            {openLabel(d.link)}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </p>
      )}
    </div>
  );
}
