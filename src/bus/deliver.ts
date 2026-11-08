// Effectively-once handling of one claimed message (RFC 0015 §5.2): the inbox row, the consumer's state
// change and its outbox rows commit in one transaction, and only then is the message acked. A crash before
// the ack redelivers it; the inbox then finds the key and the message is acked with no effect.

import type { Envelope } from "../shared/envelope.js";
import type { Claimed, EventBus, Inbox, NackError, Tx } from "./index.js";

export type DeliverOutcome = "handled" | "duplicate" | "failed";

export interface TransactionRunner {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

function retryable(err: unknown): NackError {
  return { retryable: true, code: "error", detail: err instanceof Error ? err.message : String(err) };
}

export async function deliver(
  db: TransactionRunner,
  bus: EventBus,
  inbox: Inbox,
  consumer: string,
  c: Claimed,
  effect: (tx: Tx, m: Envelope) => Promise<void>,
  classify: (err: unknown) => NackError = retryable,
): Promise<DeliverOutcome> {
  let outcome: DeliverOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      if ((await inbox.claim(tx, consumer, c.message)) === "duplicate") return "duplicate";
      await effect(tx, c.message);
      return "handled";
    });
  } catch (err) {
    await bus.nack(c, classify(err));
    return "failed";
  }
  await bus.ack(c);
  return outcome;
}
