// Attachments (design 02-attachments): `controller_attachments`, one row per image or link the owner attached to a
// New or in-triage item, keyed by its ID and indexed by work item ID. An image's bytes are base64 text in `data`.
// Additive: one new table and an index, no backfill (an item stored before has none), safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_attachments"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_attachments (
    id            TEXT PRIMARY KEY,
    work_item_id  TEXT NOT NULL,
    kind          TEXT NOT NULL,
    media_type    TEXT,
    data          TEXT,
    size_bytes    INTEGER,
    name          TEXT,
    url           TEXT,
    label         TEXT,
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_attachments_item ON controller_attachments (work_item_id, created_at)");
  },
});
