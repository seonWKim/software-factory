// Outbound's retry of a failed write (design 10-event-driven, "Deliveries refused for good" and the wait rule): a
// batch is not retried before the later of its error's wait_until and the backoff; Slack's two permanent refusals
// are given up like a forge 4xx; a rate limit with no wait and a token error retry and are never given up.

import { describe, expect, it } from "vitest";
import { DEAD_LETTERED } from "../src/bus/index.js";
import type { SourceRef } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { HttpSlackApi, type FetchFn } from "../src/impl/source/slack-api.js";
import type { ThreadDelivery } from "../src/interfaces/factory-store.js";
import { Outbound, recordAction } from "../src/outbound/index.js";
import { REFUSED_ATTEMPTS } from "../src/outbound/outbound.js";
import type { Delivery, DeliveryTarget } from "../src/outbound/targets/target.js";
import type { Envelope } from "../src/shared/envelope.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { cleanScanner, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

type Deps = ConstructorParameters<typeof Outbound>[0];
type Db = Parameters<typeof recordAction>[0];

const START = "2026-11-10T00:00:00.000Z";
const THREAD: SourceRef = { type: "slack_thread", id: "slack:T0:C0:1800000000.000001", link: "l" };
const BASE_MS = 1000;

/** What fake slack.com answers chat.postMessage with; it may change between flushes. */
interface Answer { status: number; headers?: Record<string, string>; body?: unknown }

/** One comment intent in one batch, an outbound whose `slack-thread` target posts through HttpSlackApi to a fake slack.com. */
async function setup(o: { action?: boolean } = {}) {
  const { store } = await newStore();
  const db = store.db as Db;
  const clock = new FakeClock(START);
  let answer: Answer = { status: 200, body: { ok: true, ts: "1800000000.000002" } };
  const fetchFn: FetchFn = async () => {
    const headers = answer.headers ?? {};
    return { status: answer.status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => answer.body };
  };
  const secrets = { get: async () => ({ name: "SLACK_BOT_TOKEN", reveal: () => "test-value", toString: () => "[secret]", toJSON: () => "[secret]" }) };
  const api = new HttpSlackApi(secrets as never, fetchFn, undefined, () => clock.now().getTime());
  const attempts: string[] = [];
  const target: DeliveryTarget = {
    name: "slack-thread",
    accepts: (d) => (d.kind === "comment" ? d.source_type : d.row.source_type) === THREAD.type,
    deliver: async (d: Delivery) => {
      attempts.push(clock.now().toISOString());
      const text = d.kind === "comment" ? d.body : String(d.row.args.body);
      const r = await api.postMessage({ channel: "C0", thread_ts: "1800000000.000001", text });
      return { url: `https://slack.test/${r.ts}` };
    },
  };

  // The thread outbox row of the comment (the one intent), kept in memory.
  const row: ThreadDelivery = {
    seq: 1, thread_seq: 1, work_item_id: "wi_1" as ThreadDelivery["work_item_id"], source_type: THREAD.type as ThreadDelivery["source_type"],
    target: THREAD, link_field: null, marker: "<!-- m -->", body: "hello", attempts: 0, next_attempt_at: START as ThreadDelivery["next_attempt_at"],
    delivered_at: null, url: null, last_error: null, created_at: START as ThreadDelivery["created_at"],
  };
  let token = 0;
  const fakeStore: Deps["store"] = {
    getDelivery: async () => ({ ...row }),
    claimDelivery: async () => (row.delivered_at === null ? ++token : null),
    getPostedComment: async () => null,
    finishDelivery: async (_seq, _t, url) => {
      row.delivered_at = clock.now().toISOString() as ThreadDelivery["delivered_at"];
      row.url = url;
      return true;
    },
    failDelivery: async (_seq, _t, error) => {
      row.attempts++;
      row.last_error = error;
      return true;
    },
  };

  let intent = "int_1";
  if (o.action) {
    await recordAction(db, { action: "post", args: { body: "hello", marker: "m0" }, target: THREAD }, START);
    const { seq } = ((await db.all("SELECT MAX(seq) AS seq FROM outbound_actions")) as { seq: number }[])[0]!;
    intent = `act_${seq}`;
  }
  const destination = `${THREAD.type}:${THREAD.id}`;
  await db.run(
    "INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, opened_at, flush_at) VALUES ('b1', ?, 'k1', 'open', 1, ?, ?)",
    [destination, START, START],
  );
  await db.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, 'b1', 'c1', 1)", [intent]);

  const published: Envelope[] = [];
  const outbound = new Outbound({
    db: db as Deps["db"], store: fakeStore, targets: [target], scanner: cleanScanner, log: silent,
    bus: { publish: async (_tx: unknown, es: Envelope[]) => void published.push(...es) } as unknown as Deps["bus"],
    config: () => ({ lease_ms: 60_000, retry_base_ms: BASE_MS, retry_max_ms: 3_600_000, project_key: "p" }),
    canSend: () => true,
    kinds: () => [THREAD.type],
    fenceFor: () => null,
    fenceRefused: async () => {},
  });
  const flush = () => outbound.flush(tickAt("outbound-flush", 250, clock.now().getTime()));
  const batch = async () => (await db.all("SELECT state, attempts, flush_at FROM outbound_batches WHERE id = 'b1'"))[0]!;
  const alarms = () => published.filter((e) => e.type === DEAD_LETTERED);
  return { clock, row, attempts, flush, batch, alarms, answer: (a: Answer) => void (answer = a), db };
}

