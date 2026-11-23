// Routines (src/core/routines.ts): `controller_routines`, one row per routine with its form (a cadence in a zone, or
// a trigger), its caps, what `/approve` added to today's cap, and its marks (next slot, last run); and
// `controller_routine_suggestions`, one row per finding, unique on (routine_id, fingerprint) so a repeat is counted
// on the row it repeats. States are plain text so a later one adds no migration. Additive: two new tables and an
// index, no backfill and no row created, safe to rerun.

import { defineMigration } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: ["controller_routines", "controller_routine_suggestions"],
  async up(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS controller_routines (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    instruction    TEXT NOT NULL,
    url            TEXT,
    cadence_kind   TEXT,
    cadence_spec   TEXT,
    zone           TEXT NOT NULL,
    trigger_kind   TEXT,
    run_cap_usd    REAL,
    daily_cap_usd  REAL,
    cap_raise_usd  REAL,
    cap_raise_day  TEXT,
    cap_hold_key   TEXT,
    paused         INTEGER,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    next_due_at    TEXT,
    last_run_at    TEXT
  )`);
    await db.run("CREATE INDEX IF NOT EXISTS controller_routines_due ON controller_routines (next_due_at)");
    await db.run(`CREATE TABLE IF NOT EXISTS controller_routine_suggestions (
    id             TEXT PRIMARY KEY,
    routine_id     TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    text           TEXT NOT NULL,
    state          TEXT NOT NULL,
    duplicates     INTEGER NOT NULL,
    last_run_id    TEXT NOT NULL,
    snoozed_until  TEXT,
    filed_ref      TEXT,
    decided_by     TEXT,
    decided_at     TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE (routine_id, fingerprint)
  )`);
  },
});
