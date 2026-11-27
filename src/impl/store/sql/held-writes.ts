// Held writes (design 08-permissions, phases 2 and 3 of local-task-tk_cad55672): the store methods of HeldWriteStore
// and HeldWriteAnswers over controller_held_writes (src/state/migrations/20261127T1100-state-held-writes), kept out of
// sql-factory-store.ts so that file stays within its line budget. Store data only.

import type { HeldWrite, NewHeldWrite } from "../../../core/authorize.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { HeldWriteAnswers } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { newId } from "./rows.js";
import { insertOnce } from "./store-steps.js";

/** Every held write is an agent's (design 08-permissions, phase 4): its row records origin `agent`. */
const INSERT = "INSERT INTO controller_held_writes (id, write_key, command, args, actor, mode, write_origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'agent', 'pending', ?)";

function rowToHeld(r: Row): HeldWrite {
  return {
    id: String(r.id), key: String(r.write_key), command: String(r.command), args: JSON.parse(String(r.args)) as string[], actor: String(r.actor) as UserId,
    mode: String(r.mode) as HeldWrite["mode"], write_origin: r.write_origin == null ? null : "agent", status: String(r.status), created_at: String(r.created_at) as Timestamp,
  };
}

/** One pending row per key, in one transaction: a key already pending writes nothing and gives that row. */
export async function holdWrite(db: SqlDriver, w: NewHeldWrite, at: Timestamp): Promise<{ created: boolean; write: HeldWrite }> {
  return db.transaction(async (tx) => {
    const created = await insertOnce(db, tx, INSERT, [newId("hw"), w.key, w.command, JSON.stringify(w.args), w.actor, w.mode, at]);
    const [row] = await tx.all("SELECT * FROM controller_held_writes WHERE write_key = ? AND status = 'pending'", [w.key]);
    return { created, write: rowToHeld(row!) };
  });
}

/** The newest `limit` rows first (insertion order breaks a tie of times). Read-only. */
export async function listHeldWrites(db: SqlExecutor, limit: number): Promise<HeldWrite[]> {
  const rows = await db.all("SELECT * FROM controller_held_writes ORDER BY created_at DESC, rowid DESC LIMIT ?", [limit]);
  return rows.map(rowToHeld);
}

/** One row by its ID, or null. Read-only. */
export async function getHeldWrite(db: SqlExecutor, id: string): Promise<HeldWrite | null> {
  const [row] = await db.all("SELECT * FROM controller_held_writes WHERE id = ?", [id]);
  return row ? rowToHeld(row) : null;
}

/** `from` → `to` as one conditional update: false when the row is not in `from` (answered already, or not stored). */
export async function answerHeldWrite(db: SqlExecutor, a: Parameters<HeldWriteAnswers["answerHeldWrite"]>[0]): Promise<boolean> {
  return (await db.run("UPDATE controller_held_writes SET status = ? WHERE id = ? AND status = ?", [a.to, a.id, a.from])) > 0;
}
