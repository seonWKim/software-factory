// Tables of the sql bus (RFC 0015 §5.5, 0015-target-schema.sql).
//
// Per topic: bus_<topic> (messages), bus_<topic>_cursors (partitioned and fan-out topics only),
// bus_<topic>_retries and bus_<topic>_dead_letters. Topics are discovered, so their tables are not written
// in a migration: ensureTopicTables creates them from the descriptor (CREATE ... IF NOT EXISTS, never an
// ALTER or a DROP) and records each topic in bus_topics. A later change of a topic's partitions or
// consumption is refused here; it needs a bus migration that moves the rows. A change of the shared table
// shape is a bus migration over every topic listed in bus_topics.
//
// Per component: <component>_outbox and <component>_inbox share the component's transaction, so they
// belong to it. Its own migration creates them with ensureComponentTables (one shape for every component).

import type { TopicDescriptor } from "../../../shared/topic.js";
import { topicTable } from "../../../shared/topic.js";
import type { MigrationDb, SqlExecutor, SqlValue } from "../../../state/index.js";

export interface TopicTables {
  readonly messages: string;
  readonly cursors: string;
  readonly retries: string;
  readonly deadLetters: string;
}

export function topicTables(name: string): TopicTables {
  const messages = topicTable(name);
  return { messages, cursors: `${messages}_cursors`, retries: `${messages}_retries`, deadLetters: `${messages}_dead_letters` };
}

export const TOPICS_TABLE = "bus_topics";
export const SCHEDULER_TABLE = "bus_scheduler";

/** The partition column, quoted as the existing tables name it. */
export const P = "`partition`";

/** SQLite column types. */
const t = { id: "TEXT", int: "INTEGER", time: "TEXT", text: "TEXT", long: "TEXT", autoSeq: "INTEGER PRIMARY KEY AUTOINCREMENT" } as const;

/** A competing topic's `requires`: the message's requirements as a sorted JSON list of strings (`["sandbox=docker"]`). */
export const REQUIRES_COLUMN = "requires TEXT NOT NULL DEFAULT '[]'";

interface Index {
  name: string;
  columns: string;
  /** A partial index's condition. */
  where?: string;
}

