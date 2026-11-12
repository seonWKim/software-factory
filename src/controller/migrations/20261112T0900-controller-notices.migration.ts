// Owner notices (design 09-notifications): one `controller_notices` row per wait, a wait being the state change that
// set an item's blocked_on to `human`, keyed on (work_item_id, wait_key) so a wait is noticed once. The backfill
// stores each item already waiting on the owner as notified (delivered at the wait's own time), so turning this on
// raises no notice for what the Needs-you list shows already. Additive: a new table and its rows, safe to rerun.

import { type Row, defineMigration } from "../../state/index.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS controller_notices (
    work_item_id  TEXT NOT NULL,
    wait_key      TEXT NOT NULL,
    kind          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    held_until    TEXT,
    delivered_at  TEXT,
    count         INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (work_item_id, wait_key)
  )`,
  "CREATE INDEX IF NOT EXISTS controller_notices_undelivered ON controller_notices (delivered_at, held_until)",
];

/** The state change that set blocked_on to `human`, newest first: the same wait the notifications unit keys on. */
function waitChange(rows: readonly Row[]): { id: string; at: string } | null {
  for (const r of rows) {
    const changes = JSON.parse(String(r.changes)) as { blocked_on?: { to?: unknown } };
    if (changes.blocked_on?.to === "human") return { id: String(r.id), at: String(r.at) };
  }
  return null;
}

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    for (const sql of TABLES) await db.run(sql);
    for (const item of await db.all("SELECT id FROM controller_work_items WHERE blocked_on = 'human'")) {
      const rows = await db.all("SELECT id, at, changes FROM controller_state_changes WHERE work_item_id = ? ORDER BY version DESC", [item.id as string]);
      const wait = waitChange(rows);
      if (wait === null) continue;
      await db.run(
        `INSERT OR IGNORE INTO controller_notices (work_item_id, wait_key, kind, created_at, held_until, delivered_at, count) VALUES (?, ?, 'backfill', ?, NULL, ?, 1)`,
        [item.id as string, wait.id, wait.at, wait.at],
      );
    }
  },
});
