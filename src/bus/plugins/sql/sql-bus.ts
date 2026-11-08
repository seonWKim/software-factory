// The sql EventBus (RFC 0015 §5): the default bus, on SQLite or MySQL through the state component's driver.
//
// One instance per component in a process. It writes that component's outbox (publish) and inbox (claim),
// relays the outbox to the topic tables on the component's `relay` tick, and consumes any topic.
//
// - Partitioned and fan-out topics: a cursor per (consumer group, partition). A consumer leases a partition
//   for one message at a time, so a partition's messages are handed out in order and never to two consumers.
//   A failed message keeps the cursor on it until it succeeds or is dead-lettered (head-of-line wait).
//   A delayed message whose time has not come is parked in the retries table and the cursor moves past it,
//   so a durable timer never holds up the other actors of its partition; it is delivered once due.
// - Competing topics: any consumer claims any due row; a failed row waits alone.
// - Every time comparison is against the scheduler's release horizon (bus_scheduler), never a clock.

import { envelopeProblems, newMessageId, type Envelope } from "../../../shared/envelope.js";
import { maxRedeliveryMs, partitionOf, type TopicDescriptor } from "../../../shared/topic.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { Dialect, Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import type { Claimed, EventBus, Inbox, NackError, Relay, Tx } from "../../index.js";
import { P, insertOrSkip, topicTables, type TopicTables } from "./ddl.js";
import { MESSAGE_COLUMNS, addMs, envelopeOf, readHorizon, retryDelayMs } from "./rows.js";

export interface SqlBusOptions {
  readonly db: SqlDriver;
  readonly dialect: Dialect;
  /** The component this instance publishes and dedupes for: it writes `<component>_outbox` and `<component>_inbox`. */
  readonly component: string;
  /** Every topic this instance publishes to or consumes (from discovery). */
  readonly topics: readonly TopicDescriptor[];
  /** This process, recorded as the owner of what it claims. */
  readonly consumerId: string;
  /** How long a claim lasts past the release horizon before another consumer may take the message. */
  readonly leaseMs?: number;
  /** Outbox rows published per relay tick. */
  readonly relayBatch?: number;
  /** How long published outbox rows are kept before `prune` removes them. */
  readonly outboxRetentionMs?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RELAY_BATCH = 500;
const DEFAULT_OUTBOX_RETENTION_MS = 86_400_000;

export class SqlEventBus implements EventBus, Inbox, Relay {
  private readonly db: SqlDriver;
  private readonly dialect: Dialect;
  private readonly outbox: string;
  private readonly inbox: string;
  private readonly consumerId: string;
  private readonly leaseMs: number;
  private readonly relayBatch: number;
  private readonly outboxRetentionMs: number;
  private readonly byName = new Map<string, TopicDescriptor>();
  private readonly byType = new Map<string, TopicDescriptor>();
  /** Groups whose cursor rows exist; only saves a write, the rows themselves are the state. */
  private readonly cursorsReady = new Set<string>();

  constructor(o: SqlBusOptions) {
    if (!/^[a-z]+$/.test(o.component)) throw new Error(`component name "${o.component}" must be lowercase letters`);
    this.db = o.db;
    this.dialect = o.dialect;
    this.outbox = `${o.component}_outbox`;
    this.inbox = `${o.component}_inbox`;
    this.consumerId = o.consumerId;
    this.leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
    this.relayBatch = o.relayBatch ?? DEFAULT_RELAY_BATCH;
    this.outboxRetentionMs = o.outboxRetentionMs ?? DEFAULT_OUTBOX_RETENTION_MS;
    for (const t of o.topics) {
      this.byName.set(t.name, t);
      for (const type of Object.keys(t.messages)) this.byType.set(type, t);
    }
  }

  async publish(tx: Tx, messages: readonly Envelope[]): Promise<void> {
    if (messages.length === 0) return;
    const commitId = newMessageId();
    for (const m of messages) {
      const topic = this.byType.get(m.type);
      if (!topic) throw new Error(`cannot publish ${m.type}: no topic declares it`);
      const problems = envelopeProblems(m);
      const floor = maxRedeliveryMs(topic.backoff);
      if (m.idempotency_key_ttl_ms !== null && m.idempotency_key_ttl_ms < floor) {
        problems.push(`idempotency_key_ttl_ms ${m.idempotency_key_ttl_ms} is below ${topic.name}'s maximum redelivery (${floor} ms)`);
      }
      if (problems.length > 0) throw new Error(`cannot publish ${m.type} ${m.id}: ${problems.join("; ")}`);
      await tx.run(`INSERT INTO ${this.outbox} (topic, message_id, envelope, commit_id, created_at) VALUES (?, ?, ?, ?, ?)`, [
        topic.name,
        m.id,
        JSON.stringify(m),
        commitId,
        m.occurred_at,
      ]);
    }
  }

