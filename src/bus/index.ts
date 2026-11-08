// Bus component (RFC 0015 §5, §7): the EventBus, the outbox relay, the inbox, and the retry scheduler.
// Other components import only this file. `sql` is the default plugin; Kafka and NATS implement the same
// interfaces later, with the same keys and dedupe.

import type { Envelope } from "../shared/envelope.js";
import type { Tick } from "../shared/ticks/tick-generator.js";
import type { TopicDescriptor } from "../shared/topic.js";
import type { SqlDriver, SqlExecutor } from "../state/index.js";

/** The caller's open transaction: the outbox and inbox rows commit or roll back with its state change. */
export type Tx = SqlExecutor;

/** A message handed to one consumer of a group. Ack or nack it; an unacked claim is redelivered when its lease ends. */
export interface Claimed {
  readonly topic: string;
  readonly group: string;
  readonly partition: number;
  /** The message's position in its topic. */
  readonly seq: number;
  /** 1 on the first delivery to this group, then one more per retry. */
  readonly attempt: number;
  /** Fences the claim: an ack or nack after another consumer re-claimed the message changes nothing. */
  readonly token: number;
  readonly message: Envelope;
}

export interface NackError {
  /** Network, rate limit, conflict: retried with the topic's backoff. Otherwise dead-lettered at once. */
  readonly retryable: boolean;
  /** `unhandled` when no handler accepts the message (RFC 0015 §6.2). */
  readonly code: string;
  readonly detail?: string;
}

export interface EventBus {
  /** Writes the messages to the caller's component outbox, in the caller's transaction. The relay publishes them. */
  publish(tx: Tx, messages: readonly Envelope[]): Promise<void>;
  /** Claims up to `max` messages of `topic` for `group`. Per partition, one message at a time, in order. */
  consume(group: string, topic: string, max: number): Promise<Claimed[]>;
  ack(c: Claimed): Promise<void>;
  nack(c: Claimed, err: NackError): Promise<void>;
}

/** Dedupe by `(consumer, idempotency_key)` in the consumer's transaction (RFC 0015 §5.2). */
export interface Inbox {
  claim(tx: Tx, consumer: string, m: Envelope): Promise<"new" | "duplicate">;
}

/** A component's side of the bus, on its own ticks: `relay` publishes its outbox, `prune` drops expired inbox keys. */
export interface Relay {
  relay(tick: Tick): Promise<number>;
  prune(tick: Tick): Promise<void>;
}

/** The bus's own time-based work (RFC 0015 §7 Bus): release due retries and delayed messages, prune old rows. */
export interface RetryScheduler {
  release(tick: Tick): Promise<void>;
  prune(tick: Tick): Promise<void>;
}

/** What one component's bus is built from. */
export interface ComponentBusOptions {
  /** The component's database: its outbox and inbox commit in this driver's transactions. */
  readonly db: SqlDriver;
  /** The component it publishes and dedupes for (`<component>_outbox`, `<component>_inbox`). */
  readonly component: string;
  /** Every topic it publishes to or consumes (from discovery). */
  readonly topics: readonly TopicDescriptor[];
  /** This process, recorded as the owner of what it claims. */
  readonly consumerId: string;
  /**
   * What this consumer can do (`sandbox=docker`, `model=strong`): on a competing topic it claims only messages
   * whose `requires` are all among these. Absent: it claims only messages that require nothing.
   */
  readonly capabilities?: readonly string[];
}

/**
 * An EventBus plugin (`plugins.bus`, docs/plugins/event-bus.md), built by the runtime through the plugin
 * registry: one bus per component in a process, and the retry scheduler the bus role ticks.
 */
export interface BusPlugin {
  component(o: ComponentBusOptions): EventBus & Inbox & Relay;
  scheduler(db: SqlDriver, topics: readonly TopicDescriptor[]): RetryScheduler;
}

export { BUS_PERIODS, scheduleBus, scheduleComponent } from "./scheduler/scheduler.js";
export { deliver, type DeliverOutcome } from "./deliver.js";
export { SqlBus, SqlEventBus, type SqlBusOptions } from "./plugins/sql/sql-bus.js";
export { SqlRetryScheduler } from "./plugins/sql/sql-scheduler.js";
export { componentTablesSql, ensureComponentTables, ensureTopicTables, insertOrSkip, topicTables } from "./plugins/sql/ddl.js";
