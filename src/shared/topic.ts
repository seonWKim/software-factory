// Bus topics (RFC 0015 §5.5). Each component declares the topics it produces in `topics/<name>.topic.ts`;
// discovery finds them. A topic owns its message types, partitioning, consumption mode and retention.

import type { Envelope, MessageKind } from "./envelope.js";

/**
 * partitioned: one owner per partition, per-actor order (head-of-line retry).
 * fanout: like partitioned, but every consumer group gets every message.
 * competing: any consumer claims any row; no order (runs.requests).
 */
export type Consumption = "partitioned" | "fanout" | "competing";

export interface Backoff {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
}

export interface TopicDescriptor {
  readonly kind: "topic";
  /** Dotted name, e.g. "runs.requests". Its sql tables are bus_<name with dots as underscores>. */
  readonly name: string;
  /** The component that owns it (its producers' component, or the bus for system topics). */
  readonly owner: string;
  readonly messages: Readonly<Record<string, MessageKind>>;
  /** Which envelope value partitions the topic. Defaults to `subject`. */
  readonly partitionKey: (m: Envelope) => string;
  readonly partitions: number;
  readonly consumption: Consumption;
  readonly retentionMs: number;
  readonly backoff: Backoff;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 1_000, maxMs: 300_000, maxAttempts: 8 };
export const DEFAULT_PARTITIONS = 16;
export const TOPIC_NAME = /^[a-z]+(?:\.[a-z]+)+$/;

const DAY_MS = 86_400_000;

export function defineTopic(t: {
  name: string;
  owner: string;
  messages: Record<string, MessageKind>;
  partitionKey?: (m: Envelope) => string;
  partitions?: number;
  consumption: Consumption;
  retentionDays: number;
  backoff?: Partial<Backoff>;
}): TopicDescriptor {
  if (!TOPIC_NAME.test(t.name)) throw new Error(`topic name "${t.name}" must be dotted lowercase, e.g. runs.requests`);
  if (Object.keys(t.messages).length === 0) throw new Error(`topic "${t.name}" declares no message type`);
  if (!(t.retentionDays > 0)) throw new Error(`topic "${t.name}" needs a retention`);
  return {
    kind: "topic",
    name: t.name,
    owner: t.owner,
    messages: t.messages,
    partitionKey: t.partitionKey ?? ((m) => m.subject),
    partitions: t.partitions ?? DEFAULT_PARTITIONS,
    consumption: t.consumption,
    retentionMs: t.retentionDays * DAY_MS,
    backoff: { ...DEFAULT_BACKOFF, ...t.backoff },
  };
}

/** The sql bus's message table of a topic. */
export function topicTable(name: string): string {
  return `bus_${name.replace(/\./g, "_")}`;
}

/** The longest a message can come again through the bus's own retries: the floor for a producer's TTL. */
export function maxRedeliveryMs(b: Backoff): number {
  let total = 0;
  for (let attempt = 1; attempt < b.maxAttempts; attempt++) total += Math.min(b.maxMs, b.baseMs * 2 ** (attempt - 1));
  return total;
}

/** A stable partition number for a key (FNV-1a), the same on every node and dialect. */
export function partitionOf(key: string, partitions: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % partitions;
}
