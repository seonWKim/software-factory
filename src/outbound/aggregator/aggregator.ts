// The aggregator (RFC 0015 §7 Outbound, §15.1): each DeliveryRequested's intents join a batch of their destination,
// in the consumer's transaction. A new commit joins the destination's open batch while the batching rules still
// hold it (a debounce), else opens its own; its flush time is decided by the rules at the message's time.

import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../state/index.js";
import { CHATTY_WINDOW_MS, flushAt, joins, type BatchingPolicy, type Budget } from "./batching.js";

export interface Requested {
  readonly commit_id: string;
  readonly commit_count: number;
  readonly destination: string;
  readonly intent_ids: readonly string[];
  readonly reply: boolean;
}

/** Adds one request's intents to a batch of its destination; returns the batch id. */
export async function aggregate(tx: SqlExecutor, r: Requested, policy: BatchingPolicy, budget: Budget | null, now: string): Promise<string> {
  const since = new Date(Date.parse(now) - CHATTY_WINDOW_MS).toISOString();
  const [recent] = await tx.all("SELECT COUNT(*) AS n FROM outbound_batches WHERE destination = ? AND state = 'sent' AND sent_at >= ?", [r.destination, since]);
  const stats = { recent_deliveries: Number(recent?.n ?? 0) };
  const [open] = await tx.all(
    "SELECT id, opened_at, flush_at, intent_count, reply FROM outbound_batches WHERE destination = ? AND state = 'open' ORDER BY seq DESC LIMIT 1",
    [r.destination],
  );
  const reply = r.reply;
  let batch: string;
  if (open && joins(policy, { opened_at: String(open.opened_at), flush_at: String(open.flush_at), intent_count: Number(open.intent_count), reply: Number(open.reply) === 1 }, now)) {
    batch = String(open.id);
    const view = { opened_at: String(open.opened_at), intent_count: Number(open.intent_count) + r.intent_ids.length, reply: reply || Number(open.reply) === 1 };
    await tx.run("UPDATE outbound_batches SET intent_count = ?, reply = ?, flush_at = ? WHERE id = ?", [
      view.intent_count, view.reply ? 1 : 0, flushAt(policy, stats, budget, view, now), batch,
    ]);
  } else {
    batch = `bat_${randomUUID()}`;
    const view = { opened_at: now, intent_count: r.intent_ids.length, reply };
    await tx.run(
      `INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, reply, opened_at, flush_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
      [batch, r.destination, `${r.destination}:${r.commit_id}`, view.intent_count, reply ? 1 : 0, now, flushAt(policy, stats, budget, view, now)],
    );
  }
  for (const id of r.intent_ids) {
    await tx.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, ?, ?, ?)", [id, batch, r.commit_id, r.commit_count]);
  }
  return batch;
}
