// Attachments (design 02-attachments): the AttachmentStore methods over `controller_attachments`, as
// SqlAttachmentStore, which SqlFactoryStore extends, so these methods add no line to sql-factory-store.ts's budget.
// The insert is conditional on the item's stage being NEW in the same statement, so an item that left triage
// between the caller's check and the write gets nothing stored. An image's bytes are stored as base64 text. A chat
// image (design 04-chat-agent) is a row with no work item (`work_item_id` empty) that belongs to the user message of
// a chat turn (`chat_session_id`, `chat_seq`): written in that turn's append (chat.ts), read back by session.

import type { Attachment, AttachmentStore, ChatImage, ImageType, NewAttachment } from "../../../core/attachments.js";
import type { Timestamp, UserId, WorkItemId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { SqlSkillDraftStore } from "./skill-drafts.js";

const COLUMNS = "id, work_item_id, kind, media_type, data, size_bytes, name, url, label, created_by, created_at";
const text = (v: unknown) => (v == null ? null : String(v));

const rowToAttachment = (r: Row): Attachment => ({
  id: String(r.id), work_item_id: String(r.work_item_id) as WorkItemId, kind: String(r.kind) as Attachment["kind"],
  media_type: text(r.media_type) as ImageType | null, data: text(r.data), size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
  name: text(r.name), url: text(r.url), label: text(r.label), created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp,
});

const CHAT_COLUMNS = "id, work_item_id, kind, media_type, data, size_bytes, name, created_by, created_at, chat_session_id, chat_seq";

const rowToChatImage = (r: Row): ChatImage => ({
  id: String(r.id), name: String(r.name), media_type: String(r.media_type) as ImageType, data: String(r.data),
  size_bytes: Number(r.size_bytes), created_by: String(r.created_by) as UserId,
});

/** Writes a chat turn's user message's images (session, seq), in order, inside the turn's append transaction. */
export async function insertChatImages(tx: SqlExecutor, session_id: string, seq: number, images: readonly ChatImage[], at: Timestamp): Promise<void> {
  for (const i of images) {
    await tx.run(`INSERT INTO controller_attachments (${CHAT_COLUMNS}) VALUES (?, '', 'image', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [i.id, i.media_type, i.data, i.size_bytes, i.name, i.created_by, at, session_id, seq]);
  }
}

/** A chat session's images with their bytes by the seq of their message, each message's in the order sent. Read-only. */
export async function listChatImages(db: SqlDriver, session_id: string): Promise<Map<number, ChatImage[]>> {
  const rows = await db.all(`SELECT ${CHAT_COLUMNS} FROM controller_attachments WHERE chat_session_id = ? ORDER BY chat_seq, ${db.dialect.seq}`, [session_id]);
  const by = new Map<number, ChatImage[]>();
  for (const r of rows) {
    const seq = Number(r.chat_seq);
    by.set(seq, [...(by.get(seq) ?? []), rowToChatImage(r)]);
  }
  return by;
}

/** AttachmentStore over a SqlDriver; `attachStamp` is the store's injected Clock's time. */
export class SqlAttachmentStore extends SqlSkillDraftStore implements AttachmentStore {
  constructor(db: SqlDriver, private readonly attachStamp: () => Timestamp) {
    super(db, attachStamp);
  }

  addAttachment(a: NewAttachment): Promise<Attachment | null> {
    return this.db.transaction(async (tx) => {
      const [known] = await tx.all(`SELECT ${COLUMNS} FROM controller_attachments WHERE id = ?`, [a.id]);
      if (known) return rowToAttachment(known);
      const added = await tx.run(
        `INSERT INTO controller_attachments (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM controller_work_items WHERE id = ? AND stage = 'NEW')`,
        [a.id, a.work_item_id, a.kind, a.media_type, a.data, a.size_bytes, a.name, a.url, a.label, a.created_by, this.attachStamp(), a.work_item_id],
      );
      if (added !== 1) return null;
      const [row] = await tx.all(`SELECT ${COLUMNS} FROM controller_attachments WHERE id = ?`, [a.id]);
      return rowToAttachment(row!);
    });
  }

  async listAttachments(work_item_id: WorkItemId): Promise<Attachment[]> {
    return (await this.db.all(`SELECT ${COLUMNS} FROM controller_attachments WHERE work_item_id = ? ORDER BY created_at, id`, [work_item_id])).map(rowToAttachment);
  }

  async getChatImage(id: string): Promise<ChatImage | null> {
    const [row] = await this.db.all(`SELECT ${CHAT_COLUMNS} FROM controller_attachments WHERE id = ? AND chat_session_id IS NOT NULL`, [id]);
    return row ? rowToChatImage(row) : null;
  }
}
