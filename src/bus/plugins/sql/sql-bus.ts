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
// - Competing topics: any consumer claims any due row whose `requires` are among its capabilities; a failed row
//   waits alone.
// - Every time comparison is against the scheduler's release horizon (bus_scheduler), never a clock.

import { MAX_KEY_LENGTH, MAX_PAYLOAD_STRING, envelopeProblems, newMessageId, type Envelope } from "../../../shared/envelope.js";
import { CAPABILITY, maxRedeliveryMs, partitionOf, requirementsOf, type TopicDescriptor } from "../../../shared/topic.js";
import type { StartPosition } from "../../../shared/handler.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { Dialect, Row, SqlDriver, SqlExecutor, SqlValue } from "../../../state/index.js";
import type { BusPlugin, Claimed, ComponentBusOptions, EventBus, Inbox, NackError, Relay, Tx } from "../../index.js";
import { P, TOPICS_TABLE, insertOrSkip, topicTables, type TopicTables } from "./ddl.js";
import { addMs } from "../../../shared/time.js";
import { MESSAGE_COLUMNS, envelopeOf, readHorizon, retryDelayMs } from "./rows.js";
import { SqlRetryScheduler } from "./sql-scheduler.js";
import SYSTEM_ALERTS, { DEAD_LETTERED } from "../../topics/system-alerts.topic.js";

/** The `sql` EventBus plugin (docs/plugins/event-bus.md): the topic tables live in the store's own database. */
export class SqlBus implements BusPlugin {
  component(o: ComponentBusOptions): SqlEventBus {
    return new SqlEventBus(o);
  }

  scheduler(db: SqlDriver, topics: readonly TopicDescriptor[]): SqlRetryScheduler {
    return new SqlRetryScheduler(db, topics);
  }
}

export interface SqlBusOptions extends ComponentBusOptions {
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
  private readonly capabilities: readonly string[];
  private readonly byName = new Map<string, TopicDescriptor>();
  private readonly byType = new Map<string, TopicDescriptor>();
  /** Groups whose cursor rows exist; only saves a read, the rows themselves are the state. */
  private readonly subscribed = new Set<string>();

