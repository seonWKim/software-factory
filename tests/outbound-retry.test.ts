import { describe, expect, it } from "vitest";
import type { SourceRef, UserId } from "../src/core/types.js";
import { HttpSlackApi, SlackApiError } from "../src/impl/source/slack-api.js";
import { Outbound, recordAction } from "../src/outbound/index.js";
import { REFUSED_ATTEMPTS } from "../src/outbound/outbound.js";
import type { Delivery, DeliveryTarget } from "../src/outbound/targets/target.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { FakeAuth, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

// Outbound's retry of a failed batch (design 10-event-driven, "A target's wait time is honored"): the next attempt
// is the later of the backoff and the error's wait time (`wait_until`, a Slack or GitHub rate limit's reset). A
// named permanent Slack refusal is given up like a GitHub 4xx; a rate limit or a token error never is.

const NOW = Date.parse("2026-11-09T01:00:00Z");
const BASE_MS = 1000;
const at = new Date(NOW - 1000).toISOString();
const target: SourceRef = { type: "local", id: "local-1", link: "l" };

type Db = Parameters<typeof recordAction>[0];
type Store = Awaited<ReturnType<typeof newStore>>["store"];

/** One batch with one `post` on `target`, due now. */
async function postBatch(db: Db): Promise<void> {
  await recordAction(db, { action: "post", args: { body: "hello", marker: "m0" }, target }, at);
  const { seq } = ((await db.all("SELECT MAX(seq) AS seq FROM outbound_actions")) as { seq: number }[])[0]!;
  await db.run(
    "INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, opened_at, flush_at) VALUES ('b0', ?, 'k0', 'open', 1, ?, ?)",
    [`${target.type}:${target.id}`, at, at],
  );
  await db.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, 'b0', 'c0', 1)", [`act_${seq}`]);
}

/** Outbound over a fake target that throws what `fail()` returns, when it returns an error. */
function outboundOver(store: Store, fail: () => Error | null): Outbound {
  const local: DeliveryTarget = {
    name: "local",
    accepts: (d: Delivery) => d.kind === "action",
    deliver: async () => {
      const err = fail();
      if (err) throw err;
      return { url: null };
    },
  };
  return new Outbound({
    db: store.db as ConstructorParameters<typeof Outbound>[0]["db"], store, targets: [local], scanner: cleanScanner, log: silent,
    bus: { publish: async () => {} } as unknown as ConstructorParameters<typeof Outbound>[0]["bus"],
    config: () => ({ lease_ms: 60_000, retry_base_ms: BASE_MS, retry_max_ms: 60_000, project_key: "p" }),
    canSend: () => true,
    kinds: () => ["local"],
    fenceFor: () => null,
    fenceRefused: async () => {},
  });
}

/** Flushes at `NOW + ms` for each `ms`; returns the times the target was tried (`tried` counts its calls). */
async function flushAt(outbound: Outbound, times: readonly number[], tried: () => number): Promise<number[]> {
  const seen: number[] = [];
  for (const ms of times) {
    const before = tried();
    await outbound.flush(tickAt("outbound-flush", 250, NOW + ms));
    if (tried() > before) seen.push(ms);
  }
  return seen;
}

