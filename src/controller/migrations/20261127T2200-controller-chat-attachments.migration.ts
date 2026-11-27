// Chat images (design 04-chat-agent, 02-attachments): a chat message's images are rows of `controller_attachments`
// that belong to a chat turn instead of an item. `chat_session_id` and `chat_seq` name the user message they were sent
// with (controller_chat_messages' key); such a row has an empty `work_item_id`. Additive: two nullable columns and an
// index, no backfill (no chat image was stored before), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

const COLUMNS = [["chat_session_id", "TEXT"], ["chat_seq", "INTEGER"]] as const;

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    const have = await tableColumns(db, "controller_attachments");
    for (const [c, type] of COLUMNS) if (!have.includes(c)) await db.run(`ALTER TABLE controller_attachments ADD COLUMN ${c} ${type}`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_attachments_chat ON controller_attachments (chat_session_id, chat_seq)");
  },
});
