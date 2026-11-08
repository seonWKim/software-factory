// The sql bus's retry scheduler (RFC 0015 §5.4, §7 Bus). On its `retry` tick it moves the release horizon
// to the tick's time: every retry, delayed message and claim lease whose time is at or before it becomes due.
// Several scheduler processes may run; the horizon only moves forward. On its `prune` tick it applies each
// topic's retention. It also replays dead letters for the operator.

import type { TopicDescriptor } from "../../../shared/topic.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { SqlDriver } from "../../../state/index.js";
import type { RetryScheduler } from "../../index.js";
import { SCHEDULER_TABLE, topicTables } from "./ddl.js";
import { addMs, readHorizon } from "./rows.js";

export class SqlRetryScheduler implements RetryScheduler {
  private readonly byName: ReadonlyMap<string, TopicDescriptor>;

  constructor(
    private readonly db: SqlDriver,
    private readonly topics: readonly TopicDescriptor[],
  ) {
    this.byName = new Map(topics.map((t) => [t.name, t]));
  }

  async release(tick: Tick): Promise<void> {
    await this.db.run(`UPDATE ${SCHEDULER_TABLE} SET released_until = ? WHERE id = 1 AND released_until < ?`, [tick.now, tick.now]);
  }

  /**
   * Drops messages past their topic's retention: by publish time, or for a competing topic by ack time.
   * A message with a pending retry or an open dead letter is kept. A consumer group further behind than
   * the retention loses those messages, as on Kafka.
   */
  async prune(tick: Tick): Promise<void> {
    for (const topic of this.topics) {
      const t = topicTables(topic.name);
      const before = addMs(tick.now, -topic.retentionMs);
      const kept = `seq NOT IN (SELECT message_seq FROM ${t.deadLetters} WHERE replayed_at IS NULL)`;
      if (topic.consumption === "competing") {
        await this.db.run(`DELETE FROM ${t.messages} WHERE acked_at IS NOT NULL AND acked_at < ? AND ${kept}`, [before]);
      } else {
        await this.db.run(`DELETE FROM ${t.messages} WHERE published_at < ? AND ${kept} AND seq NOT IN (SELECT message_seq FROM ${t.retries})`, [before]);
      }
    }
  }

  /** Sends a dead-lettered message to its group again, with its idempotency key (`factory dead-letters replay`). */
  async replay(topicName: string, group: string, seq: number, by: string): Promise<void> {
    const topic = this.byName.get(topicName);
    if (!topic) throw new Error(`unknown topic ${topicName}`);
    const t = topicTables(topic.name);
    const horizon = await readHorizon(this.db);
    await this.db.transaction(async (tx) => {
      const [dead] = await tx.all(`SELECT subject FROM ${t.deadLetters} WHERE consumer_group = ? AND message_seq = ? AND replayed_at IS NULL`, [group, seq]);
      if (!dead) throw new Error(`no open dead letter ${topic.name} ${group} #${seq}`);
      await tx.run(`UPDATE ${t.deadLetters} SET replayed_at = ?, replayed_by = ? WHERE consumer_group = ? AND message_seq = ?`, [horizon, by, group, seq]);
      if (topic.consumption === "competing") {
        await tx.run(`UPDATE ${t.messages} SET acked_at = NULL, claimed_by = NULL, claim_until = NULL WHERE seq = ?`, [seq]);
      } else {
        // The cursor is past it: a parked entry (attempt 0, due now) delivers it once more.
        await tx.run(
          `INSERT INTO ${t.retries} (consumer_group, message_seq, subject, attempt, next_attempt_at, last_error) VALUES (?, ?, ?, 0, ?, NULL)`,
          [group, seq, String(dead.subject), horizon],
        );
      }
    });
  }
}
