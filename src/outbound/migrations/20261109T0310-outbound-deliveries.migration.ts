// RFC 0015 M7: outbound's outbox and inbox (§5.2), and its delivery tables. Additive: new tables only, safe to rerun.
// - outbound_requests: which intents were announced in a DeliveryRequested, and in which commit.
// - outbound_actions: intents that are no thread entry (a status label, a 👀 reaction, an issue close, a post on a
//   source with no work item). Thread entries keep their rows in outbound_intents.
// - outbound_batches and outbound_batch_intents: the aggregator's batches (one key each) and their intents in order.

import { ensureComponentTables } from "../../bus/index.js";
import { defineMigration, type Dialect } from "../../state/index.js";

const T: Record<Dialect, { id: string; time: string; int: string; text: string; seq: string; end: string }> = {
  sqlite: { id: "TEXT", time: "TEXT", int: "INTEGER", text: "TEXT", seq: "INTEGER PRIMARY KEY AUTOINCREMENT", end: "" },
  mysql: {
    id: "VARCHAR(191)", time: "CHAR(24)", int: "BIGINT", text: "MEDIUMTEXT", seq: "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY",
    end: " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
  },
};

function tables(d: Dialect): string[] {
  const t = T[d];
  const key = (name: string, cols: string) => (d === "mysql" ? [`,\n  KEY ${name} (${cols})`] : []);
  const index = (name: string, table: string, cols: string) => (d === "sqlite" ? [`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`] : []);
  return [
    `CREATE TABLE IF NOT EXISTS outbound_requests (
  intent_id     ${t.id} NOT NULL PRIMARY KEY,
  destination   ${t.id} NOT NULL,
  commit_id     ${t.id} NOT NULL,
  commit_count  ${t.int} NOT NULL,
  requested_at  ${t.time} NOT NULL
)${t.end}`,
    `CREATE TABLE IF NOT EXISTS outbound_actions (
  seq           ${t.seq},
  work_item_id  ${t.id},
  source_type   ${t.id} NOT NULL,
  target        ${t.text} NOT NULL,
  action        ${t.id} NOT NULL,
  args          ${t.text} NOT NULL,
  created_at    ${t.time} NOT NULL,
  delivered_at  ${t.time},
  outcome       ${t.id},
  last_error    ${t.text}${key("outbound_actions_pending", "delivered_at, seq").join("")}
)${t.end}`,
    ...index("outbound_actions_pending", "outbound_actions", "delivered_at, seq"),
    `CREATE TABLE IF NOT EXISTS outbound_batches (
  seq              ${t.seq},
  id               ${t.id} NOT NULL UNIQUE,
  destination      ${t.id} NOT NULL,
  idempotency_key  ${t.id} NOT NULL UNIQUE,
  state            ${t.id} NOT NULL,
  intent_count     ${t.int} NOT NULL,
  reply            ${t.int} NOT NULL DEFAULT 0,
  attempts         ${t.int} NOT NULL DEFAULT 0,
  last_error       ${t.text},
  opened_at        ${t.time} NOT NULL,
  flush_at         ${t.time} NOT NULL,
  sent_at          ${t.time},
  claim_token      ${t.int} NOT NULL DEFAULT 0,
  claimed_until    ${t.time}${key("outbound_batches_flush", "state, flush_at").join("")}${key("outbound_batches_destination", "destination, seq").join("")}
)${t.end}`,
    ...index("outbound_batches_flush", "outbound_batches", "state, flush_at"),
    ...index("outbound_batches_destination", "outbound_batches", "destination, seq"),
    `CREATE TABLE IF NOT EXISTS outbound_batch_intents (
  seq           ${t.seq},
  intent_id     ${t.id} NOT NULL UNIQUE,
  batch_id      ${t.id} NOT NULL,
  commit_id     ${t.id} NOT NULL,
  commit_count  ${t.int} NOT NULL${key("outbound_batch_intents_batch", "batch_id, seq").join("")}
)${t.end}`,
    ...index("outbound_batch_intents_batch", "outbound_batch_intents", "batch_id, seq"),
  ];
}

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await ensureComponentTables(db, "outbound");
    for (const sql of tables(db.dialect)) await db.run(sql);
  },
});