describe("outbound retry wait", () => {
  it("a 429 with a wait time is not retried before it, though the backoff is shorter", async () => {
    const { store } = await newStore();
    await postBatch(store.db);
    let calls = 0;
    let limited = true;
    const wait_until = new Date(NOW + 30_000).toISOString();
    const outbound = outboundOver(store, () => {
      calls++;
      return limited ? Object.assign(new Error("rate_limited"), { status: 429, wait_until }) : null;
    });

    expect(await flushAt(outbound, [0], () => calls)).toEqual([0]);
    expect((await store.db.all("SELECT flush_at FROM outbound_batches WHERE id = 'b0'"))[0]).toMatchObject({ flush_at: wait_until });
    expect(await flushAt(outbound, [BASE_MS, 10_000, 29_999], () => calls)).toEqual([]);
    limited = false;
    expect(await flushAt(outbound, [30_000], () => calls)).toEqual([30_000]);
    expect((await store.db.all("SELECT outcome FROM outbound_actions"))[0]).toMatchObject({ outcome: "sent" });
  });

  it("a wait time earlier than the backoff waits for the backoff", async () => {
    const { store } = await newStore();
    await postBatch(store.db);
    let calls = 0;
    const outbound = outboundOver(store, () => {
      calls++;
      return Object.assign(new Error("rate_limited"), { status: 429, wait_until: new Date(NOW + 10).toISOString() });
    });
    expect(await flushAt(outbound, [0, 500, BASE_MS - 1, BASE_MS], () => calls)).toEqual([0, BASE_MS]);
  });

  it("a 429 with no wait time is retried on the backoff and never given up", async () => {
    const { store } = await newStore();
    await postBatch(store.db);
    let calls = 0;
    const outbound = outboundOver(store, () => {
      calls++;
      return Object.assign(new Error("rate_limited"), { status: 429 });
    });
    const times = Array.from({ length: REFUSED_ATTEMPTS * 2 }, (_, i) => i * 3_600_000);
    expect(await flushAt(outbound, times, () => calls)).toEqual(times);
    expect((await store.db.all("SELECT delivered_at FROM outbound_actions"))[0]).toMatchObject({ delivered_at: null });
  });
});

/** A Slack error as the Web API client throws it for an `ok: false` answer with `code`. */
async function slackError(code: string): Promise<SlackApiError> {
  const api = new HttpSlackApi(
    { get: async (name) => ({ name, reveal: () => "test-value", toString: () => "[secret]", toJSON: () => "[secret]" }) },
    async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: code }) }),
  );
  return (await api.postMessage({ channel: "C0TEST", thread_ts: "1.2", text: "x" }).catch((e: unknown) => e)) as SlackApiError;
}

/** A controller whose source fails every comment with `err`; a refused app command queues one comment on issue #7. */
async function commentFlow(err: Error) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  source.commentError = err;
  let attempts = 0;
  const post = source.postComment.bind(source);
  source.postComment = (...args) => {
    attempts++;
    return post(...args);
  };
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const { item } = await store.createWorkItem(
    { source: issueRef(7), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system,
  );
  await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "frobnicate", args: { work_item_id: item.id } });
  await controller.tickCommands();
  const step = async () => {
    clock.advance(config.retry_max_ms);
    await controller.tickOutbox();
  };
  return { store, source, item, step, attempts: () => attempts };
}

describe("slack permanent refusals in outbound", () => {
  it.each(["channel_not_found", "not_in_channel"])("a comment refused with %s is retried twice and given up on the third attempt, with one alarm", async (code) => {
    const err = await slackError(code);
    const f = await commentFlow(err);
    for (let i = f.attempts(); i < REFUSED_ATTEMPTS; ) {
      await f.step();
      i = f.attempts();
    }
    expect(f.attempts()).toBe(REFUSED_ATTEMPTS);
    const [delivery] = await f.store.listDeliveries(f.item.id);
    expect(delivery).toMatchObject({ url: null });
    expect(delivery!.delivered_at).not.toBeNull();
    for (let i = 0; i < 3; i++) await f.step();
    expect(f.attempts()).toBe(REFUSED_ATTEMPTS);
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([
      expect.objectContaining({ pattern: "dead_letter", error_code: "non_retryable", detail: expect.stringContaining(code) }),
    ]);
  });

  it.each(["invalid_auth", "token_revoked"])("a comment refused with %s is retried and never given up", async (code) => {
    const f = await commentFlow(await slackError(code));
    for (let i = 0; i < REFUSED_ATTEMPTS * 2; i++) await f.step();
    expect(f.attempts()).toBeGreaterThan(REFUSED_ATTEMPTS);
    const [delivery] = await f.store.listDeliveries(f.item.id);
    expect(delivery!.delivered_at).toBeNull();
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([]);
  });
});
