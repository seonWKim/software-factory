// Calendar component (design 02-tasks, calendar): the calendar_ tables, the sync that fills them from the
// configured sources, and the dashboard's read of what they hold. Other components import only this file.

export { CALENDAR_SYNC_MS, syncCalendars, type CalendarFeed, type FeedEvent, type NamedFeed, type SyncOutcome } from "./calendar-sync.js";
export { readCalendar, type SourceSync, type StoredCalendar, type StoredEvent } from "./calendar-read.js";
