// Chat messages (docs/plugins/llm-provider.md): the store methods of ChatMessageStore over controller_chat_messages
// (src/state/migrations/20261126T1200-state-chat-sessions), kept out of sql-factory-store.ts so that file stays within
// its line budget. Store data only: no model call, no sync plugin.

import type { Timestamp } from "../../../core/types.js";
import type { ChatMessageRecord, NewChatMessage } from "../../../interfaces/factory-store.js";
import type { LLMToolCall } from "../../../interfaces/llm-provider.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { insertOnce } from "./store-steps.js";

const INSERT = `INSERT INTO controller_chat_messages (session_id, seq, role, content, tool_calls, tool_call_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** Thrown inside the transaction to roll back the batch when one of its seqs is taken. */
class SeqTaken extends Error {}

/** Every message in one transaction; a seq the session already has (or twice in the batch) refuses all: false, nothing written. */
export async function appendChatMessages(db: SqlDriver, session_id: string, messages: readonly NewChatMessage[], at: Timestamp): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      for (const m of messages) {
        const tool_calls = m.tool_calls !== undefined && m.tool_calls.length > 0 ? JSON.stringify(m.tool_calls) : null;
        if (!(await insertOnce(db, tx, INSERT, [session_id, m.seq, m.role, m.content, tool_calls, m.tool_call_id ?? null, at]))) throw new SeqTaken();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof SeqTaken) return false;
    throw err;
  }
}

function rowToMessage(r: Row): ChatMessageRecord {
  return {
    session_id: String(r.session_id), seq: Number(r.seq), role: String(r.role) as ChatMessageRecord["role"], content: String(r.content),
    ...(r.tool_calls != null && { tool_calls: JSON.parse(String(r.tool_calls)) as LLMToolCall[] }),
    ...(r.tool_call_id != null && { tool_call_id: String(r.tool_call_id) }),
    created_at: String(r.created_at) as Timestamp,
  };
}

/** The session's messages in seq order. Read-only. */
export async function listChatMessages(db: SqlExecutor, session_id: string): Promise<ChatMessageRecord[]> {
  const rows = await db.all("SELECT * FROM controller_chat_messages WHERE session_id = ? ORDER BY seq", [session_id]);
  return rows.map(rowToMessage);
}
