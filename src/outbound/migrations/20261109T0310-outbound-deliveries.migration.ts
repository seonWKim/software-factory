// RFC 0015 M7: outbound's outbox and inbox (§5.2), and its delivery tables. Additive: new tables only, safe to rerun.
// - outbound_requests: which intents were announced in a DeliveryRequested, and in which commit.
// - outbound_actions: intents that are no thread entry (a status label, a 👀 reaction, an issue close, a post on a
//   source with no work item). Thread entries keep their rows in outbound_intents.
// - outbound_batches and outbound_batch_intents: the aggregator's batches (one key each) and their intents in order.

import { ensureComponentTables } from "../../bus/index.js";
import { defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS outbound_requests (
  intent_id     TEXT NOT NULL PRIMARY KEY,
  destination   TEXT NOT NULL,
  commit_id     TEXT NOT NULL,
  commit_count  INTEGER NOT NULL,
  requested_at  TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS outbound_actions (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id  TEXT,
  source_type   TEXT NOT NULL,
  target        TEXT NOT NULL,
  action        TEXT NOT NULL,
  args          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  outcome       TEXT,
  last_error    TEXT
)`,
  "CREATE INDEX IF NOT EXISTS outbound_actions_pending ON outbound_actions (delivered_at, seq)",
  `CREATE TABLE IF NOT EXISTS outbound_batches (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  destination      TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL,
  intent_count     INTEGER NOT NULL,
  reply            INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  opened_at        TEXT NOT NULL,
  flush_at         TEXT NOT NULL,
  sent_at          TEXT,
  claim_token      INTEGER NOT NULL DEFAULT 0,
  claimed_until    TEXT
)`,
  "CREATE INDEX IF NOT EXISTS outbound_batches_flush ON outbound_batches (state, flush_at)",
  "CREATE INDEX IF NOT EXISTS outbound_batches_destination ON outbound_batches (destination, seq)",
  `CREATE TABLE IF NOT EXISTS outbound_batch_intents (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id     TEXT NOT NULL UNIQUE,
  batch_id      TEXT NOT NULL,
  commit_id     TEXT NOT NULL,
  commit_count  INTEGER NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS outbound_batch_intents_batch ON outbound_batch_intents (batch_id, seq)",
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await ensureComponentTables(db, "outbound");
    for (const sql of TABLES) await db.run(sql);
  },
});
