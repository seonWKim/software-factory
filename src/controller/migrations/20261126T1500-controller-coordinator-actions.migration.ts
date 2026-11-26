// The coordinator (design 05-coordinator): `controller_coordinator_actions`, one row per action a coordinator cycle
// took or refused, keyed on the cycle and the action's place in it, with its outcome, reason and the link to the
// cycle's transcript; and `controller_coordinator_due`, one row per coordinator (`coordinator`) holding when its next
// cycle is due, so every replica reads the same time and moves it with one conditional update. `outcome` is plain
// text so a later outcome adds no migration. Additive: two new tables, no backfill, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_coordinator_actions", "controller_coordinator_due"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_coordinator_actions (
    cycle_id         TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    work_item_id     TEXT,
    command          TEXT NOT NULL,
    outcome          TEXT NOT NULL,
    reason           TEXT NOT NULL,
    transcript_link  TEXT,
    recorded_at      TEXT NOT NULL,
    PRIMARY KEY (cycle_id, seq)
  )`);
    await db.run(`CREATE TABLE IF NOT EXISTS controller_coordinator_due (
    name        TEXT PRIMARY KEY,
    due_at      TEXT NOT NULL,
    cycle_id    TEXT,
    updated_at  TEXT NOT NULL
  )`);
  },
});
