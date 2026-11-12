// The lock rows that make inserts into one sequence commit in seq order (review finding 1, design 10-event-driven).
// Every writer of `inbound_commands` takes the `commands` row before it inserts. Additive: a new table and its rows, safe to rerun.

import { insertOrSkip } from "../../bus/index.js";
import { defineMigration } from "../../state/index.js";

/** The lock row of `inbound_commands` (SqlFactoryStore.lockCommandSequence takes it). */
const COMMANDS_SEQUENCE = "commands";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run("CREATE TABLE IF NOT EXISTS inbound_sequence_locks (name TEXT NOT NULL PRIMARY KEY)");
    await insertOrSkip(db, "inbound_sequence_locks (name) VALUES (?)", [COMMANDS_SEQUENCE]);
  },
});
