// Held writes (design 08-permissions, phase 2 of 3 of local-task-tk_cad55672): one `controller_held_writes` row per
// agent write the permission gate held for the owner's `confirm <id>`. `id` is the held write's own ID (`hw_…`),
// `write_key` what makes one write the same on every coordinator tick (a pending key is stored once: the partial
// unique index), `command` the command table's name (`merge`), `args` its arguments (JSON), `actor` the agent's user
// ID (never a display name), `mode` the `permission_mode` read at the write, `status` pending until phase 3 answers
// it. Additive: a new table only, no backfill, safe to rerun.

import { defineMigration } from "../migrate/migration.js";

const TABLE = "controller_held_writes";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id          TEXT NOT NULL PRIMARY KEY,
    write_key   TEXT NOT NULL,
    command     TEXT NOT NULL,
    args        TEXT NOT NULL,
    actor       TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('ask_all', 'ask_irreversible', 'full')),
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL
  )`;

export default defineMigration({
  change: "additive",
  tables: [TABLE],
  async up(db) {
    await db.run(CREATE);
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_pending_key ON ${TABLE} (write_key) WHERE status = 'pending'`);
  },
});
