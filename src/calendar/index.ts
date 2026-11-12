// Calendar component (design 02-tasks, calendar): the calendar_ tables and the sync that fills them from the
// configured sources. Other components import only this file.

export { CALENDAR_SYNC_MS, syncCalendars, type CalendarFeed, type FeedEvent, type NamedFeed, type SyncOutcome } from "./calendar-sync.js";
