// Issue #467: the command relay reads only the `commands` cursor. Before, it fell back to the old `intake:local`
// cursor while `commands` was missing, two reads on every tick until a command was relayed. This copies the old
// value once, only when `commands` is missing: one guarded INSERT, never an overwrite. `intake:local` stays as it is.
// Additive and safe to rerun. MySQL gets the same copy from step migrations/mysql/0042-commands-cursor.ts, which
// `npm run migrate` applies before the timestamped migrations, so this one returns at once there.

import { defineMigration } from "../../state/index.js";

const CURSORS = "inbound_cursors";
const LEGACY_CURSOR = "intake:local";
const COMMANDS_CURSOR = "commands";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (db.dialect === "mysql") return;
    await db.run(
      `INSERT INTO ${CURSORS} (name, value) SELECT ?, o.value FROM ${CURSORS} o
       WHERE o.name = ? AND NOT EXISTS (SELECT 1 FROM ${CURSORS} c WHERE c.name = ?)`,
      [COMMANDS_CURSOR, LEGACY_CURSOR, COMMANDS_CURSOR],
    );
  },
});
