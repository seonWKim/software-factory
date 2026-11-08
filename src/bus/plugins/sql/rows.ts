// Helpers shared by the sql bus and its scheduler: the release horizon, time arithmetic on ISO strings
// (never a clock read), retry delays, and rows back into envelopes.

import type { Envelope, Payload } from "../../../shared/envelope.js";
import { partitionOf, type Backoff } from "../../../shared/topic.js";
import type { Row, SqlExecutor } from "../../../state/index.js";
import { SCHEDULER_TABLE } from "./ddl.js";

/**
 * The bus's time: the `now` of the retry scheduler's latest tick. A retry, a delayed message or an expired
 * lease becomes due only once the horizon passes it, so consumers never read a clock (RFC 0015 §5.3).
 */
export async function readHorizon(db: SqlExecutor): Promise<string> {
  const [row] = await db.all(`SELECT released_until FROM ${SCHEDULER_TABLE} WHERE id = 1`);
  if (!row) throw new Error(`${SCHEDULER_TABLE} has no row: the bus migration has not run`);
  return String(row.released_until);
}

/**
 * Exponential backoff after failed attempt `attempt` (1-based), with up to 20% jitter taken off, never added,
 * so the topic's maximum redelivery (the floor of a producer's TTL) still holds. The jitter is a hash of
 * `seed`, the same on every node.
 */
export function retryDelayMs(b: Backoff, attempt: number, seed: string): number {
  const full = Math.min(b.maxMs, b.baseMs * 2 ** (attempt - 1));
  return Math.round(full * (1 - partitionOf(seed, 1000) / 5000));
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function envelopeOf(r: Row): Envelope {
  return {
    id: String(r.id),
    type: String(r.type),
    schema_version: Number(r.schema_version),
    subject: String(r.subject),
    project_id: String(r.project_id),
    idempotency_key: String(r.idempotency_key),
    idempotency_key_ttl_ms: r.idempotency_key_ttl_ms === null || r.idempotency_key_ttl_ms === undefined ? null : Number(r.idempotency_key_ttl_ms),
    causation_id: str(r.causation_id),
    correlation_id: String(r.correlation_id),
    passport_id: str(r.passport_id),
    producer: String(r.producer),
    occurred_at: String(r.occurred_at),
    not_before: str(r.not_before),
    payload: JSON.parse(String(r.payload)) as Payload,
  };
}

/** The message columns of a topic table, in insert order. */
export const MESSAGE_COLUMNS =
  "id, type, schema_version, subject, partition_key, `partition`, project_id, idempotency_key, idempotency_key_ttl_ms, " +
  "causation_id, correlation_id, passport_id, producer, occurred_at, not_before, payload, published_at";
