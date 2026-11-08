// Delivery intents (RFC 0015 §7 Outbound, M7): what a producer wants written to the outside world, stored by id.
// A thread entry's intent is its outbound_intents row (`int_<seq>`, written with the entry); every other write
// (a status label, a 👀 reaction, an issue close, a post on a source with no work item) is an outbound_actions row
// (`act_<seq>`). `announce` publishes the intents no DeliveryRequested named yet, one message per destination,
// in the producer's bus transaction: the payload carries ids only.

import { insertOrSkip, type EventBus } from "../bus/index.js";
import type { SourceRef } from "../core/types.js";
import { envelope, newMessageId, type Envelope } from "../shared/envelope.js";
import type { SqlDriver, SqlExecutor } from "../state/index.js";
import { DELIVERY_REQUESTED } from "./topics/deliveries-requests.topic.js";

/**
 * A write that is no thread entry. `status`, `seen` are best effort; `close`, `post` and `close_pr` (a PR closed with
 * a comment, through the forge) retry until delivered.
 */
export type ActionKind = "status" | "seen" | "close" | "post" | "close_pr";

export interface NewAction {
  readonly action: ActionKind;
  /** Where the write lands: an issue, a thread, or the forge's PR ref. */
  readonly target: SourceRef;
  readonly work_item_id?: string | null;
  /** The action's arguments (status and change_ref, the reacted comment id, a close reason, a post's body and marker). */
  readonly args: Readonly<Record<string, string | number | null>>;
  /** Set: the action is stored at most once under this key, so recording it again stores nothing (RFC 0015 §5.2). */
  readonly key?: string;
}

export interface ActionRow extends NewAction {
  readonly seq: number;
  readonly source_type: string;
  readonly delivered_at: string | null;
}

/** Thread entries' intents are `int_<seq>`, actions `act_<seq>` (RFC 0015 §12 backfill rule). */
export const THREAD_INTENT = "int_";
export const ACTION_INTENT = "act_";

/** Where an intent goes: `<target type>:<target id>`; one partition, one batch order per destination. */
export function destinationOf(target: SourceRef): string {
  return `${target.type}:${target.id}`;
}

/** A delivery's key outlives every redelivery of deliveries.requests (7 days, as its retention). */
const REQUEST_TTL_MS = 7 * 86_400_000;
/** Intents one announce publishes at most; the next announce takes the rest. */
const ANNOUNCE_BATCH = 200;

