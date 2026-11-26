// Chat spend (design 04-chat-agent, 2026-11-26): one `controller_chat_spend` row per chat turn, keyed by the turn's
// own id (`turn_id`, made once per turn), never by a message seq: a failed turn stores no message, so the next turn
// takes the same seq and its spend would be refused. `session_id` names the turn's session. `day` is the UTC day of the turn (YYYY-MM-DD);
// `cost_usd` the sum of the provider's own figures over the turn's model calls (null: unknown, some call reported
// none); `tokens` the input plus output tokens of those calls. The primary key refuses a turn already counted. Additive: a new table only, no backfill (no chat turn was counted before), safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "controller_chat_spend";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    turn_id     TEXT NOT NULL PRIMARY KEY,
    session_id  TEXT NOT NULL,
    day         TEXT NOT NULL,
    cost_usd    REAL,
    tokens      INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
    await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_day ON ${TABLE} (day)`);
  },
});
