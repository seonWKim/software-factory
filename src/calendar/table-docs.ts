// What each store table Calendar declares holds, one line each. Read by the Data page (src/ui/data.ts, design
// 09-dashboard-app); checked by tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  calendar_events: "Calendar events read from each connected calendar, shown beside tasks.",
  calendar_local_events: "The owner's own events, added from the factory, each with its repeat (none, daily, weekly or monthly).",
  calendar_sync_requests: "Each Sync asked for from the dashboard or the CLI: its days, and each calendar's result once done.",
  calendar_synced_ranges: "The days each calendar's on-demand syncs read, so those days count as synced.",
  calendar_sync_state: "When each calendar was last read, when it is read next, and its last error.",
};
