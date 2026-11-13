// The one owner (design 08-permissions, issue #577, phase 2 of #568): roles and local users are gone, so the owner
// moves from identity_local_users (its `owner_slot = 1` row) into the one-row identity_owner table, and
// identity_local_users and identity_local_user_changes are dropped. Breaking (RFC 0015 §12 D1): code from before
// this change still reads identity_local_users, so the runner archives both tables to the backup folder before `up`.
// A new database applies it on open; one that holds data through `npm run migrate`, after its drain.
//
// `up` copies the owner before it drops anything; `verify` fails when the owner it copied is not the one stored, or
// a dropped table is still there (§12 D2). Safe to rerun: the copy skips a held slot and the drops a missing table.

import { type MigrationDb, defineMigration, dropTables, tableExists } from "../../state/index.js";
import { OWNER_TABLE, readOwner } from "../owner/owner.js";

const DROPPED = ["identity_local_users", "identity_local_user_changes"];

const CREATE = `CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (
    slot        INTEGER PRIMARY KEY CHECK (slot = 1),
    user_id     TEXT NOT NULL,
    claimed_at  TEXT NOT NULL
  )`;

/** The owner found in identity_local_users before the drop, per database handle the runner passes to up and then verify. */
const before = new WeakMap<MigrationDb, string | null>();

export default defineMigration({
  change: "breaking",
  tables: DROPPED,
  async up(db) {
    await db.run(CREATE);
    if (await tableExists(db, "identity_local_users")) {
      const [owner] = await db.all("SELECT user_id, created_at FROM identity_local_users WHERE owner_slot = 1");
      before.set(db, owner ? String(owner.user_id) : null);
      if (owner) {
        await db.run(`INSERT INTO ${OWNER_TABLE} (slot, user_id, claimed_at) VALUES (1, ?, ?) ON CONFLICT DO NOTHING`, [String(owner.user_id), String(owner.created_at)]);
      }
    }
    await dropTables(db, DROPPED);
  },
  async verify(db) {
    const problems: string[] = [];
    for (const t of DROPPED) if (await tableExists(db, t)) problems.push(`${t} is still there`);
    const was = before.get(db);
    if (was !== undefined && was !== null && (await readOwner(db)) !== was) problems.push(`${OWNER_TABLE} does not hold the owner ${was}`);
    return problems;
  },
});
