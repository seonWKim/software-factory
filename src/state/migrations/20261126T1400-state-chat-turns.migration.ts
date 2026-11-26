// Chat turns (design 04-chat-agent, 2026-11-26): one `controller_chat_turns` row per chat.send turn, keyed by the
// turn's own id (`ct_<uuid>`, the key of its spend row too). `status` is running at the turn's start, then answered,
// refused or failed; `reason` says why a turn was refused or failed (null when answered or still running);
// `finished_at` is set when the turn ends. The index on created_at serves chat.turns, newest first. Additive: a new
// table only, no backfill (no turn was recorded before), safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "controller_chat_turns";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    turn_id      TEXT NOT NULL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    status       TEXT NOT NULL,
    reason       TEXT,
    created_at   TEXT NOT NULL,
    finished_at  TEXT
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
    await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_created ON ${TABLE} (created_at)`);
  },
});
