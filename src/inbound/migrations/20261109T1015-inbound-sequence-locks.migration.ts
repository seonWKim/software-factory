// The lock rows that make inserts into one sequence commit in seq order (review finding 1, design 10-event-driven).
// MySQL hands out AUTO_INCREMENT values at insert, not at commit, so a reader's `seq > cursor` could pass a seq
// whose transaction commits later and skip it for good. Every writer of `inbound_commands` takes the `commands`
// row FOR UPDATE before it inserts. Additive: a new table and its rows, safe to rerun.

import { insertOrSkip } from "../../bus/index.js";
import { defineMigration } from "../../state/index.js";

/** The lock row of `inbound_commands` (SqlFactoryStore.lockCommandSequence takes it). */
const COMMANDS_SEQUENCE = "commands";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    await db.run(
      db.dialect === "sqlite"
        ? "CREATE TABLE IF NOT EXISTS inbound_sequence_locks (name TEXT NOT NULL PRIMARY KEY)"
        : "CREATE TABLE IF NOT EXISTS inbound_sequence_locks (name VARCHAR(64) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
    );
    await insertOrSkip(db, db.dialect, "inbound_sequence_locks (name) VALUES (?)", [COMMANDS_SEQUENCE]);
  },
});
