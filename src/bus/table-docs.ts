// What each store table the bus declares holds, one line each. Topic tables are made at run time from the topic
// descriptors (plugins/sql/ddl.ts), so they are described by their suffix. Read by the Data page (src/ui/data.ts,
// design 09-dashboard-app); checked by tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  bus_scheduler: "The retry scheduler's release horizon: retries, delays and leases before it are due.",
  bus_topics: "Every bus topic whose tables exist, with its consumption and partitions.",
};

/** A topic table's line by its suffix after `bus_<topic>`, longest first; "" is the messages table. */
export const TOPIC_TABLE_DOCS: readonly (readonly [suffix: string, text: string])[] = [
  ["_dead_letters", "Messages of one bus topic that failed every retry."],
  ["_cursors", "How far each consumer of one bus topic has read."],
  ["_retries", "Messages of one bus topic waiting for a retry."],
  ["", "Messages published on one bus topic."],
];
