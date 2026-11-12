// The Slack source's notice records (design 05-sources, "Replies under a notice"): the store methods of
// NoticeMessageStore over `controller_notice_messages` and `controller_notice_questions`, kept out of
// sql-factory-store.ts so that file stays within its line budget. Each write is an insert that skips a stored key, so
// a repeated post or a redelivered reply stores nothing more.

import type { Timestamp } from "../../../core/types.js";
import type { NoticeMessage, NoticeQuestion } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";

async function insertOnce(db: SqlDriver, sql: string, params: readonly (string | null)[]): Promise<boolean> {
  try {
    await db.run(sql, params);
    return true;
  } catch (err) {
    if (db.isDuplicateKey(err)) return false;
    throw err;
  }
}

export function recordNoticeMessage(db: SqlDriver, m: Omit<NoticeMessage, "created_at">, now: Timestamp): Promise<boolean> {
  return insertOnce(db, "INSERT INTO controller_notice_messages (channel, ts, work_item_ids, created_at) VALUES (?, ?, ?, ?)", [
    m.channel, m.ts, JSON.stringify(m.work_item_ids), now,
  ]);
}

export async function getNoticeMessage(db: SqlDriver, channel: string, ts: string): Promise<NoticeMessage | null> {
  const [r] = await db.all("SELECT channel, ts, work_item_ids, created_at FROM controller_notice_messages WHERE channel = ? AND ts = ?", [channel, ts]);
  if (!r) return null;
  const ids = JSON.parse(String(r.work_item_ids)) as unknown;
  return {
    channel: String(r.channel), ts: String(r.ts), created_at: String(r.created_at) as Timestamp,
    work_item_ids: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
  };
}

export function recordNoticeQuestion(db: SqlDriver, q: Omit<NoticeQuestion, "created_at">, now: Timestamp): Promise<boolean> {
  return insertOnce(db, "INSERT INTO controller_notice_questions (id, channel, notice_ts, text, created_at) VALUES (?, ?, ?, ?, ?)", [
    q.id, q.channel, q.notice_ts, q.text, now,
  ]);
}

export async function getNoticeQuestion(db: SqlDriver, id: string): Promise<NoticeQuestion | null> {
  const [r] = await db.all("SELECT id, channel, notice_ts, text, created_at FROM controller_notice_questions WHERE id = ?", [id]);
  return r
    ? { id: String(r.id), channel: String(r.channel), notice_ts: String(r.notice_ts), text: String(r.text), created_at: String(r.created_at) as Timestamp }
    : null;
}
