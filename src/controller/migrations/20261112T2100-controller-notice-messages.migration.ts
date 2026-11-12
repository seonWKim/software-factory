// Notice records (design 05-sources, "Replies under a notice"): one `controller_notice_messages` row per notice the
// Slack source posted, keyed on its (channel, ts), with the work item IDs its lines name as a JSON array; and one
// `controller_notice_questions` row per reply under a several-item notice, keyed on the reply's ID, with its words
// until a which-item press. SQLite only: the MySQL store is gone. Additive: two new tables, no backfill (a notice
// posted before this gets no record), safe to rerun.

import { defineMigration } from "../../state/index.js";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS controller_notice_messages (
    channel        TEXT NOT NULL,
    ts             TEXT NOT NULL,
    work_item_ids  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (channel, ts)
  )`,
  `CREATE TABLE IF NOT EXISTS controller_notice_questions (
    id          TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    notice_ts   TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`,
];

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of SQLITE) await db.run(sql);
  },
});
