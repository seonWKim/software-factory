// Calendar component (design 02-tasks, calendar): the calendar_ tables, the sync that fills them from the
// configured sources (on its schedule and on request), the live list of those sources, and the dashboard's read of what they hold. Other components import only this file.

export {
  CALENDAR_SYNC_MS, MAX_SPAN_DAYS, rangeError, readSyncRequest, requestCalendarSync, runSyncRequests, syncCalendars, syncWindow,
  type CalendarFeed, type FeedEvent, type NamedFeed, type SyncOutcome, type SyncRequest,
} from "./calendar-sync.js";
export {
  calendarSql, readCalendar, readSyncStates, type SourceSync, type SourceSyncState, type StoredCalendar, type StoredEvent, type SyncedRange,
} from "./calendar-read.js";
export { LiveCalendars } from "./live-calendars.js";
