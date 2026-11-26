// Local work items (issue #198): the item thread (`controller_item_thread`), its outbox (issue #282) and the command
// inbox (`inbound_commands`, issue #245), kept out of sql-factory-store.ts so that file stays within its line budget.
// Outbox claims are fenced by a token that only a claim bumps, like run leases.

import { createHash } from "node:crypto";
import type { SourceRef, SourceType, Timestamp, UserId, WorkItemId } from "../../../core/types.js";
import type {
  AppCommandRequest, CliCommand, ItemMessage, NewAppCommandRequest, NewCliCommand, NewItemMessage, RunIntent, SyncFence, ThreadDelivery, ThreadLinkField, WriteOrigin,
} from "../../../interfaces/factory-store.js";
import { recordAction } from "../../../outbound/index.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { placeholders } from "./retention.js";
import { type StoreTime, insertOnce } from "./store-steps.js";

export async function recordRunIntent(db: SqlDriver, time: StoreTime, intent: RunIntent): Promise<void> {
  await recordAction(db, intent, time.now());
}

export async function recordItemMessage(db: SqlDriver, time: StoreTime, input: NewItemMessage): Promise<{ created: boolean; message: ItemMessage }> {
  return db.transaction(async (tx) => {
    const existing = await selectItemMessage(tx, input.work_item_id, input.marker);
    if (existing) return { created: false, message: existing };
    const now = time.now();
    const created = await insertOnce(
      db, tx,
      "INSERT INTO controller_item_thread (work_item_id, marker, body, created_at, actor) VALUES (?, ?, ?, ?, ?)",
      [input.work_item_id, input.marker, input.body, now, input.actor ?? null],
    );
    const message = (await selectItemMessage(tx, input.work_item_id, input.marker))!;
    const d = input.delivery;
    if (created && d) {
      await tx.run(
        `INSERT INTO outbound_intents (thread_seq, work_item_id, source_type, target, link_field, attempts, next_attempt_at, claim_token,
           created_at) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)`,
        [message.seq, input.work_item_id, d.source_type, JSON.stringify(d.target), d.link_field ?? null, now, now],
      );
    }
    return { created, message };
  });
}

// The thread outbox (issue #282). Claims are fenced by a token that only a claim bumps, like run leases.

export async function listPendingDeliveries(db: SqlDriver, time: StoreTime, source_types: readonly SourceType[], limit: number): Promise<ThreadDelivery[]> {
  if (source_types.length === 0) return [];
  const now = time.now();
  const rows = await db.all(
    `${DELIVERY_SELECT} WHERE o.delivered_at IS NULL AND o.source_type IN (${placeholders(source_types.length)})
       AND o.next_attempt_at <= ? AND (o.claimed_until IS NULL OR o.claimed_until <= ?)
     ORDER BY o.seq LIMIT ${Math.max(0, Math.floor(limit))}`,
    [...source_types, now, now],
  );
  return rows.map(rowToDelivery);
}

export async function listDeliveries(db: SqlDriver, work_item_id: WorkItemId): Promise<ThreadDelivery[]> {
  const rows = await db.all(`${DELIVERY_SELECT} WHERE o.work_item_id = ? ORDER BY o.seq`, [work_item_id]);
  return rows.map(rowToDelivery);
}

export async function claimDelivery(db: SqlDriver, time: StoreTime, seq: number, lease_ms: number, fence?: SyncFence): Promise<number | null> {
  return claimQueued(db, time, QUEUES.outbox, seq, lease_ms, fence);
}

export async function getDelivery(db: SqlDriver, seq: number): Promise<ThreadDelivery | null> {
  const [row] = await db.all(`${DELIVERY_SELECT} WHERE o.seq = ?`, [seq]);
  return row ? rowToDelivery(row) : null;
}

export async function finishDelivery(db: SqlDriver, time: StoreTime, seq: number, token: number, url: string | null): Promise<boolean> {
  const n = await db.run(
    `UPDATE outbound_intents SET delivered_at = ?, url = ?, claimed_until = NULL, last_error = NULL
     WHERE seq = ? AND claim_token = ? AND delivered_at IS NULL AND claimed_until IS NOT NULL`,
    [time.now(), url, seq, token],
  );
  return n > 0;
}

