// The coordinator spend kind (design 06-spend, 2026-11-27): `controller_chat_spend.kind`, `chat` (a chat turn) or
// `coordinator` (a coordinator cycle's model calls); the check refuses any other kind. Additive: one TEXT NOT NULL
// column defaulting to `chat`, no backfill (every stored row is a chat turn and reads `chat`). The column check makes
// a rerun change nothing.

import { defineMigration } from "../migrate/migration.js";
import { tableColumns } from "../migrate/copy-tables.js";

const TABLE = "controller_chat_spend";

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    if ((await tableColumns(db, TABLE)).includes("kind")) return;
    await db.run(`ALTER TABLE ${TABLE} ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'coordinator'))`);
  },
});