const refusal = (error: string): Answer => ({ status: 200, body: { ok: false, error } });

describe("outbound retry of a failed write", () => {
  for (const kind of ["comment", "action"] as const) {
    it(`${kind === "comment" ? "a comment" : "an action"} rate limited with Retry-After is not retried before its wait_until, though the backoff ends sooner`, async () => {
      const f = await setup({ action: kind === "action" });
      f.answer({ status: 429, headers: { "retry-after": "600" } });
      await f.flush();
      const waitUntil = Date.parse(START) + 600_000;
      expect(Date.parse(String((await f.batch()).flush_at))).toBe(waitUntil);

      f.answer({ status: 200, body: { ok: true, ts: "1800000000.000002" } });
      f.clock.advance(BASE_MS * 4);
      await f.flush();
      f.clock.advance(600_000 - BASE_MS * 4 - 1);
      await f.flush();
      expect(f.attempts).toHaveLength(1);

      f.clock.advance(1);
      await f.flush();
      expect(f.attempts.map(Date.parse)).toEqual([Date.parse(START), waitUntil]);
      expect((await f.batch()).state).toBe("sent");
    });
  }

  it("a wait_until earlier than the backoff leaves the backoff", async () => {
    const f = await setup();
    f.answer({ status: 429, headers: { "retry-after": "0" } });
    await f.flush();
    expect(Date.parse(String((await f.batch()).flush_at))).toBe(Date.parse(START) + BASE_MS);
  });

  it("a 429 with no Retry-After retries on the backoff and is never given up", async () => {
    const f = await setup();
    f.answer({ status: 429 });
    for (let i = 0; i < REFUSED_ATTEMPTS + 2; i++) {
      await f.flush();
      const b = await f.batch();
      expect(b).toMatchObject({ state: "failed", attempts: i + 1 });
      expect(Date.parse(String(b.flush_at))).toBe(f.clock.now().getTime() + BASE_MS * 2 ** i);
      f.clock.advance(3_600_000);
    }
    expect(f.row.delivered_at).toBeNull();
    expect(f.alarms()).toEqual([]);
  });

  for (const code of ["channel_not_found", "not_in_channel"]) {
    it(`a comment refused with ${code} is retried twice and given up on the third attempt, with no link and one alarm`, async () => {
      const f = await setup();
      f.answer(refusal(code));
      for (let i = 1; i < REFUSED_ATTEMPTS; i++) {
        await f.flush();
        expect(f.row.delivered_at).toBeNull();
        f.clock.advance(3_600_000);
      }
      await f.flush();
      expect(f.attempts).toHaveLength(REFUSED_ATTEMPTS);
      expect(f.row.delivered_at).not.toBeNull();
      expect(f.row.url).toBeNull();
      expect((await f.batch()).state).toBe("sent");
      expect(f.alarms()).toHaveLength(1);
      expect(f.alarms()[0]!.payload).toMatchObject({ message_id: "int_1", error_code: "non_retryable" });
    });
  }

  for (const code of ["invalid_auth", "token_revoked"]) {
    it(`a comment refused with ${code} is retried and never given up`, async () => {
      const f = await setup();
      f.answer(refusal(code));
      for (let i = 0; i < REFUSED_ATTEMPTS + 2; i++) {
        await f.flush();
        f.clock.advance(3_600_000);
      }
      expect(f.attempts).toHaveLength(REFUSED_ATTEMPTS + 2);
      expect(f.row.delivered_at).toBeNull();
      expect((await f.batch()).state).toBe("failed");
      expect(f.alarms()).toEqual([]);
    });
  }
});