export async function linkDelivery(db: SqlDriver, seq: number): Promise<void> {
  const [row] = await db.all("SELECT work_item_id, link_field, url FROM outbound_intents WHERE seq = ? AND delivered_at IS NOT NULL", [seq]);
  const field = row?.link_field as string | null | undefined;
  const url = row?.url as string | null | undefined;
  if (!row || !url || (field !== "spec_comment_url" && field !== "failure_comment_url")) return;
  // Only the item's newest entry for this field fills it: an older one delivered late never hides a newer.
  await db.run(
    `UPDATE controller_work_items SET ${field} = ? WHERE id = ? AND NOT EXISTS (
       SELECT 1 FROM outbound_intents n WHERE n.work_item_id = ? AND n.link_field = ? AND n.seq > ?)`,
    [url, row.work_item_id as string, row.work_item_id as string, field, seq],
  );
}

export async function failDelivery(db: SqlDriver, time: StoreTime, seq: number, token: number, error: string, retry_in_ms: number): Promise<boolean> {
  return failQueued(db, time, QUEUES.outbox, seq, token, error, retry_in_ms);
}

/** Claims row `seq` of a queue for `lease_ms`: only an unfinished row with no live claim (and, with `fence`, a held lease). */
async function claimQueued(db: SqlDriver, time: StoreTime, q: Queue, seq: number, lease_ms: number, fence?: SyncFence): Promise<number | null> {
  return db.transaction(async (tx) => {
    if (fence && !(await fenceHeld(tx, fence))) return null;
    const now = time.now();
    const until = time.after(Math.max(0, lease_ms));
    const n = await tx.run(
      `UPDATE ${q.table} SET claim_token = claim_token + 1, claimed_until = ?
       WHERE seq = ? AND ${q.done} IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)`,
      [until, seq, now],
    );
    if (n === 0) return null;
    const [row] = await tx.all(`SELECT claim_token FROM ${q.table} WHERE seq = ?`, [seq]);
    return Number(row!.claim_token);
  });
}

/** A failed try of row `seq` under claim `token`: one more attempt, the error, the claim released, the next try later. */
async function failQueued(db: SqlDriver, time: StoreTime, q: Queue, seq: number, token: number, error: string, retry_in_ms: number): Promise<boolean> {
  const next = time.after(Math.max(0, retry_in_ms));
  const n = await db.run(
    `UPDATE ${q.table} SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, claimed_until = NULL
     WHERE seq = ? AND claim_token = ? AND ${q.done} IS NULL AND claimed_until IS NOT NULL`,
    [error.slice(0, 1000), next, seq, token],
  );
  return n > 0;
}

export async function listItemMessages(db: SqlDriver, work_item_id: WorkItemId): Promise<ItemMessage[]> {
  const rows = await db.all("SELECT * FROM controller_item_thread WHERE work_item_id = ? ORDER BY seq", [work_item_id]);
  return rows.map(rowToItemMessage);
}

export async function appendCliCommand(db: SqlDriver, time: StoreTime, input: NewCliCommand): Promise<{ created: boolean; command: CliCommand }> {
  return db.transaction(async (tx) => {
    const existing = await selectCliCommand(tx, input.key);
    if (existing) return { created: false, command: existing };
    await lockCommandSequence(tx);
    const created = await insertOnce(
      db, tx,
      "INSERT INTO inbound_commands (id, origin, command_key, actor, command, args, created_at, mirror, passport_id, write_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [commandId(input.key), commandOrigin(input.key), input.key, input.actor, input.command, JSON.stringify(input.args), time.now(), input.mirror ? 1 : 0, input.passport_id ?? null, input.write_origin ?? null],
    );
    return { created, command: (await selectCliCommand(tx, input.key))! };
  });
}

export async function listCliCommandsAfter(db: SqlDriver, after_seq: number, limit: number): Promise<CliCommand[]> {
  const rows = await db.all(`SELECT * FROM inbound_commands WHERE seq > ? ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`, [
    after_seq,
  ]);
  return rows.map(rowToCliCommand);
}

export async function listUnmirroredCliCommands(db: SqlDriver, limit: number): Promise<CliCommand[]> {
  const rows = await db.all(
    `SELECT * FROM inbound_commands WHERE mirror = 1 AND mirrored_at IS NULL ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`,
  );
  return rows.map(rowToCliCommand);
}

