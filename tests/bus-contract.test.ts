import { describe, expect, it } from "vitest";
import {
  SqlEventBus,
  SqlRetryScheduler,
  deliver,
  ensureComponentTables,
  ensureTopicTables,
  scheduleBus,
  scheduleComponent,
  type Claimed,
  type EventBus,
} from "../src/bus/index.js";
import { envelope, type Envelope } from "../src/shared/envelope.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { defineTopic, type TopicDescriptor } from "../src/shared/topic.js";
import type { Dialect, MigrationDb, SqlDriver } from "../src/state/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { MysqlMigrations } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MYSQL_URL, newEmptyMysqlDatabase } from "./helpers/store.js";

// The bus contract (RFC 0015 §5, §11 M3): every EventBus implementation passes it. It runs on SQLite always
// and on MySQL when SF_TEST_MYSQL_URL is set. Time moves only through ManualTickGenerator ticks.

const EVENTS = defineTopic({
  name: "test.events",
  owner: "test",
  messages: { Happened: "event", Delayed: "event" },
  partitions: 4,
  consumption: "partitioned",
  retentionDays: 7,
  backoff: { baseMs: 1_000, maxMs: 4_000, maxAttempts: 3 },
});
const WORK = defineTopic({
  name: "test.work",
  owner: "test",
  messages: { WorkRequested: "command" },
  consumption: "competing",
  retentionDays: 7,
  backoff: { baseMs: 1_000, maxMs: 4_000, maxAttempts: 3 },
});
const TOPICS: readonly TopicDescriptor[] = [EVENTS, WORK];
const LEASE_MS = 30_000;

interface Backend {
  name: Dialect;
  open(): Promise<SqlDriver>;
}

const BACKENDS: Backend[] = [
  {
    name: "sqlite",
    async open() {
      const d = new SqliteDriver(":memory:");
      await d.migrate();
      return d;
    },
  },
  ...(MYSQL_URL
    ? [
        {
          name: "mysql" as const,
          async open() {
            const db = await newEmptyMysqlDatabase();
            await new MysqlMigrations(await db.connect()).apply(() => undefined);
            const d = new MysqlDriver(db.options);
            db.onCleanup(() => d.close());
            return d;
          },
        },
      ]
    : []),
];

