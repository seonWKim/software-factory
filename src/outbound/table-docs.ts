// What each store table Outbound declares holds, one line each, and what a column means where its name does not
// say (key `table.column`). Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by
// tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  outbound_actions: "Outbound actions that are not thread entries (a status label, a reaction, an issue close), and their delivery.",
  outbound_base_pushes: "Pushes of merged changes to the base branch, with their attempts and result.",
  outbound_batch_intents: "Which intents each outbound batch carries, in order.",
  outbound_batches: "Batches of outbound writes, one per destination key, with their state and attempts.",
  outbound_deliveries: "Comments posted to a source, by marker, so a comment is posted once.",
  outbound_forge_budget: "The forge's remaining API budget per project and plugin, and when it resets.",
  outbound_inbox: "Bus messages Outbound already handled, kept so a message is handled once.",
  outbound_intents: "Thread entries waiting to be delivered to a source, with their attempts.",
  outbound_label_states: "The status label last written on each issue or change.",
  outbound_outbox: "Messages Outbound emitted for the bus, until they are published.",
  outbound_requests: "Which intents were announced for delivery, and in which commit.",
};