export async function markCliCommandMirrored(db: SqlDriver, time: StoreTime, key: string): Promise<boolean> {
  const n = await db.run("UPDATE inbound_commands SET mirrored_at = ? WHERE command_key = ? AND mirror = 1 AND mirrored_at IS NULL", [
    time.now(),
    key,
  ]);
  return n > 0;
}

// App command requests (issue #245)

export async function recordAppCommandRequest(db: SqlDriver, time: StoreTime, input: NewAppCommandRequest): Promise<{ created: boolean; request: AppCommandRequest }> {
  return db.transaction(async (tx) => {
    const existing = await selectAppCommandRequest(tx, input.key);
    if (existing) return { created: false, request: existing };
    await lockCommandSequence(tx);
    const created = await insertOnce(
      db, tx,
      "INSERT INTO inbound_commands (id, origin, command_key, actor, command, args, created_at, passport_id) VALUES (?, 'app', ?, ?, ?, ?, ?, ?)",
      [commandId(input.key), input.key, input.actor, input.command, JSON.stringify(input.args), time.now(), input.passport_id ?? null],
    );
    return { created, request: (await selectAppCommandRequest(tx, input.key))! };
  });
}

export async function markAppCommandRequest(db: SqlDriver, time: StoreTime, seq: number, refusal: string | null): Promise<boolean> {
  const n = await db.run(`UPDATE inbound_commands SET handled_at = ?, refusal = ? WHERE ${APP_REQUEST_SEQ} AND handled_at IS NULL`, [
    time.now(),
    refusal,
    seq,
    seq,
  ]);
  return n > 0;
}

export async function getAppCommandRequest(db: SqlDriver, ref: number | string): Promise<AppCommandRequest | null> {
  if (typeof ref === "string") return selectAppCommandRequest(db, ref);
  const [row] = await db.all(`SELECT * FROM inbound_commands WHERE ${APP_REQUEST_SEQ}`, [ref, ref]);
  return row ? rowToAppCommandRequest(row) : null;
}

export async function listAppCommandRequestsForItem(db: SqlDriver, id: WorkItemId, limit: number): Promise<AppCommandRequest[]> {
  return (await itemCommandRows(db, id, "origin = 'app'", ["work_item_id"], limit)).map(rowToAppCommandRequest).filter((r) => r.args.work_item_id === id);
}
export async function listItemCommands(db: SqlDriver, id: WorkItemId, limit: number): Promise<CliCommand[]> {
  return (await itemCommandRows(db, id, "origin IN ('cli', 'app')", ["item", "work_item_id"], limit)).map(rowToCliCommand).filter((c) => (c.args.item ?? c.args.work_item_id) === id);
}
/** The newest `limit` rows of `origins` (SQL) whose `args` (JSON text, the pair verbatim) name `id` in a field, oldest first; LIKE narrows, callers check the exact id. */
function itemCommandRows(db: SqlDriver, id: WorkItemId, origins: string, fields: string[], limit: number): Promise<Row[]> {
  const like = (f: string) => `%${`${JSON.stringify(f)}:${JSON.stringify(id)}`.replace(/[!%_]/g, (c) => `!${c}`)}%`;
  return db.all(`SELECT * FROM (SELECT * FROM inbound_commands WHERE ${origins} AND (${fields.map(() => "args LIKE ? ESCAPE '!'").join(" OR ")}) ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}) ORDER BY seq`, fields.map(like));
}

async function selectItemMessage(q: SqlExecutor, work_item_id: WorkItemId, marker: string): Promise<ItemMessage | null> {
  const [row] = await q.all("SELECT * FROM controller_item_thread WHERE work_item_id = ? AND marker = ?", [work_item_id, marker]);
  return row ? rowToItemMessage(row) : null;
}

async function selectAppCommandRequest(q: SqlExecutor, key: string): Promise<AppCommandRequest | null> {
  const [row] = await q.all("SELECT * FROM inbound_commands WHERE command_key = ? AND origin = 'app'", [key]);
  return row ? rowToAppCommandRequest(row) : null;
}

async function selectCliCommand(q: SqlExecutor, key: string): Promise<CliCommand | null> {
  const [row] = await q.all("SELECT * FROM inbound_commands WHERE command_key = ?", [key]);
  return row ? rowToCliCommand(row) : null;
}

