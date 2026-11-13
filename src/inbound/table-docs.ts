// What each store table Inbound declares holds, one line each, and what a column means where its name does not say
// (key `table.column`). Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by
// tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  inbound_commands: "Commands received from the CLI, the app and chat, and whether each was handled or refused.",
  "inbound_commands.origin": "Where the command came from: cli, app or a source.",
  inbound_cursors: "How far each source poll has read (a cursor or timestamp per name).",
  inbound_inbox: "Bus messages Inbound already handled, kept so a message is handled once.",
  inbound_listener_leases: "Which process holds each source listener, until when.",
  inbound_outbox: "Messages Inbound emitted for the bus, until they are published.",
  inbound_raw_records: "Raw events received from sources, deduplicated by key.",
  inbound_sequence_locks: "Locks that keep inbound sequence numbers in order.",
  inbound_sync_leases: "Which process holds each sync job, until when.",
};
