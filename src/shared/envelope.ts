// The message envelope every component sends on the bus (RFC 0015 §5.1). Messages carry ids, never
// bodies: the owner of a body stores it once and others load it by id through the owner's index.ts.

import { randomUUID } from "node:crypto";

/** A payload value. Strings longer than MAX_PAYLOAD_STRING are refused: store the text and send its id. */
export type Scalar = string | number | boolean | null;
export type Payload = Readonly<Record<string, Scalar | readonly Scalar[]>>;

export const MAX_PAYLOAD_STRING = 200;
/** The longest id, key, subject or producer: the bus stores them in VARCHAR(191) columns on MySQL. */
export const MAX_KEY_LENGTH = 191;

export type MessageKind = "command" | "event";

export interface Envelope<T extends string = string, P extends Payload = Payload> {
  readonly id: string;
  readonly type: T;
  readonly schema_version: number;
  /** The actor this message is about; also the default partition key. */
  readonly subject: string;
  readonly project_id: string;
  readonly idempotency_key: string;
  /** Always present. null: the key never expires (a command from a person, a run request). */
  readonly idempotency_key_ttl_ms: number | null;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  /** null only for system messages from the runtime. */
  readonly passport_id: string | null;
  /** The handler or plugin that produced it. */
  readonly producer: string;
  /** From the message or tick that caused it; handlers never read a clock. */
  readonly occurred_at: string;
  /** A delayed message (durable timer): not delivered before this time. */
  readonly not_before: string | null;
  readonly payload: P;
}

/** What a producer fills in; the rest is derived from the cause. */
export interface Draft<T extends string = string, P extends Payload = Payload> {
  readonly type: T;
  readonly schema_version?: number;
  readonly subject: string;
  readonly idempotency_key: string;
  readonly idempotency_key_ttl_ms: number | null;
  readonly payload: P;
  readonly not_before?: string | null;
  readonly project_id?: string;
  readonly passport_id?: string | null;
}

/** The message or tick a new message follows from. */
export interface Cause {
  readonly id: string | null;
  readonly correlation_id: string;
  readonly project_id: string;
  readonly passport_id: string | null;
  readonly occurred_at: string;
}

/** The cause of what a handler emits for `m`: the same trace, project, passport and time. */
export function causeOf(m: Envelope): Cause {
  return { id: m.id, correlation_id: m.correlation_id, project_id: m.project_id, passport_id: m.passport_id, occurred_at: m.occurred_at };
}

export function newMessageId(): string {
  return randomUUID();
}

/** Builds an envelope from a draft and its cause. `id` is injectable so tests stay deterministic. */
export function envelope<T extends string, P extends Payload>(
  draft: Draft<T, P>,
  cause: Cause,
  producer: string,
  id: string = newMessageId(),
): Envelope<T, P> {
  return {
    id,
    type: draft.type,
    schema_version: draft.schema_version ?? 1,
    subject: draft.subject,
    project_id: draft.project_id ?? cause.project_id,
    idempotency_key: draft.idempotency_key,
    idempotency_key_ttl_ms: draft.idempotency_key_ttl_ms,
    causation_id: cause.id,
    correlation_id: cause.correlation_id,
    passport_id: draft.passport_id === undefined ? cause.passport_id : draft.passport_id,
    producer,
    occurred_at: cause.occurred_at,
    not_before: draft.not_before ?? null,
    payload: draft.payload,
  };
}

/** Every problem with an envelope's shape (envelope-shape test, and the bus before it publishes). */
export function envelopeProblems(m: Envelope): string[] {
  const out: string[] = [];
  for (const field of ["id", "type", "subject", "project_id", "idempotency_key", "correlation_id", "producer", "occurred_at"] as const) {
    if (typeof m[field] !== "string" || m[field] === "") out.push(`${field} is missing`);
  }
  // Refused here rather than cut to the column: two keys sharing their first 191 characters would dedupe as one.
  for (const field of ["id", "type", "subject", "project_id", "idempotency_key", "causation_id", "correlation_id", "passport_id", "producer"] as const) {
    const v = m[field];
    if (typeof v === "string" && v.length > MAX_KEY_LENGTH) out.push(`${field} is longer than ${MAX_KEY_LENGTH} chars`);
  }
  if (!Number.isInteger(m.schema_version) || m.schema_version < 1) out.push("schema_version must be a positive integer");
  if (!("idempotency_key_ttl_ms" in m)) out.push("idempotency_key_ttl_ms is missing (null means never expires)");
  else if (m.idempotency_key_ttl_ms !== null && !(Number.isInteger(m.idempotency_key_ttl_ms) && m.idempotency_key_ttl_ms > 0)) {
    out.push("idempotency_key_ttl_ms must be a positive integer or null");
  }
  for (const [key, value] of Object.entries(m.payload)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== null && !["string", "number", "boolean"].includes(typeof v)) out.push(`payload.${key} is not a scalar`);
      else if (typeof v === "string" && v.length > MAX_PAYLOAD_STRING) out.push(`payload.${key} is longer than ${MAX_PAYLOAD_STRING} chars: store it and send its id`);
    }
  }
  return out;
}
