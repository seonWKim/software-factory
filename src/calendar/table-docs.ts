// What each store table Calendar declares holds, one line each. Read by the Data page (src/ui/data.ts, design
// 09-dashboard-app); checked by tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  calendar_events: "Calendar events read from each connected calendar, shown beside tasks.",
  calendar_sync_state: "When each calendar was last read, when it is read next, and its last error.",
};