  /** Publishes pending outbox rows in outbox order. A row published twice is dropped by the topic's unique id. */
  relay(tick: Tick): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.all(
        `SELECT seq, topic, envelope FROM ${this.outbox} WHERE published_at IS NULL ORDER BY seq LIMIT ${this.relayBatch}${this.db.dialect.forUpdate}`,
      );
      for (const r of rows) {
        const topic = this.topic(String(r.topic));
        const m = JSON.parse(String(r.envelope)) as Envelope;
        const key = topic.partitionKey(m);
        await tx.run(insertOrSkip(this.dialect, `${topicTables(topic.name).messages} (${MESSAGE_COLUMNS}) VALUES (${Array(17).fill("?").join(", ")})`), [
          m.id,
          m.type,
          m.schema_version,
          m.subject,
          key,
          partitionOf(key, topic.partitions),
          m.project_id,
          m.idempotency_key,
          m.idempotency_key_ttl_ms,
          m.causation_id,
          m.correlation_id,
          m.passport_id,
          m.producer,
          m.occurred_at,
          m.not_before,
          JSON.stringify(m.payload),
          tick.now,
        ]);
        await tx.run(`UPDATE ${this.outbox} SET published_at = ? WHERE seq = ?`, [tick.now, Number(r.seq)]);
      }
      return rows.length;
    });
  }

  /** Inserts `(consumer, idempotency_key)` with the caller's state change; a key seen before is a duplicate. */
  async claim(tx: Tx, consumer: string, m: Envelope): Promise<"new" | "duplicate"> {
    const expires = m.idempotency_key_ttl_ms === null ? null : addMs(m.occurred_at, m.idempotency_key_ttl_ms);
    const n = await tx.run(
      insertOrSkip(this.dialect, `${this.inbox} (consumer, idempotency_key, message_id, processed_at, expires_at) VALUES (?, ?, ?, ?, ?)`),
      [consumer, m.idempotency_key, m.id, await readHorizon(tx), expires],
    );
    return n === 1 ? "new" : "duplicate";
  }

  /** Removes inbox rows past their key's TTL and old published outbox rows (the component's `prune` tick). */
  async prune(tick: Tick): Promise<void> {
    await this.db.run(`DELETE FROM ${this.inbox} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [tick.now]);
    await this.db.run(`DELETE FROM ${this.outbox} WHERE published_at IS NOT NULL AND published_at < ?`, [addMs(tick.now, -this.outboxRetentionMs)]);
  }

  async consume(group: string, topicName: string, max: number): Promise<Claimed[]> {
    const topic = this.topic(topicName);
    const horizon = await readHorizon(this.db);
    return topic.consumption === "competing" ? this.consumeRows(group, topic, max, horizon) : this.consumePartitions(group, topic, max, horizon);
  }

  async ack(c: Claimed): Promise<void> {
    const topic = this.topic(c.topic);
    const t = topicTables(topic.name);
    const horizon = await readHorizon(this.db);
    await this.db.transaction(async (tx) => {
      if (!(await this.finish(tx, topic, t, c, horizon))) return;
      await tx.run(`DELETE FROM ${t.retries} WHERE consumer_group = ? AND message_seq = ?`, [c.group, c.seq]);
    });
  }

  async nack(c: Claimed, err: NackError): Promise<void> {
    const topic = this.topic(c.topic);
    const t = topicTables(topic.name);
    const horizon = await readHorizon(this.db);
    const dead = err.code === "unhandled" || !err.retryable || c.attempt >= topic.backoff.maxAttempts;
    const lastError = err.detail === undefined ? err.code : `${err.code}: ${err.detail}`;
    await this.db.transaction(async (tx) => {
      if (!(dead ? await this.finish(tx, topic, t, c, horizon) : await this.release(tx, topic, t, c))) return;
      await tx.run(`DELETE FROM ${t.retries} WHERE consumer_group = ? AND message_seq = ?`, [c.group, c.seq]);
      if (dead) {
        const code = err.code === "unhandled" ? "unhandled" : err.retryable ? "max_attempts" : "non_retryable";
        await tx.run(`DELETE FROM ${t.deadLetters} WHERE consumer_group = ? AND message_seq = ?`, [c.group, c.seq]);
        await tx.run(
          `INSERT INTO ${t.deadLetters} (consumer_group, message_seq, subject, attempts, error_code, last_error, dead_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [c.group, c.seq, c.message.subject, c.attempt, code, lastError, horizon],
        );
        return;
      }
      const due = addMs(horizon, retryDelayMs(topic.backoff, c.attempt, `${c.group}:${c.seq}:${c.attempt}`));
      await tx.run(
        `INSERT INTO ${t.retries} (consumer_group, message_seq, subject, attempt, next_attempt_at, last_error) VALUES (?, ?, ?, ?, ?, ?)`,
        [c.group, c.seq, c.message.subject, c.attempt, due, lastError],
      );
    });
  }

  private topic(name: string): TopicDescriptor {
    const t = this.byName.get(name);
    if (!t) throw new Error(`unknown topic ${name}`);
    return t;
  }

  /** Ends a claim for good (ack or dead letter): the cursor moves past the message, or the row is acked. */
  private async finish(tx: SqlExecutor, topic: TopicDescriptor, t: TopicTables, c: Claimed, horizon: string): Promise<boolean> {
    if (topic.consumption === "competing") {
      const n = await tx.run(
        `UPDATE ${t.messages} SET acked_at = ?, claimed_by = NULL, claim_until = NULL WHERE seq = ? AND claim_token = ? AND acked_at IS NULL`,
        [horizon, c.seq, c.token],
      );
      return n === 1;
    }
    const n = await tx.run(
      `UPDATE ${t.cursors} SET last_seq = CASE WHEN last_seq < ? THEN ? ELSE last_seq END, owner = NULL, lease_until = NULL ` +
        `WHERE consumer_group = ? AND ${P} = ? AND lease_token = ?`,
      [c.seq, c.seq, c.group, c.partition, c.token],
    );
    return n === 1;
  }

  /** Lets the claim go without moving on: the message stays first in line (a retry). */
  private async release(tx: SqlExecutor, topic: TopicDescriptor, t: TopicTables, c: Claimed): Promise<boolean> {
    const n =
      topic.consumption === "competing"
        ? await tx.run(`UPDATE ${t.messages} SET claimed_by = NULL, claim_until = NULL WHERE seq = ? AND claim_token = ? AND acked_at IS NULL`, [c.seq, c.token])
        : await tx.run(`UPDATE ${t.cursors} SET owner = NULL, lease_until = NULL WHERE consumer_group = ? AND ${P} = ? AND lease_token = ?`, [
            c.group,
            c.partition,
            c.token,
          ]);
    return n === 1;
  }

  private async consumeRows(group: string, topic: TopicDescriptor, max: number, horizon: string): Promise<Claimed[]> {
    const t = topicTables(topic.name);
    const rows = await this.db.all(
      `SELECT m.*, r.attempt AS r_attempt FROM ${t.messages} m LEFT JOIN ${t.retries} r ON r.consumer_group = ? AND r.message_seq = m.seq ` +
        `WHERE m.acked_at IS NULL AND (m.claim_until IS NULL OR m.claim_until <= ?) AND (m.not_before IS NULL OR m.not_before <= ?) ` +
        `AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?) ORDER BY m.seq LIMIT ${Math.max(0, Math.floor(max))}`,
      [group, horizon, horizon, horizon],
    );
    const out: Claimed[] = [];
    for (const r of rows) {
      const n = await this.db.run(
        `UPDATE ${t.messages} SET claimed_by = ?, claim_token = claim_token + 1, claim_until = ? WHERE seq = ? AND claim_token = ? AND acked_at IS NULL`,
        [this.consumerId, addMs(horizon, this.leaseMs), Number(r.seq), Number(r.claim_token)],
      );
      if (n === 1) out.push(claimed(topic, group, r, Number(r.claim_token) + 1));
    }
    return out;
  }

  private async consumePartitions(group: string, topic: TopicDescriptor, max: number, horizon: string): Promise<Claimed[]> {
    const t = topicTables(topic.name);
    await this.ensureCursors(group, topic, t);
    const candidates = await this.db.all(
      `SELECT c.${P} AS p, c.lease_token AS token FROM ${t.cursors} c WHERE c.consumer_group = ? AND (c.lease_until IS NULL OR c.lease_until <= ?) ` +
        `AND (EXISTS (SELECT 1 FROM ${t.messages} m WHERE m.${P} = c.${P} AND m.seq > c.last_seq) ` +
        `OR EXISTS (SELECT 1 FROM ${t.retries} r JOIN ${t.messages} m ON m.seq = r.message_seq ` +
        `WHERE r.consumer_group = c.consumer_group AND m.${P} = c.${P} AND r.message_seq <= c.last_seq AND r.next_attempt_at <= ?)) ` +
        `ORDER BY c.${P}`,
      [group, horizon, horizon],
    );
    const out: Claimed[] = [];
    for (const cand of candidates) {
      if (out.length >= max) break;
      const c = await this.db.transaction((tx) => this.claimPartition(tx, group, topic, t, Number(cand.p), Number(cand.token), horizon));
      if (c) out.push(c);
    }
    return out;
  }

  /** Leases one partition and picks its next message: a due parked one first, else the head in order. */
  private async claimPartition(
    tx: SqlExecutor,
    group: string,
    topic: TopicDescriptor,
    t: TopicTables,
    partition: number,
    token: number,
    horizon: string,
  ): Promise<Claimed | null> {
    const won = await tx.run(
      `UPDATE ${t.cursors} SET owner = ?, lease_token = lease_token + 1, lease_until = ? ` +
        `WHERE consumer_group = ? AND ${P} = ? AND lease_token = ? AND (lease_until IS NULL OR lease_until <= ?)`,
      [this.consumerId, addMs(horizon, this.leaseMs), group, partition, token, horizon],
    );
    if (won !== 1) return null;
    const lease = token + 1;
    const [cursor] = await tx.all(`SELECT last_seq FROM ${t.cursors} WHERE consumer_group = ? AND ${P} = ?`, [group, partition]);
    let last = Number(cursor!.last_seq);
    const [parked] = await tx.all(
      `SELECT m.*, r.attempt AS r_attempt FROM ${t.retries} r JOIN ${t.messages} m ON m.seq = r.message_seq ` +
        `WHERE r.consumer_group = ? AND m.${P} = ? AND r.message_seq <= ? AND r.next_attempt_at <= ? ORDER BY r.message_seq LIMIT 1`,
      [group, partition, last, horizon],
    );
    if (parked) return claimed(topic, group, parked, lease);
    for (;;) {
      const [head] = await tx.all(
        `SELECT m.*, r.attempt AS r_attempt, r.next_attempt_at AS r_next FROM ${t.messages} m ` +
          `LEFT JOIN ${t.retries} r ON r.consumer_group = ? AND r.message_seq = m.seq WHERE m.${P} = ? AND m.seq > ? ORDER BY m.seq LIMIT 1`,
        [group, partition, last],
      );
      if (!head || (head.r_next != null && String(head.r_next) > horizon)) break;
      if (head.r_next == null && head.not_before != null && String(head.not_before) > horizon) {
        last = Number(head.seq);
        await tx.run(
          `INSERT INTO ${t.retries} (consumer_group, message_seq, subject, attempt, next_attempt_at, last_error) VALUES (?, ?, ?, 0, ?, NULL)`,
          [group, last, String(head.subject), String(head.not_before)],
        );
        await tx.run(`UPDATE ${t.cursors} SET last_seq = ? WHERE consumer_group = ? AND ${P} = ?`, [last, group, partition]);
        continue;
      }
      return claimed(topic, group, head, lease);
    }
    await tx.run(`UPDATE ${t.cursors} SET owner = NULL, lease_until = NULL WHERE consumer_group = ? AND ${P} = ? AND lease_token = ?`, [
      group,
      partition,
      lease,
    ]);
    return null;
  }

  private async ensureCursors(group: string, topic: TopicDescriptor, t: TopicTables): Promise<void> {
    const key = `${topic.name}\0${group}`;
    if (this.cursorsReady.has(key)) return;
    for (let p = 0; p < topic.partitions; p++) {
      await this.db.run(insertOrSkip(this.dialect, `${t.cursors} (consumer_group, ${P}) VALUES (?, ?)`), [group, p]);
    }
    this.cursorsReady.add(key);
  }
}

function claimed(topic: TopicDescriptor, group: string, r: Row, token: number): Claimed {
  return {
    topic: topic.name,
    group,
    partition: Number(r.partition),
    seq: Number(r.seq),
    attempt: r.r_attempt === null || r.r_attempt === undefined ? 1 : Number(r.r_attempt) + 1,
    token,
    message: envelopeOf(r),
  };
}
