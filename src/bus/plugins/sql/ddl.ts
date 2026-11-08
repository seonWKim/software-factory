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
import type { Dialect, MigrationDb, SqlExecutor, SqlValue } from "../../../state/index.js";

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

/** `partition` is a reserved word in MySQL; backticks quote it in both dialects. */
export const P = "`partition`";

const MYSQL_TABLE = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

interface Types {
  id: string;
  int: string;
  time: string;
  text: string;
  long: string;
  autoSeq: string;
}

const TYPES: Record<Dialect, Types> = {
  sqlite: { id: "TEXT", int: "INTEGER", time: "TEXT", text: "TEXT", long: "TEXT", autoSeq: "INTEGER PRIMARY KEY AUTOINCREMENT" },
  mysql: { id: "VARCHAR(191)", int: "BIGINT", time: "CHAR(24)", text: "TEXT", long: "MEDIUMTEXT", autoSeq: "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY" },
};

/**
 * A competing topic's `requires`: the message's requirements as a sorted JSON list of strings (`["sandbox=docker"]`).
 * A VARCHAR on MySQL, which gives no TEXT column a literal default.
 */
export const REQUIRES_COLUMN: Record<Dialect, string> = {
  sqlite: "requires TEXT NOT NULL DEFAULT '[]'",
  mysql: "requires VARCHAR(1024) NOT NULL DEFAULT '[]'",
};

interface Index {
  name: string;
  columns: string;
  /** SQLite only; MySQL has no partial indexes. */
  where?: string;
}

/** CREATE TABLE IF NOT EXISTS plus its indexes: inline keys on MySQL (no CREATE INDEX IF NOT EXISTS there). */
function table(dialect: Dialect, name: string, columns: readonly string[], indexes: readonly Index[] = []): string[] {
  if (dialect === "mysql") {
    const keys = indexes.map((i) => `KEY ${i.name} (${i.columns})`);
    return [`CREATE TABLE IF NOT EXISTS ${name} (\n  ${[...columns, ...keys].join(",\n  ")}\n) ${MYSQL_TABLE}`];
  }
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.join(",\n  ")}\n)`,
    ...indexes.map((i) => `CREATE INDEX IF NOT EXISTS ${i.name} ON ${name} (${i.columns})${i.where ? ` WHERE ${i.where}` : ""}`),
  ];
}

/** The DDL of one topic's tables. */
export function topicTablesSql(topic: TopicDescriptor, dialect: Dialect): string[] {
  const t = TYPES[dialect];
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
      ? [REQUIRES_COLUMN[dialect], `claimed_by ${t.id}`, `claim_token ${t.int} NOT NULL DEFAULT 0`, `claim_until ${t.time}`, `acked_at ${t.time}`]
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
    ...table(dialect, n.messages, messageColumns, messageIndexes),
    ...(competing
      ? []
      : table(dialect, n.cursors, [
          `consumer_group ${t.id} NOT NULL`,
          `${P} ${t.int} NOT NULL`,
          `last_seq ${t.int} NOT NULL DEFAULT 0`,
          `owner ${t.id}`,
          `lease_token ${t.int} NOT NULL DEFAULT 0`,
          `lease_until ${t.time}`,
          `PRIMARY KEY (consumer_group, ${P})`,
        ])),
    ...table(
      dialect,
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
    ...table(dialect, n.deadLetters, [
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
export function busTablesSql(dialect: Dialect): string[] {
  const t = TYPES[dialect];
  return [
    ...table(dialect, TOPICS_TABLE, [
      `name ${t.id} NOT NULL PRIMARY KEY`,
      `consumption ${t.id} NOT NULL`,
      `partitions ${t.int} NOT NULL`,
    ]),
    ...table(dialect, SCHEDULER_TABLE, [`id ${t.int} NOT NULL PRIMARY KEY`, `released_until ${t.time} NOT NULL`]),
  ];
}

/** MySQL's duplicate-key error number (ER_DUP_ENTRY). */
const MYSQL_DUPLICATE_KEY = 1062;

/**
 * `INSERT INTO <rest>` (`table (cols) VALUES (...)`) that skips a row whose unique key exists; true when it
 * inserted. It skips key conflicts only, as SQLite's ON CONFLICT DO NOTHING does. On MySQL that is a plain INSERT
 * whose duplicate-key error is caught: INSERT IGNORE would also turn strict-mode errors into warnings (a value cut
 * to its column's length), and the row count of ON DUPLICATE KEY UPDATE cannot tell an insert from a skip under
 * the driver's FOUND_ROWS flag.
 */
export async function insertOrSkip(q: SqlExecutor, dialect: Dialect, rest: string, params: readonly SqlValue[] = []): Promise<boolean> {
  if (dialect === "sqlite") return (await q.run(`INSERT INTO ${rest} ON CONFLICT DO NOTHING`, params)) === 1;
  try {
    await q.run(`INSERT INTO ${rest}`, params);
    return true;
  } catch (err) {
    if ((err as { errno?: unknown } | null)?.errno === MYSQL_DUPLICATE_KEY) return false;
    throw err;
  }
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
    for (const sql of topicTablesSql(topic, db.dialect)) await db.run(sql);
    await insertOrSkip(db, db.dialect, `${TOPICS_TABLE} (name, consumption, partitions) VALUES (?, ?, ?)`, [
      topic.name,
      topic.consumption,
      topic.partitions,
    ]);
  }
}

/** The DDL of a component's outbox and inbox (one shape for every component). */
export function componentTablesSql(component: string, dialect: Dialect): string[] {
  if (!/^[a-z]+$/.test(component)) throw new Error(`component name "${component}" must be lowercase letters`);
  const t = TYPES[dialect];
  const outbox = `${component}_outbox`;
  const inbox = `${component}_inbox`;
  return [
    ...table(
      dialect,
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
      dialect,
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
  for (const sql of componentTablesSql(component, db.dialect)) await db.run(sql);
}
