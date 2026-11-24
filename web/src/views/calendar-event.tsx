import { AlignLeft, CalendarDays, Clock, ExternalLink, MapPin, Users, Video } from "lucide-react";
import { type ReactNode, createContext, useContext, useRef, useState } from "react";
import { API, type CalendarEvent, type EventDetails, type EventPerson, LOCAL_SOURCE, type Session, postLocalEventDelete, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog } from "../components/ui/dialog.js";
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

/** The existing token colours an event's calendar colour is chosen from, by its source's name. */
const COLOURS = ["bg-kind-triage", "bg-kind-implement", "bg-kind-review", "bg-kind-resolve", "bg-kind-merge-check"] as const;
/** A source's colour (a `bg-kind-*` class): a stable hash of its name, so the same source keeps its colour across reads. */
export function colourOf(source: string): string {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length]!;
}

/** An event's name in its button and its panel's heading; an event with no title says so. */
export const titleOf = (e: CalendarEvent) => (e.title.trim() === "" ? t("calendarPage.untitled") : e.title);

/** What the Calendar page lets its grids and event details do: open the New event dialog for a day, edit an event, re-read. */
export interface CalendarActions {
  newOn(date: string): void;
  edit(event: CalendarEvent): void;
  refetch(): Promise<unknown>;
}
/** Provided by the page (calendar.tsx); with none (a grid shown alone) events are read-only. */
export const CalendarActionsContext = createContext<CalendarActions | null>(null);

/** The Edit and Delete buttons of a local event's details, under them. */
function LocalActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <ButtonRow data-event-actions>
      <Button size="sm" onClick={onEdit}>{t("calendarPage.eventEdit")}</Button>
      <Button size="sm" variant="danger" onClick={onDelete}>{t("calendarPage.eventDelete")}</Button>
    </ButtonRow>
  );
}

/** Delete's confirmation: nothing is posted until it is confirmed; a refusal shows in the dialog. */
function DeleteDialog({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const actions = useContext(CalendarActionsContext);
  const token = useApi<Session>(API.session, false).data?.csrf_token;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy || !token) return;
    setBusy(true);
    setError(null);
    const r = await postLocalEventDelete(token, event.id);
    if (!r.ok) {
      setError(r.error);
      setBusy(false);
      return;
    }
    await actions?.refetch();
    onClose();
  };
  return (
    <Dialog title={t("calendarPage.deleteTitle", { title: titleOf(event) })} consequence={t("calendarPage.deleteConsequence")} confirmLabel={t("calendarPage.deleteConfirm")} confirmDisabled={busy || !token} danger error={error} onConfirm={() => void confirm()} onClose={onClose} />
  );
}

/**
 * An event chip as a button (ChipButton) that opens its details in a Popover; pressing it again, Esc or the close
 * button closes them and focus returns to it. `children` is what the chip shows. A local event's details end with Edit
 * (the page's dialog) and Delete (confirmed first); an event of any other source shows neither.
 */
export function EventButton({ event, showSource, className, children }: { event: CalendarEvent; showSource: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const actions = useContext(CalendarActionsContext);
  const local = actions !== null && event.source === LOCAL_SOURCE;
  const footer = local ? (
    <LocalActions onEdit={() => { setOpen(false); actions.edit(event); }} onDelete={() => { setOpen(false); setDeleting(true); }} />
  ) : event.details?.link ? (
    <EventLink link={event.details.link} />
  ) : undefined;
  return (
    <>
      <ChipButton ref={ref} open={open} data-event={`${event.source}:${event.id}`} {...(event.all_day ? { "data-all-day": "" } : {})} data-capture-open="calendar-event" onClick={() => setOpen((o) => !o)} className={className}>
        {children}
      </ChipButton>
      {open && (
        <Popover anchor={ref} title={titleOf(event)} onClose={() => setOpen(false)} footer={footer}>
          <EventDetail event={event} showSource={showSource} />
        </Popover>
      )}
      {deleting && <DeleteDialog event={event} onClose={() => setDeleting(false)} />}
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
            <span aria-hidden data-colour className={cn("size-2 shrink-0 rounded-pill", colourOf(event.source))} />
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
    </div>
  );
}

/** The link to the event in its own calendar: the Popover's footer, pinned under the details so it stays in view. */
export function EventLink({ link }: { link: string }) {
  return (
    <a href={link} target="_blank" rel="noopener noreferrer" data-event-link className={cn(LINK_CLASS, "inline-flex min-h-6 items-center gap-1.5")}>
      {openLabel(link)}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}