/** CREATE TABLE IF NOT EXISTS plus its indexes. */
function table(name: string, columns: readonly string[], indexes: readonly Index[] = []): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.join(",\n  ")}\n)`,
    ...indexes.map((i) => `CREATE INDEX IF NOT EXISTS ${i.name} ON ${name} (${i.columns})${i.where ? ` WHERE ${i.where}` : ""}`),
  ];
}

/** The DDL of one topic's tables. */
export function topicTablesSql(topic: TopicDescriptor): string[] {
  const n = topicTables(topic.name);
  const competing = topic.consumption === "competing";
  const messageColumns = [
    `seq ${t.autoSeq}`,
    `id ${t.id} NOT NULL UNIQUE`,
    `type ${t.id} NOT NULL`,
    `schema_version ${t.int} NOT NULL`,
    `subject ${t.id} NOT NULL`,
    `partition_key ${t.id} NOT NULL`,
    `${P} ${t.int} NOT NULL`,
    `project_id ${t.id} NOT NULL`,
    `idempotency_key ${t.id} NOT NULL`,
    `idempotency_key_ttl_ms ${t.int}`,
    `causation_id ${t.id}`,
    `correlation_id ${t.id} NOT NULL`,
    `passport_id ${t.id}`,
    `producer ${t.id} NOT NULL`,
    `occurred_at ${t.time} NOT NULL`,
    `not_before ${t.time}`,
    `payload ${t.long} NOT NULL`,
    `published_at ${t.time} NOT NULL`,
    ...(competing
      ? [REQUIRES_COLUMN, `claimed_by ${t.id}`, `claim_token ${t.int} NOT NULL DEFAULT 0`, `claim_until ${t.time}`, `acked_at ${t.time}`]
      : []),
  ];
  const messageIndexes: Index[] = competing
    ? [{ name: `${n.messages}_claimable`, columns: "acked_at, claim_until, not_before, seq" }]
    : [
        { name: `${n.messages}_partition`, columns: `${P}, seq` },
        { name: `${n.messages}_due`, columns: "not_before", where: "not_before IS NOT NULL" },
      ];
  messageIndexes.push({ name: `${n.messages}_published`, columns: "published_at" });
  return [
    ...table(n.messages, messageColumns, messageIndexes),
    ...(competing
      ? []
      : table(n.cursors, [
          `consumer_group ${t.id} NOT NULL`,
          `${P} ${t.int} NOT NULL`,
          `last_seq ${t.int} NOT NULL DEFAULT 0`,
          `owner ${t.id}`,
          `lease_token ${t.int} NOT NULL DEFAULT 0`,
          `lease_until ${t.time}`,
          `PRIMARY KEY (consumer_group, ${P})`,
        ])),
    ...table(
      n.retries,
      [
        `consumer_group ${t.id} NOT NULL`,
        `message_seq ${t.int} NOT NULL`,
        `subject ${t.id} NOT NULL`,
        `attempt ${t.int} NOT NULL`,
        `next_attempt_at ${t.time} NOT NULL`,
        `last_error ${t.text}`,
        "PRIMARY KEY (consumer_group, message_seq)",
      ],
      [{ name: `${n.retries}_due`, columns: "next_attempt_at" }],
    ),
    ...table(n.deadLetters, [
      `consumer_group ${t.id} NOT NULL`,
      `message_seq ${t.int} NOT NULL`,
      `subject ${t.id} NOT NULL`,
      `attempts ${t.int} NOT NULL`,
      `error_code ${t.id} NOT NULL`,
      `last_error ${t.text}`,
      `dead_at ${t.time} NOT NULL`,
      `replayed_at ${t.time}`,
      `replayed_by ${t.id}`,
      "PRIMARY KEY (consumer_group, message_seq)",
    ]),
  ];
}

/** The bus's own bookkeeping: the topic list and the scheduler's release horizon (created by a bus migration). */
export function busTablesSql(): string[] {
  return [
    ...table(TOPICS_TABLE, [
      `name ${t.id} NOT NULL PRIMARY KEY`,
      `consumption ${t.id} NOT NULL`,
      `partitions ${t.int} NOT NULL`,
    ]),
    ...table(SCHEDULER_TABLE, [`id ${t.int} NOT NULL PRIMARY KEY`, `released_until ${t.time} NOT NULL`]),
  ];
}

/**
 * `INSERT INTO <rest>` (`table (cols) VALUES (...)`) that skips a row whose unique key exists (ON CONFLICT DO
 * NOTHING); true when it inserted.
 */
export async function insertOrSkip(q: SqlExecutor, rest: string, params: readonly SqlValue[] = []): Promise<boolean> {
  return (await q.run(`INSERT INTO ${rest} ON CONFLICT DO NOTHING`, params)) === 1;
}

/**
 * Creates every missing topic table and refuses a topic whose partitions or consumption changed. A topic whose
 * `bus_topics` row exists runs no DDL: the row is written only after its tables, so a start against a database
 * `npm run migrate` prepared needs no CREATE right (an enterprise DML-only user).
 */
export async function ensureTopicTables(db: MigrationDb, topics: readonly TopicDescriptor[]): Promise<void> {
  for (const topic of topics) {
    const known = await db.all(`SELECT consumption, partitions FROM ${TOPICS_TABLE} WHERE name = ?`, [topic.name]);
    const row = known[0];
    if (row && (row.consumption !== topic.consumption || Number(row.partitions) !== topic.partitions)) {
      throw new Error(
        `topic ${topic.name} was created as ${String(row.consumption)} with ${String(row.partitions)} partitions and is now ` +
          `${topic.consumption} with ${topic.partitions}: changing either needs a bus migration`,
      );
    }
    if (row) continue;
    for (const sql of topicTablesSql(topic)) await db.run(sql);
    await insertOrSkip(db, `${TOPICS_TABLE} (name, consumption, partitions) VALUES (?, ?, ?)`, [
      topic.name,
      topic.consumption,
      topic.partitions,
    ]);
  }
}

/** The DDL of a component's outbox and inbox (one shape for every component). */
export function componentTablesSql(component: string): string[] {
  if (!/^[a-z]+$/.test(component)) throw new Error(`component name "${component}" must be lowercase letters`);
  const outbox = `${component}_outbox`;
  const inbox = `${component}_inbox`;
  return [
    ...table(
      outbox,
      [
        `seq ${t.autoSeq}`,
        `topic ${t.id} NOT NULL`,
        `message_id ${t.id} NOT NULL UNIQUE`,
        `envelope ${t.long} NOT NULL`,
        `commit_id ${t.id} NOT NULL`,
        `created_at ${t.time} NOT NULL`,
        `published_at ${t.time}`,
      ],
      [{ name: `${outbox}_pending`, columns: "published_at, seq" }],
    ),
    ...table(
      inbox,
      [
        `consumer ${t.id} NOT NULL`,
        `idempotency_key ${t.id} NOT NULL`,
        `message_id ${t.id} NOT NULL`,
        `processed_at ${t.time} NOT NULL`,
        `expires_at ${t.time}`,
        "PRIMARY KEY (consumer, idempotency_key)",
      ],
      [{ name: `${inbox}_expiry`, columns: "expires_at" }],
    ),
  ];
}

/** For a component's own migration: creates its outbox and inbox. */
export async function ensureComponentTables(db: MigrationDb, component: string): Promise<void> {
  for (const sql of componentTablesSql(component)) await db.run(sql);
}
