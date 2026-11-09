// Inbound's own tables (RFC 0015 §6.3): raw records, commands, cursors and the sync lease's fence. Every write
// here runs in the caller's transaction, beside the outbox rows that announce it.

import type { SourceType } from "../core/types.js";
import type { CommandPassport, ExternalIdentity } from "../interfaces/auth-provider.js";
import type { CliCommand, SyncFence } from "../interfaces/factory-store.js";
import type { ForgeEvent } from "../interfaces/forge.js";
import type { SourceEvent } from "../interfaces/source-adapter.js";
import { insertOrSkip } from "../bus/index.js";
import type { Dialect, Row, SqlExecutor } from "../state/index.js";

/** What an adapter read: a source's event or the forge's. */
export type InboundEvent = SourceEvent | ForgeEvent;

/** A raw record's id, the claim check its messages carry: `rec_<seq>` (RFC 0015 §12, `inbound_raw_records`). */
export function recordId(seq: number): string {
  return `rec_${seq}`;
}

const RECORD_ID = /^rec_(\d+)$/;

/** Dedupe keys of polled records start with this; a stream source's records carry the source's own keys. */
export const POLLED = "poll:";

export async function readCursor(q: SqlExecutor, name: string): Promise<string | null> {
  const [row] = await q.all("SELECT value FROM inbound_cursors WHERE name = ?", [name]);
  return (row?.value as string | undefined) ?? null;
}

/** Moves cursor `name` from `expected` to `next`; false when another writer moved it first. */
export async function moveCursor(tx: SqlExecutor, dialect: Dialect, name: string, expected: string | null, next: string): Promise<boolean> {
  if (expected === null) return insertOrSkip(tx, dialect, "inbound_cursors (name, value) VALUES (?, ?)", [name, next]);
  return (await tx.run("UPDATE inbound_cursors SET value = ? WHERE name = ? AND value = ?", [next, name, expected])) === 1;
}

/**
 * Whether `fence.token` is still its sync lease's token. FOR UPDATE: a takeover (token + 1) waits until this
 * transaction commits, so a replica whose lease was taken over writes nothing after the takeover.
 */
export async function fenceHolds(tx: SqlExecutor, forUpdate: string, fence: SyncFence): Promise<boolean> {
  const [held] = await tx.all(`SELECT token FROM inbound_sync_leases WHERE name = ? AND token = ?${forUpdate}`, [fence.name, fence.token]);
  return held !== undefined;
}

export async function syncLeaseToken(q: SqlExecutor, name: string): Promise<number | null> {
  const [row] = await q.all("SELECT token FROM inbound_sync_leases WHERE name = ?", [name]);
  return row ? Number(row.token) : null;
}

/** Stores one record (once per source type and key) and returns its id. */
export async function storeRecord(
  tx: SqlExecutor,
  dialect: Dialect,
  r: { source_type: SourceType; dedupe_key: string; event: InboundEvent; received_at: string },
): Promise<string> {
  await insertOrSkip(tx, dialect, "inbound_raw_records (source_type, dedupe_key, event, received_at) VALUES (?, ?, ?, ?)", [
    r.source_type,
    r.dedupe_key,
    JSON.stringify(r.event),
    r.received_at,
  ]);
  const [row] = await tx.all("SELECT seq FROM inbound_raw_records WHERE source_type = ? AND dedupe_key = ?", [r.source_type, r.dedupe_key]);
  return recordId(Number(row!.seq));
}

/** A stream source's records after `seq` (its listener wrote them), oldest first. */
export async function streamRecordsAfter(
  q: SqlExecutor,
  type: SourceType,
  seq: number,
  limit: number,
): Promise<{ seq: number; id: string; event: InboundEvent; received_at: string }[]> {
  const rows = await q.all(
    `SELECT seq, event, received_at FROM inbound_raw_records WHERE source_type = ? AND seq > ? AND dedupe_key NOT LIKE '${POLLED}%' ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`,
    [type, seq],
  );
  return rows.map((r) => ({ seq: Number(r.seq), id: recordId(Number(r.seq)), event: JSON.parse(String(r.event)) as InboundEvent, received_at: String(r.received_at) }));
}

/**
 * A record by id. `passport`: the edge passport inbound minted for it at the relay (RFC 0015 §8); a command event's
 * actor carries it, its expiry checked at the record's received time, as a command row's is at its recorded time.
 */
export async function readRecord(
  q: SqlExecutor,
  id: string,
  passport: string | null = null,
): Promise<{ source_type: SourceType; event: InboundEvent; received_at: string } | null> {
  const seq = RECORD_ID.exec(id)?.[1];
  if (!seq) return null;
  const [row] = await q.all("SELECT source_type, event, received_at FROM inbound_raw_records WHERE seq = ?", [Number(seq)]);
  if (!row) return null;
  const event = JSON.parse(String(row.event)) as InboundEvent;
  const received_at = String(row.received_at);
  return { source_type: row.source_type as SourceType, event: passport ? withPassport(event, { id: passport, at: received_at }) : event, received_at };
}

/** Who sent a person's command event (an approve, a retry, ...); null for any other event (a plain comment, an item request). */
export function commandActor(e: InboundEvent): ExternalIdentity | null {
  if (!("comment_id" in e) || e.kind === "plain_comment") return null;
  return "approver" in e ? e.approver : e.requester;
}

/** `e` with its command actor carrying `passport`; any other event unchanged. */
function withPassport(e: InboundEvent, passport: CommandPassport): InboundEvent {
  if (!("comment_id" in e) || e.kind === "plain_comment") return e;
  return "approver" in e ? { ...e, approver: { ...e.approver, passport } } : { ...e, requester: { ...e.requester, passport } };
}

/**
 * Removes records older than `before`: a stream source's only once its cursor (`through`) passed them, a polled
 * one always (its message went out with it).
 */
export async function pruneRecords(tx: SqlExecutor, before: string, streams: readonly { type: SourceType; through: number }[]): Promise<number> {
  let n = await tx.run(`DELETE FROM inbound_raw_records WHERE dedupe_key LIKE '${POLLED}%' AND received_at < ?`, [before]);
  for (const s of streams) {
    n += await tx.run(`DELETE FROM inbound_raw_records WHERE source_type = ? AND seq <= ? AND dedupe_key NOT LIKE '${POLLED}%' AND received_at < ?`, [
      s.type,
      s.through,
      before,
    ]);
  }
  return n;
}

/** A row of `inbound_commands` as the controller reads it. */
export function commandOf(row: Row): CliCommand {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    origin: String(row.origin),
    key: String(row.command_key),
    actor: String(row.actor),
    command: String(row.command),
    args: JSON.parse(String(row.args)) as Record<string, unknown>,
    ...(Number(row.mirror) === 1 ? { mirror: true } : {}),
    ...(row.passport_id != null ? { passport_id: String(row.passport_id) } : {}),
    created_at: row.created_at as CliCommand["created_at"],
  };
}

export async function commandsAfter(q: SqlExecutor, seq: number, limit: number): Promise<CliCommand[]> {
  const rows = await q.all(`SELECT * FROM inbound_commands WHERE seq > ? ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`, [seq]);
  return rows.map(commandOf);
}

export async function readCommand(q: SqlExecutor, id: string): Promise<CliCommand | null> {
  const [row] = await q.all("SELECT * FROM inbound_commands WHERE id = ?", [id]);
  return row ? commandOf(row) : null;
}
