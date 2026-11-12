// Fake calendar sources (design 02-tasks, calendar): no test calls a live calendar service.

import type { CalendarEvent, CalendarSource, CalendarWindow } from "../../src/interfaces/calendar-source.js";

/**
 * Answers `list` on every call and records each window it was asked for. With `failWith` set, every call fails with
 * that message instead, as a provider outage would.
 */
export class FakeCalendarSource implements CalendarSource {
  readonly windows: CalendarWindow[] = [];
  failWith: string | null = null;
  constructor(public list: CalendarEvent[] = []) {}

  async events(window: CalendarWindow): Promise<readonly CalendarEvent[]> {
    this.windows.push(window);
    if (this.failWith !== null) throw new Error(this.failWith);
    return this.list;
  }
}

export function calendarEvent(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: `event ${id}`, starts_at: "2026-01-02T09:00:00.000Z", ends_at: "2026-01-02T10:00:00.000Z", all_day: false, updated_at: null, ...over };
}
