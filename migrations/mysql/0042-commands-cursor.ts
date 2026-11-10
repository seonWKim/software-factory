// Issue #467: the command relay reads only the `commands` cursor; it no longer falls back to `intake:local`.
// This copies the value of `intake:local` into `commands`, only when `commands` is missing: one guarded INSERT,
// never an overwrite, and `intake:local` stays as it is. The same copy as SQLite's inbound migration
// 20261111T1200-inbound-commands-cursor (src/inbound/migrations/).
//
// File steps run before the timestamped migrations, so on an upgrade the table may still be `cursors` (before
// the rename to `inbound_cursors`, src/state/migrations/20261108T1300-state-prefix-tables). A second apply
// matches no row.

import type { DataStep, Row, StepDb } from "../step.js";

const LEGACY = "intake:local";
const COMMANDS = "commands";

/** `inbound_cursors`, or `cursors` before the rename. */
async function cursorTable(db: StepDb): Promise<string> {
  const rows = await db.all(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('inbound_cursors', 'cursors')",
  );
  const names = new Set(rows.map((r) => String(r.t)));
  if (names.has("inbound_cursors")) return "inbound_cursors";
  if (names.has("cursors")) return "cursors";
  throw new Error("0042-commands-cursor: neither inbound_cursors nor cursors exists");
}

/** The rows of `table` whose value `commands` would take: `intake:local`'s, only while `commands` is missing. */
const source = (table: string) =>
  `FROM ${table} o WHERE o.name = ? AND NOT EXISTS (SELECT 1 FROM ${table} c WHERE c.name = ?)`;

const step: DataStep = {
  async plan(db) {
    const table = await cursorTable(db);
    const rows = await db.all(`SELECT o.value ${source(table)}`, [LEGACY, COMMANDS]);
    return rows.map((r): Row => ({ table, name: COMMANDS, value: r.value }));
  },

  async apply(db) {
    const table = await cursorTable(db);
    await db.run(`INSERT INTO ${table} (name, value) SELECT ?, o.value ${source(table)}`, [COMMANDS, LEGACY, COMMANDS]);
  },
};

export default step;