async function setup(backend: Backend) {
  const db = await backend.open();
  const mdb: MigrationDb = { dialect: backend.name, all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p) };
  await ensureTopicTables(mdb, TOPICS);
  await ensureComponentTables(mdb, "testc");
  await db.run(`CREATE TABLE testc_effects (k ${backend.name === "mysql" ? "VARCHAR(191)" : "TEXT"} NOT NULL)`);

  const clock = new FakeClock("2026-11-08T00:00:00.000Z");
  const busTicks = new ManualTickGenerator();
  const scheduler = new SqlRetryScheduler(db, TOPICS);
  scheduleBus(busTicks, scheduler);
  const newBus = (consumerId: string) => new SqlEventBus({ db, dialect: backend.name, component: "testc", topics: TOPICS, consumerId, leaseMs: LEASE_MS });
  const a = newBus("a");
  const b = newBus("b");
  const componentTicks = new ManualTickGenerator();
  scheduleComponent(componentTicks, a);

  let n = 0;
  const now = () => clock.now().toISOString();
  const msg = (type: string, subject: string, extra: { key?: string; notBefore?: string; ttl?: number | null } = {}): Envelope => {
    n++;
    return envelope(
      {
        type,
        subject,
        idempotency_key: extra.key ?? `k${n}`,
        idempotency_key_ttl_ms: extra.ttl === undefined ? null : extra.ttl,
        not_before: extra.notBefore ?? null,
        payload: { n },
      },
      { id: null, correlation_id: `corr-${subject}`, project_id: "p1", passport_id: null, occurred_at: now() },
      "test",
      `m${n}`,
    );
  };
  const publish = (...ms: Envelope[]) => db.transaction((tx) => a.publish(tx, ms));
  const relay = () => componentTicks.tick("relay", now());
  /** Moves time and lets the scheduler release what became due. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    await busTicks.tick("retry", now());
  };
  const effects = async () => (await db.all("SELECT k FROM testc_effects ORDER BY k")).map((r) => String(r.k));
  const handle = (bus: EventBus, c: Claimed, consumer = "h") =>
    deliver(db, bus, a, consumer, c, async (tx, m) => {
      await tx.run("INSERT INTO testc_effects (k) VALUES (?)", [`${consumer}:${m.idempotency_key}`]);
    });
  await advance(0);
  return { db, a, b, scheduler, msg, publish, relay, advance, effects, handle, now, componentTicks, busTicks };
}

describe.each(BACKENDS)("bus contract ($name)", (backend) => {
  it("publishes from the outbox only when the caller's transaction commits", async () => {
    const s = await setup(backend);
    await expect(
      s.db.transaction(async (tx) => {
        await s.a.publish(tx, [s.msg("Happened", "x")]);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    await s.relay();
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);

    await s.publish(s.msg("Happened", "x"));
    await s.relay();
    const [c] = await s.a.consume("g", EVENTS.name, 10);
    expect(c?.message.type).toBe("Happened");
    expect(c?.attempt).toBe(1);
  });

  it("refuses an unknown type, a bad envelope, and a TTL below the topic's maximum redelivery", async () => {
    const s = await setup(backend);
    await expect(s.publish(s.msg("Unknown", "x"))).rejects.toThrow("no topic declares it");
    await expect(s.publish(s.msg("Happened", "x", { ttl: 1_000 }))).rejects.toThrow("below test.events's maximum redelivery");
    await expect(s.publish({ ...s.msg("Happened", "x"), payload: { body: "x".repeat(201) } })).rejects.toThrow("store it and send its id");
  });

  it("at-least-once delivery plus inbox dedupe is effectively once", async () => {
    const s = await setup(backend);
    const first = s.msg("Happened", "x", { key: "same" });
    // The same key again: a re-polled comment or a resubmitted form gets a new message id but keeps its key.
    const again = s.msg("Happened", "x", { key: "same" });
    await s.publish(first, again);
    // A relay that runs twice publishes each row once.
    await s.relay();
    await s.relay();

    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (const c of await s.a.consume("g", EVENTS.name, 10)) outcomes.push(await s.handle(s.a, c));
    }
    expect(outcomes).toEqual(["handled", "duplicate"]);
    expect(await s.effects()).toEqual(["h:same"]);
  });

  it("a crash between handle and ack redelivers after the lease, and the redelivery has no effect", async () => {
    const s = await setup(backend);
    await s.publish(s.msg("Happened", "x"));
    await s.relay();
    const [c] = await s.a.consume("g", EVENTS.name, 10);
    // Handle and commit, then "crash": no ack.
    await s.db.transaction(async (tx) => {
      expect(await s.a.claim(tx, "h", c!.message)).toBe("new");
      await tx.run("INSERT INTO testc_effects (k) VALUES (?)", [`h:${c!.message.idempotency_key}`]);
    });
    // Nobody else gets it while the lease holds.
    await s.advance(LEASE_MS - 1);
    expect(await s.b.consume("g", EVENTS.name, 10)).toEqual([]);
    await s.advance(1);
    const [again] = await s.b.consume("g", EVENTS.name, 10);
    expect(again?.message.id).toBe(c!.message.id);
    expect(await s.handle(s.b, again!)).toBe("duplicate");
    expect(await s.effects()).toEqual(["h:k1"]);
    // The stale consumer's late ack changes nothing, and the partition is done.
    await s.a.ack(c!);
    await s.advance(LEASE_MS);
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
  });

  it("keeps per-partition order: one message of a partition at a time, in publish order", async () => {
    const s = await setup(backend);
    const subjects = ["s1", "s2", "s3", "s4", "s5"];
    const ms = Array.from({ length: 20 }, (_, i) => s.msg("Happened", subjects[i % subjects.length]!));
    await s.publish(...ms);
    await s.relay();
    const seen = new Map<string, number[]>();
    for (let round = 0; round < 40; round++) {
      const batch = await s.a.consume("g", EVENTS.name, 10);
      expect(new Set(batch.map((c) => c.partition)).size).toBe(batch.length);
      for (const c of batch) {
        seen.set(c.message.subject, [...(seen.get(c.message.subject) ?? []), Number(c.message.payload.n)]);
        await s.a.ack(c);
      }
    }
    expect([...seen.values()].flat().length).toBe(20);
    for (const ns of seen.values()) expect(ns).toEqual([...ns].sort((x, y) => x - y));
  });

  it("two consumers in one group never get the same message", async () => {
    const s = await setup(backend);
    await s.publish(...Array.from({ length: 12 }, (_, i) => s.msg("Happened", `s${i}`)));
    await s.publish(...Array.from({ length: 12 }, () => s.msg("WorkRequested", "run")));
    await s.relay();
    for (const topic of [EVENTS.name, WORK.name]) {
      const got: string[] = [];
      for (let round = 0; round < 12; round++) {
        const [x, y] = await Promise.all([s.a.consume("g", topic, 3), s.b.consume("g", topic, 3)]);
        const ids = [...x, ...y].map((c) => c.message.id);
        expect(new Set(ids).size).toBe(ids.length);
        got.push(...ids);
        for (const c of x) await s.a.ack(c);
        for (const c of y) await s.b.ack(c);
      }
      expect(new Set(got).size).toBe(12);
      expect(got.length).toBe(12);
    }
  });

  it("fans out: every consumer group gets every message", async () => {
    const s = await setup(backend);
    await s.publish(s.msg("Happened", "x"), s.msg("Happened", "y"));
    await s.relay();
    for (const group of ["g1", "g2"]) {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        for (const c of await s.a.consume(group, EVENTS.name, 10)) {
          ids.push(c.message.id);
          await s.a.ack(c);
        }
      }
      expect(ids.sort()).toEqual(["m1", "m2"]);
    }
  });

  it("retries with the topic's backoff, holding the partition, then dead-letters after the last attempt", async () => {
    const s = await setup(backend);
    await s.publish(s.msg("Happened", "x"), s.msg("Happened", "x"));
    await s.relay();
    let [c] = await s.a.consume("g", EVENTS.name, 10);
    expect(c?.message.id).toBe("m1");
    for (const attempt of [1, 2]) {
      expect(c?.attempt).toBe(attempt);
      await s.a.nack(c!, { retryable: true, code: "rate_limited" });
      // Head-of-line: the next message of the partition waits too.
      expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
      const full = 1_000 * 2 ** (attempt - 1);
      await s.advance(Math.floor(full * 0.8) - 1);
      expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
      await s.advance(full - Math.floor(full * 0.8) + 1);
      [c] = await s.a.consume("g", EVENTS.name, 10);
      expect(c?.message.id).toBe("m1");
    }
    expect(c?.attempt).toBe(3);
    await s.a.nack(c!, { retryable: true, code: "rate_limited", detail: "still" });
    const dead = await s.db.all("SELECT message_seq, attempts, error_code, last_error FROM bus_test_events_dead_letters");
    expect(dead.map((r) => ({ ...r, message_seq: Number(r.message_seq), attempts: Number(r.attempts) }))).toEqual([
      { message_seq: c!.seq, attempts: 3, error_code: "max_attempts", last_error: "rate_limited: still" },
    ]);
    // The cursor moved on.
    const [next] = await s.a.consume("g", EVENTS.name, 10);
    expect(next?.message.id).toBe("m2");
  });

  it("dead-letters a non-retryable or unhandled message at once, and a replay delivers it again with its key", async () => {
    const s = await setup(backend);
    await s.publish(s.msg("Happened", "x", { key: "kx" }), s.msg("WorkRequested", "w", { key: "kw" }));
    await s.relay();
    const [e] = await s.a.consume("g", EVENTS.name, 10);
    await s.a.nack(e!, { retryable: false, code: "bad_input" });
    const [w] = await s.a.consume("g", WORK.name, 10);
    await s.a.nack(w!, { retryable: true, code: "unhandled" });
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
    expect(await s.a.consume("g", WORK.name, 10)).toEqual([]);
    const codes = [
      ...(await s.db.all("SELECT error_code FROM bus_test_events_dead_letters")),
      ...(await s.db.all("SELECT error_code FROM bus_test_work_dead_letters")),
    ].map((r) => r.error_code);
    expect(codes).toEqual(["non_retryable", "unhandled"]);

    await s.scheduler.replay(EVENTS.name, "g", e!.seq, "u_owner");
    await s.scheduler.replay(WORK.name, "g", w!.seq, "u_owner");
    await expect(s.scheduler.replay(WORK.name, "g", w!.seq, "u_owner")).rejects.toThrow("no open dead letter");
    const [e2] = await s.a.consume("g", EVENTS.name, 10);
    const [w2] = await s.a.consume("g", WORK.name, 10);
    expect([e2?.message.idempotency_key, w2?.message.idempotency_key]).toEqual(["kx", "kw"]);
    expect(await s.handle(s.a, e2!)).toBe("handled");
    expect(await s.handle(s.a, w2!)).toBe("handled");
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
  });

  it("holds a delayed message until the scheduler's tick passes not_before, without holding up its partition", async () => {
    const s = await setup(backend);
    const later = new Date(Date.parse(s.now()) + 300_000).toISOString();
    await s.publish(s.msg("Delayed", "x", { notBefore: later }), s.msg("Happened", "x"));
    await s.publish(s.msg("WorkRequested", "w", { notBefore: later }));
    await s.relay();
    const [first] = await s.a.consume("g", EVENTS.name, 10);
    expect(first?.message.type).toBe("Happened");
    await s.a.ack(first!);
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
    expect(await s.a.consume("g", WORK.name, 10)).toEqual([]);

    await s.advance(299_999);
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
    await s.advance(1);
    const [timer] = await s.a.consume("g", EVENTS.name, 10);
    expect(timer?.message).toMatchObject({ type: "Delayed", not_before: later });
    const [work] = await s.a.consume("g", WORK.name, 10);
    expect(work?.message.type).toBe("WorkRequested");
    await s.a.ack(timer!);
    await s.a.ack(work!);
    await s.advance(LEASE_MS);
    expect(await s.a.consume("g", EVENTS.name, 10)).toEqual([]);
    expect(await s.a.consume("g", WORK.name, 10)).toEqual([]);
  });

  it("idempotency contract: one run, a run applied twice, and a crash before the ack end in the same state", async () => {
    const results: string[][] = [];
    for (const scenario of ["once", "twice", "crash"] as const) {
      const s = await setup(backend);
      const m = s.msg("WorkRequested", "w", { key: "run:w1:implement:1" });
      await s.publish(m);
      if (scenario === "twice") await s.publish({ ...m, id: "m-dup" });
      await s.relay();
      if (scenario === "crash") {
        const [c] = await s.a.consume("g", WORK.name, 10);
        await s.db.transaction(async (tx) => {
          await s.a.claim(tx, "h", c!.message);
          await tx.run("INSERT INTO testc_effects (k) VALUES (?)", [`h:${c!.message.idempotency_key}`]);
        });
        await s.advance(LEASE_MS);
      }
      for (let i = 0; i < 3; i++) for (const c of await s.a.consume("g", WORK.name, 10)) await s.handle(s.a, c);
      results.push(await s.effects());
    }
    expect(results).toEqual([["h:run:w1:implement:1"], ["h:run:w1:implement:1"], ["h:run:w1:implement:1"]]);
  });

  it("prunes inbox keys past their TTL, and topic rows past retention", async () => {
    const s = await setup(backend);
    const ttl = 86_400_000;
    await s.publish(s.msg("Happened", "x", { key: "short", ttl }), s.msg("Happened", "y", { key: "forever" }));
    await s.relay();
    for (let i = 0; i < 2; i++) for (const c of await s.a.consume("g", EVENTS.name, 10)) await s.handle(s.a, c);
    // Past the key's TTL and the outbox's one-day retention.
    await s.advance(ttl + 1);
    await s.componentTicks.tick("prune", s.now());
    expect((await s.db.all("SELECT idempotency_key FROM testc_inbox")).map((r) => r.idempotency_key)).toEqual(["forever"]);
    expect(await s.db.all("SELECT seq FROM testc_outbox")).toEqual([]);

    expect((await s.db.all("SELECT seq FROM bus_test_events")).length).toBe(2);
    await s.advance(EVENTS.retentionMs);
    await s.busTicks.tick("prune", s.now());
    expect(await s.db.all("SELECT seq FROM bus_test_events")).toEqual([]);
  });

  it("refuses a topic whose partitions changed after its tables were created", async () => {
    const s = await setup(backend);
    const mdb: MigrationDb = { dialect: backend.name, all: (q, p) => s.db.all(q, p), run: (q, p) => s.db.run(q, p) };
    await ensureTopicTables(mdb, TOPICS);
    await expect(ensureTopicTables(mdb, [{ ...EVENTS, partitions: 8 }])).rejects.toThrow("changing either needs a bus migration");
  });
});
