// A calendar the factory reads (design 02-tasks, calendar): a neutral source of events, selected by name in the
// top-level `calendar` config key (docs/plugins/calendar-source.md); none by default. The calendar component
// (src/calendar/) stores what a source answers; the source never writes and is never asked to.

/** One event as a source reports it. Times are ISO 8601 instants; an all-day event spans its whole days. */
export interface CalendarEvent {
  /** The source's own ID for the event, stable across reads. Unique within one source. */
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  /** When the source last changed the event; null when it reports none. */
  updated_at: string | null;
  /**
   * Its calendar's name, place, notes, people, meeting link and event page, from the same read; absent when the source
   * answers none. The same shape as EventDetails in src/calendar/event-details.ts, restated because a legacy folder
   * imports no component; compose hands the sources over, so the typecheck keeps the two in step.
   */
  details?: {
    calendar: string | null;
    location: string | null;
    description: string | null;
    organizer: CalendarEventPerson | null;
    attendees: readonly CalendarEventPerson[];
    conference_url: string | null;
    link: string | null;
    time_zone: string | null;
  };
}

/** A person on an event. `response`: their answer to the invitation, when the source says. */
export interface CalendarEventPerson {
  name: string | null;
  email: string | null;
  response: "accepted" | "declined" | "tentative" | "waiting" | null;
}

/** The span a sync asks about: events that overlap [from, to), both ISO 8601 instants. */
export interface CalendarWindow {
  from: string;
  to: string;
}

export interface CalendarSource {
  /** Every event in `window`. One call per sync; a throw is the sync's error, stored per source. */
  events(window: CalendarWindow): Promise<readonly CalendarEvent[]>;
}
