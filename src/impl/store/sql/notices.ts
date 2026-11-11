// Owner notices (design 09-notifications): the store methods of NoticeStore over `controller_notices`, kept out of
// sql-factory-store.ts so that file stays within its line budget. The one write is an insert that skips a stored
// (work_item_id, wait_key), so a repeated pass or another replica stores nothing more.

import type { NewNotice, Notice } from "../../../core/notifications.js";
import type { Timestamp } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";

const COLUMNS = "work_item_id, wait_key, kind, created_at, held_until, delivered_at, count";
/** Work item IDs per `IN (...)` list: well under every backend's bound-parameter limit. */
const ID_CHUNK = 500;

const time = (v: unknown) => (v == null ? null : (String(v) as Timestamp));

function rowToNotice(r: Row): Notice {
  return {
    work_item_id: String(r.work_item_id), wait_key: String(r.wait_key), kind: String(r.kind) as Notice["kind"],
    created_at: String(r.created_at) as Timestamp, held_until: time(r.held_until), delivered_at: time(r.delivered_at), count: Number(r.count),
  };
}

export async function recordNotice(db: SqlDriver, n: NewNotice): Promise<boolean> {
  try {
    await db.run(`INSERT INTO controller_notices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [
      n.work_item_id, n.wait_key, n.kind, n.created_at, n.held_until, n.count,
    ]);
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}

export async function listNoticesFor(db: SqlDriver, ids: readonly string[]): Promise<Notice[]> {
  const out: Notice[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await db.all(`SELECT ${COLUMNS} FROM controller_notices WHERE work_item_id IN (${chunk.map(() => "?").join(", ")})`, chunk);
    out.push(...rows.map(rowToNotice));
  }
  return out;
}

const undelivered = (held: "IS NULL" | "IS NOT NULL") => async (db: SqlDriver): Promise<Notice[]> =>
  (await db.all(`SELECT ${COLUMNS} FROM controller_notices WHERE delivered_at IS NULL AND held_until ${held} ORDER BY created_at, work_item_id, wait_key`)).map(rowToNotice);

export const listHeldNotices = undelivered("IS NOT NULL");
export const listPendingNotices = undelivered("IS NULL");
