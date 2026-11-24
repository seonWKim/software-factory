// What an event says beyond its title and times (design 09-dashboard-tasks-calendar, event details, 2026-11-24): its
// calendar's name, place, notes, people and links, as a source answered them, so the Calendar page's detail view shows
// the whole event. Neutral: no provider's field names. Stored as one JSON text in calendar_events.details; an event a
// source answered without details, or a row stored before the column, has none. A source keeps its links to
// http(s) only and cuts long notes and attendee lists itself (google-calendar-source.ts).

/** A person on an event, as the source names them. `response`: their answer to the invitation, when the source says. */
export interface EventPerson {
  readonly name: string | null;
  readonly email: string | null;
  readonly response: "accepted" | "declined" | "tentative" | "waiting" | null;
}

export interface EventDetails {
  /** The name of the calendar the event is on (one source may read several). */
  readonly calendar: string | null;
  readonly location: string | null;
  /** The notes as the source wrote them; may hold markup, which the page shows as text, never as HTML. */
  readonly description: string | null;
  readonly organizer: EventPerson | null;
  readonly attendees: readonly EventPerson[];
  /** The meeting link (a video call), http(s) only. */
  readonly conference_url: string | null;
  /** The event's own page at the source, http(s) only. */
  readonly link: string | null;
  /** The time zone the event was written in (IANA name), when the source says. */
  readonly time_zone: string | null;
}

/** The stored JSON text read back; null for none or for text that is not an object. */
export function readDetails(text: unknown): EventDetails | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as EventDetails) : null;
  } catch {
    return null;
  }
}