/** Whether `fence.token` is still the token of its sync lease. A takeover (token + 1) waits for the fenced write to commit, so no write lands after another replica took the lease. */
async function fenceHeld(tx: SqlExecutor, fence: SyncFence): Promise<boolean> {
  const [held] = await tx.all(`SELECT token FROM inbound_sync_leases WHERE name = ? AND token = ?`, [fence.name, fence.token]);
  return held !== undefined;
}

/**
 * Reads the `commands` lock row, which a driver with row locks holds until the transaction ends, so inserts into
 * `inbound_commands` commit in seq order and inbound's cursor (`seq > cursor`) never skips a lower seq (design
 * 10-event-driven, sequence locks). SQLite has one writer, so there the read only checks that the row exists.
 */
async function lockCommandSequence(tx: SqlExecutor): Promise<void> {
  const [row] = await tx.all(`SELECT name FROM inbound_sequence_locks WHERE name = 'commands'`);
  if (!row) throw new Error("inbound_sequence_locks has no commands row: run npm run migrate");
}

function rowToItemMessage(row: Row): ItemMessage {
  return {
    seq: Number(row.seq),
    work_item_id: row.work_item_id as WorkItemId,
    marker: row.marker as string,
    body: row.body as string,
    created_at: row.created_at as Timestamp,
    ...(row.actor != null && { actor: row.actor as string }),
  };
}

const DELIVERY_SELECT =
  "SELECT o.*, t.marker AS thread_marker, t.body AS thread_body FROM outbound_intents o JOIN controller_item_thread t ON t.seq = o.thread_seq";

/** The claimed queues: their table and the column that marks a row done. Fixed names, never input. */
type Queue = { table: string; done: string };
const QUEUES = {
  outbox: { table: "outbound_intents", done: "delivered_at" },
} as const satisfies Record<string, Queue>;

function rowToDelivery(row: Row): ThreadDelivery {
  return {
    seq: Number(row.seq),
    thread_seq: Number(row.thread_seq),
    work_item_id: row.work_item_id as WorkItemId,
    source_type: row.source_type as SourceType,
    target: JSON.parse(row.target as string) as SourceRef,
    link_field: (row.link_field as ThreadLinkField | null) ?? null,
    marker: row.thread_marker as string,
    body: row.thread_body as string,
    attempts: Number(row.attempts),
    next_attempt_at: row.next_attempt_at as Timestamp,
    delivered_at: (row.delivered_at as Timestamp | null) ?? null,
    url: (row.url as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as Timestamp,
  };
}

/** An app request by seq (RFC 0015 D7): one recorded before the merge keeps its old seq as `legacy_seq`; `?` twice. */
const APP_REQUEST_SEQ = "origin = 'app' AND ((legacy_table = 'app_command_requests' AND legacy_seq = ?) OR (legacy_table IS NULL AND seq = ?))";
/** A command's id from its key, so a repeated append computes the same one; its origin from the key's prefix. */
const commandId = (key: string) => `cmd_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
const commandOrigin = (key: string) => (key.startsWith("github:") ? "github" : key.startsWith("app:") ? "app" : "cli");

function rowToCliCommand(row: Row): CliCommand {
  return {
    seq: Number(row.seq),
    id: row.id as string,
    origin: row.origin as string,
    key: row.command_key as string,
    actor: row.actor as string,
    command: row.command as string,
    args: JSON.parse(row.args as string) as Record<string, unknown>,
    ...(Number(row.mirror) === 1 ? { mirror: true } : {}),
    ...(row.passport_id != null ? { passport_id: String(row.passport_id) } : {}),
    ...(row.write_origin != null ? { write_origin: row.write_origin as WriteOrigin } : {}),
    created_at: row.created_at as Timestamp,
  };
}

function rowToAppCommandRequest(row: Row): AppCommandRequest {
  return {
    seq: row.legacy_table === "app_command_requests" ? Number(row.legacy_seq) : Number(row.seq),
    key: row.command_key as string,
    actor: row.actor as UserId,
    command: row.command as string,
    args: JSON.parse(row.args as string) as Record<string, unknown>,
    created_at: row.created_at as Timestamp,
    handled_at: (row.handled_at ?? null) as Timestamp | null,
    refusal: (row.refusal ?? null) as string | null,
  };
}
