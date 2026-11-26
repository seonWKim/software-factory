// Chat messages (docs/plugins/llm-provider.md): the store methods of ChatMessageStore over controller_chat_messages
// (src/state/migrations/20261126T1200-state-chat-sessions), controller_chat_spend (design 04-chat-agent,
// src/state/migrations/20261126T1300-state-chat-spend; its kind, design 06-spend, 20261127T1000-state-coordinator-spend)
// and controller_chat_turns (design 04-chat-agent,
// src/state/migrations/20261126T1400-state-chat-turns), kept out of sql-factory-store.ts so that file stays within
// its line budget. Store data only: no model call, no sync plugin.

import type { Timestamp } from "../../../core/types.js";
import type { ChatSpend } from "../../../core/spend.js";
import type { ChatMessageRecord, ChatTurnRecord, ChatTurnStatus, NewChatMessage } from "../../../interfaces/factory-store.js";
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

const INSERT_SPEND = `INSERT INTO controller_chat_spend (turn_id, session_id, day, cost_usd, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)`;

/** One turn's spend; false, nothing written, when its turn id is counted already. */
export async function recordChatSpend(db: SqlDriver, s: ChatSpend, at: Timestamp): Promise<boolean> {
  return insertOnce(db, db, INSERT_SPEND, [s.turn_id, s.session_id, s.day, s.cost_usd, s.tokens, at]);
}

/** The chat turns (kind `chat`: never a coordinator row) of the UTC days `from` to `to`, both inclusive, by day, session and turn id. Read-only. */
export async function listChatSpendBetween(db: SqlExecutor, from: string, to: string): Promise<ChatSpend[]> {
  const rows = await db.all("SELECT * FROM controller_chat_spend WHERE kind = 'chat' AND day >= ? AND day <= ? ORDER BY day, session_id, turn_id", [from, to]);
  return rows.map((r) => ({
    turn_id: String(r.turn_id), session_id: String(r.session_id), day: String(r.day), cost_usd: r.cost_usd == null ? null : Number(r.cost_usd), tokens: Number(r.tokens),
  }));
}

const INSERT_TURN = "INSERT INTO controller_chat_turns (turn_id, session_id, status, reason, created_at, finished_at) VALUES (?, ?, 'running', NULL, ?, NULL)";

/** A chat.send turn's row, running, in one transaction; false, nothing written, when its turn id is stored already. */
export async function startChatTurn(db: SqlDriver, turn_id: string, session_id: string, at: Timestamp): Promise<boolean> {
  return db.transaction((tx) => insertOnce(db, tx, INSERT_TURN, [turn_id, session_id, at]));
}

/** Ends a running turn in one transaction; false when no running turn has this id, so an ended turn keeps its end. */
export async function finishChatTurn(db: SqlDriver, turn_id: string, status: Exclude<ChatTurnStatus, "running">, reason: string | null, at: Timestamp): Promise<boolean> {
  const sql = "UPDATE controller_chat_turns SET status = ?, reason = ?, finished_at = ? WHERE turn_id = ? AND status = 'running'";
  return (await db.transaction((tx) => tx.run(sql, [status, reason, at, turn_id]))) > 0;
}

/** The newest turns first (insertion order breaks a tie of times), at most `limit`. Read-only, one transaction. */
export async function listChatTurns(db: SqlDriver, limit: number): Promise<ChatTurnRecord[]> {
  const sql = `SELECT * FROM controller_chat_turns ORDER BY created_at DESC, ${db.dialect.seq} DESC LIMIT ?`;
  const rows = await db.transaction((tx) => tx.all(sql, [Math.max(0, Math.floor(limit))]));
  return rows.map((r) => ({
    turn_id: String(r.turn_id), session_id: String(r.session_id), status: String(r.status) as ChatTurnStatus, reason: r.reason == null ? null : String(r.reason),
    created_at: String(r.created_at) as Timestamp, finished_at: r.finished_at == null ? null : (String(r.finished_at) as Timestamp),
  }));
}