/** Stores an action intent; the producer's next `announce` requests it. A keyed action already stored: nothing. */
export async function recordAction(db: SqlDriver, a: NewAction, now: string): Promise<void> {
  await db.run(
    insertOrSkip(db.dialect.name, "outbound_actions (work_item_id, source_type, target, action, args, intent_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    [a.work_item_id ?? null, a.target.type, JSON.stringify(a.target), a.action, JSON.stringify(a.args), a.key ?? null, now],
  );
}

/** The action rows among `intent_ids` (thread entries are left out), in intent order. */
export async function actionsOf(db: SqlExecutor, intent_ids: readonly string[]): Promise<ActionRow[]> {
  const seqs = intent_ids.filter((id) => id.startsWith(ACTION_INTENT)).map((id) => Number(id.slice(ACTION_INTENT.length)));
  if (seqs.length === 0) return [];
  const rows = await db.all(`SELECT * FROM outbound_actions WHERE seq IN (${seqs.map(() => "?").join(", ")}) ORDER BY seq`, seqs);
  return rows.map(actionOf);
}

export function actionOf(row: Record<string, unknown>): ActionRow {
  return {
    seq: Number(row.seq),
    action: row.action as ActionKind,
    source_type: String(row.source_type),
    target: JSON.parse(String(row.target)) as SourceRef,
    work_item_id: (row.work_item_id as string | null) ?? null,
    args: JSON.parse(String(row.args)) as NewAction["args"],
    delivered_at: (row.delivered_at as string | null) ?? null,
  };
}

interface Pending {
  readonly id: string;
  readonly destination: string;
  readonly reply: boolean;
}

/** Intents no DeliveryRequested named yet, oldest first: thread entries, then actions. */
async function unannounced(tx: SqlExecutor, dialect: SqlDriver["dialect"]["name"]): Promise<Pending[]> {
  const id = (prefix: string, col: string) => (dialect === "mysql" ? `CONCAT('${prefix}', ${col})` : `'${prefix}' || ${col}`);
  const threads = await tx.all(
    `SELECT o.seq, o.target FROM outbound_intents o
     WHERE o.delivered_at IS NULL AND NOT EXISTS (SELECT 1 FROM outbound_requests r WHERE r.intent_id = ${id(THREAD_INTENT, "o.seq")})
     ORDER BY o.seq LIMIT ${ANNOUNCE_BATCH}`,
  );
  const actions = await tx.all(
    `SELECT a.seq, a.target, a.action FROM outbound_actions a
     WHERE a.delivered_at IS NULL AND NOT EXISTS (SELECT 1 FROM outbound_requests r WHERE r.intent_id = ${id(ACTION_INTENT, "a.seq")})
     ORDER BY a.seq LIMIT ${ANNOUNCE_BATCH}`,
  );
  const target = (r: Record<string, unknown>) => JSON.parse(String(r.target)) as SourceRef;
  return [
    ...threads.map((r) => ({ id: `${THREAD_INTENT}${Number(r.seq)}`, destination: destinationOf(target(r)), reply: false })),
    // A 👀 acknowledges a person's comment: never delayed (§15.1).
    ...actions.map((r) => ({ id: `${ACTION_INTENT}${Number(r.seq)}`, destination: destinationOf(target(r)), reply: r.action === "seen" })),
  ];
}

/**
 * One commit of DeliveryRequested: every intent not announced yet, grouped by destination, each group one message
 * with the commit's id and its count. The intents are marked requested in the same transaction as the messages
 * enter the caller's outbox, so each is requested exactly once. Returns how many intents it announced.
 */
export async function announce(db: SqlDriver, bus: EventBus, project_id: string, now: string, producer: string): Promise<number> {
  return db.transaction(async (tx) => {
    const pending = await unannounced(tx, db.dialect.name);
    if (pending.length === 0) return 0;
    const commit_id = newMessageId();
    const groups = new Map<string, Pending[]>();
    for (const p of pending) groups.set(p.destination, [...(groups.get(p.destination) ?? []), p]);
    const messages: Envelope[] = [];
    let announced = 0;
    for (const [destination, intents] of groups) {
      const fresh: Pending[] = [];
      for (const i of intents) {
        // Another replica's announce took it first: it is requested once, there.
        const inserted = await insertOrSkip(tx, db.dialect.name, "outbound_requests (intent_id, destination, commit_id, commit_count, requested_at) VALUES (?, ?, ?, ?, ?)", [
          i.id, destination, commit_id, intents.length, now,
        ]);
        if (inserted) fresh.push(i);
      }
      if (fresh.length === 0) continue;
      if (fresh.length !== intents.length) {
        await tx.run(`UPDATE outbound_requests SET commit_count = ? WHERE commit_id = ? AND destination = ?`, [fresh.length, commit_id, destination]);
      }
      announced += fresh.length;
      messages.push(envelope(
        {
          type: DELIVERY_REQUESTED,
          subject: destination,
          idempotency_key: `${commit_id}:${destination}`,
          idempotency_key_ttl_ms: REQUEST_TTL_MS,
          payload: { commit_id, commit_count: fresh.length, destination, intent_ids: fresh.map((i) => i.id), reply: fresh.some((i) => i.reply) },
        },
        { id: null, correlation_id: commit_id, project_id, passport_id: null, occurred_at: now },
        producer,
      ));
    }
    await bus.publish(tx, messages);
    return announced;
  });
}
