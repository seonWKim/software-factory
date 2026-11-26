// Chat messages (docs/plugins/llm-provider.md, 2026-11-26): one `controller_chat_messages` row per message of a chat
// session, keyed by (`session_id`, `seq`). `role` is user, assistant or tool; `content` the message text;
// `tool_calls` the assistant's tool calls as JSON text (null: none); `tool_call_id` the call a tool message answers
// (null: not a tool message). The primary key refuses a seq the session already has, so two workers appending the
// same turn write it once. Additive: a new table only, no backfill, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "controller_chat_messages";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    tool_calls    TEXT,
    tool_call_id  TEXT,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
  },
});