  constructor(o: SqlBusOptions) {
    if (!/^[a-z]+$/.test(o.component)) throw new Error(`component name "${o.component}" must be lowercase letters`);
    this.db = o.db;
    this.dialect = o.db.dialect.name;
    this.outbox = `${o.component}_outbox`;
    this.inbox = `${o.component}_inbox`;
    this.consumerId = o.consumerId;
    this.leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
    this.relayBatch = o.relayBatch ?? DEFAULT_RELAY_BATCH;
    this.outboxRetentionMs = o.outboxRetentionMs ?? DEFAULT_OUTBOX_RETENTION_MS;
    const capabilities = [...new Set(o.capabilities ?? [])];
    const bad = capabilities.filter((c) => !CAPABILITY.test(c));
    if (bad.length > 0) throw new Error(`capability ${bad.join(", ")} is not key=value`);
    this.capabilities = capabilities;
    // The bus writes its own dead-letter notices, so it knows system.alerts whatever the caller lists.
    for (const t of [SYSTEM_ALERTS, ...o.topics]) {
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
      if (topic.partitionKey(m).length > MAX_KEY_LENGTH) problems.push(`its partition key is longer than ${MAX_KEY_LENGTH} chars`);
      if (problems.length > 0) throw new Error(`cannot publish ${m.type} ${m.id}: ${problems.join("; ")}`);
      // Checked here, so a bad requirement fails its producer and never the relay.
      requirementsOf(topic, m);
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
      await this.lockTopics(tx, rows.map((r) => String(r.topic)));
      for (const r of rows) {
        await this.insertMessage(tx, this.topic(String(r.topic)), JSON.parse(String(r.envelope)) as Envelope, tick.now);
        await tx.run(`UPDATE ${this.outbox} SET published_at = ? WHERE seq = ?`, [tick.now, Number(r.seq)]);
      }
      return rows.length;
    });
  }

  /**
   * Takes the `bus_topics` rows of `names` until the transaction ends, before it inserts into their tables: inserts
   * into one topic then commit in seq order. MySQL assigns AUTO_INCREMENT at insert, not at commit, so without it a
   * cursor (`seq > last_seq`) could pass a lower seq whose transaction commits later and skip it for good. One
   * statement in key order, so two writers never take two topics in opposite orders. SQLite has one writer.
   */
  private async lockTopics(tx: SqlExecutor, names: readonly string[]): Promise<void> {
    const forUpdate = this.db.dialect.forUpdate;
    const unique = [...new Set(names)];
    if (forUpdate === "" || unique.length === 0) return;
    const locked = await tx.all(
      `SELECT name FROM ${TOPICS_TABLE} WHERE name IN (${unique.map(() => "?").join(", ")}) ORDER BY name${forUpdate}`,
      unique,
    );
    if (locked.length !== unique.length) throw new Error(`${TOPICS_TABLE} lists not every topic of ${unique.join(", ")}: its tables were not created`);
  }

  /** Writes one message to its topic's table (the caller holds its lock); a message id already there is skipped. */
  private async insertMessage(tx: SqlExecutor, topic: TopicDescriptor, m: Envelope, publishedAt: string): Promise<void> {
    const key = topic.partitionKey(m);
    const values: SqlValue[] = [
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
      publishedAt,
    ];
    const competing = topic.consumption === "competing";
    if (competing) values.push(JSON.stringify(requirementsOf(topic, m)));
    const columns = competing ? `${MESSAGE_COLUMNS}, requires` : MESSAGE_COLUMNS;
    await insertOrSkip(tx, this.dialect, `${topicTables(topic.name).messages} (${columns}) VALUES (${values.map(() => "?").join(", ")})`, values);
  }

  /** Inserts `(consumer, idempotency_key)` with the caller's state change; a key seen before is a duplicate. */
  async claim(tx: Tx, consumer: string, m: Envelope): Promise<"new" | "duplicate"> {
    const expires = m.idempotency_key_ttl_ms === null ? null : addMs(m.occurred_at, m.idempotency_key_ttl_ms);
    const inserted = await insertOrSkip(
      tx,
      this.dialect,
      `${this.inbox} (consumer, idempotency_key, message_id, processed_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [consumer, m.idempotency_key, m.id, await readHorizon(tx), expires],
    );
    return inserted ? "new" : "duplicate";
  }

  /** Removes inbox rows past their key's TTL and old published outbox rows (the component's `prune` tick). */
  async prune(tick: Tick): Promise<void> {
    await this.db.run(`DELETE FROM ${this.inbox} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [tick.now]);
    await this.db.run(`DELETE FROM ${this.outbox} WHERE published_at IS NOT NULL AND published_at < ?`, [addMs(tick.now, -this.outboxRetentionMs)]);
  }

  async subscribe(group: string, topicName: string, from: StartPosition): Promise<void> {
    const topic = this.topic(topicName);
    if (topic.consumption === "competing") return;
    const t = topicTables(topic.name);
    await this.db.transaction(async (tx) => {
      // Every seq up to a partition's committed MAX has committed: inserts into a topic commit in seq order.
      const heads = from === "earliest" ? [] : await tx.all(`SELECT ${P} AS p, MAX(seq) AS seq FROM ${t.messages} GROUP BY ${P}`);
      const head = new Map(heads.map((r) => [Number(r.p), Number(r.seq)]));
      for (let p = 0; p < topic.partitions; p++) {
        await insertOrSkip(tx, this.dialect, `${t.cursors} (consumer_group, ${P}, last_seq) VALUES (?, ?, ?)`, [group, p, head.get(p) ?? 0]);
      }
    });
    this.subscribed.add(`${topic.name}\0${group}`);
  }

  async consume(group: string, topicName: string, max: number): Promise<Claimed[]> {
    const topic = this.topic(topicName);
    const horizon = await readHorizon(this.db);
    return topic.consumption === "competing" ? this.consumeRows(group, topic, max, horizon) : this.consumePartitions(group, topic, max, horizon);
  }

  async renew(c: Claimed): Promise<boolean> {
    const t = topicTables(c.topic);
    const horizon = await readHorizon(this.db);
    const until = addMs(horizon, this.leaseMs);
    // Still ours and not yet run out: another consumer may claim it once `lease_until <= horizon`.
    const n =
      this.topic(c.topic).consumption === "competing"
        ? await this.db.run(`UPDATE ${t.messages} SET claim_until = ? WHERE seq = ? AND claim_token = ? AND acked_at IS NULL AND claim_until > ?`, [
            until,
            c.seq,
            c.token,
            horizon,
          ])
        : await this.db.run(`UPDATE ${t.cursors} SET lease_until = ? WHERE consumer_group = ? AND ${P} = ? AND lease_token = ? AND lease_until > ?`, [
            until,
            c.group,
            c.partition,
            c.token,
            horizon,
          ]);
    return n === 1;
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
        // The notice commits with the dead letter. A notice that is dead-lettered itself raises none (no loop).
        if (topic.name !== SYSTEM_ALERTS.name) {
          await this.lockTopics(tx, [SYSTEM_ALERTS.name]);
          await this.insertMessage(tx, SYSTEM_ALERTS, deadLetterNotice(c, code, lastError, horizon), horizon);
        }
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
    // `requires` met: with every capability's quoted form taken out, no quoted requirement is left in the JSON list.
    const unmet = this.capabilities.reduce((sql) => `REPLACE(${sql}, ?, '')`, "m.requires");
    const rows = await this.db.all(
      `SELECT m.*, r.attempt AS r_attempt FROM ${t.messages} m LEFT JOIN ${t.retries} r ON r.consumer_group = ? AND r.message_seq = m.seq ` +
        `WHERE m.acked_at IS NULL AND (m.claim_until IS NULL OR m.claim_until <= ?) AND (m.not_before IS NULL OR m.not_before <= ?) ` +
        `AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?) AND ${unmet} NOT LIKE '%"%' ORDER BY m.seq LIMIT ${Math.max(0, Math.floor(max))}`,
      [group, horizon, horizon, horizon, ...this.capabilities.map((c) => JSON.stringify(c))],
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
    await this.assertSubscribed(group, topic, t);
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

  /** A group with no cursors was never subscribed: consuming would pick a start position by accident. */
  private async assertSubscribed(group: string, topic: TopicDescriptor, t: TopicTables): Promise<void> {
    const key = `${topic.name}\0${group}`;
    if (this.subscribed.has(key)) return;
    const [row] = await this.db.all(`SELECT COUNT(*) AS n FROM ${t.cursors} WHERE consumer_group = ?`, [group]);
    if (Number(row!.n) !== topic.partitions) throw new Error(`consumer group ${group} is not subscribed to ${topic.name}: subscribe it when it starts`);
    this.subscribed.add(key);
  }
}

/**
 * The DeadLettered notice on system.alerts (RFC 0015 §5.4): which message died for which group, and why. It follows
 * from the dead message (same trace, project and passport); its key names the dead letter, so a notice published
 * twice is handled once.
 */
function deadLetterNotice(c: Claimed, code: string, lastError: string, at: string): Envelope {
  const m = c.message;
  return {
    id: newMessageId(),
    type: DEAD_LETTERED,
    schema_version: 1,
    subject: m.subject,
    project_id: m.project_id,
    idempotency_key: `dead-letter:${c.topic}:${c.group}:${c.seq}:${at}`,
    idempotency_key_ttl_ms: null,
    causation_id: m.id,
    correlation_id: m.correlation_id,
    passport_id: m.passport_id,
    producer: "bus",
    occurred_at: at,
    not_before: null,
    payload: {
      pattern: `dead_letter:${c.topic}`,
      topic: c.topic,
      group: c.group,
      seq: c.seq,
      message_id: m.id,
      message_type: m.type,
      attempts: c.attempt,
      error_code: code,
      last_error: lastError.slice(0, MAX_PAYLOAD_STRING),
    },
  };
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
