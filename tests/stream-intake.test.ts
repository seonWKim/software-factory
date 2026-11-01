import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INBOX_RETENTION_DAYS, inboxRetentionDays, loadConfig } from "../src/compose.js";
import { Controller, inboxCursorName } from "../src/core/controller.js";
import { Listener } from "../src/core/listener.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { REGISTRY, createPlugin } from "../src/plugins.js";
import {
  FakeAuth,
  FakeStreamSource,
  cleanScanner,
  config,
  fakeStreamRegistry,
  recordingLog,
  silent,
  waitFor,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

const SLACK = "slack_thread" as const;
const DAY = 86_400_000;

function slackEvent(n: number): SourceEvent {
  return {
    kind: "item_requested",
    source: { type: SLACK, id: `C1/${n}`, link: `https://slack.example/archives/C1/p${n}` },
    requester: { provider: "slack", subject: "1" },
    title: `thread ${n}`,
    body: "please do it",
  };
}

/** Lets pending promise chains (store calls, the listener loop) run to quiet. */
async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const running: { ac: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.ac.abort();
    await r.done;
  }
});

function startListener(store: FactoryStore, clock: FakeClock, source: FakeStreamSource, owner: string) {
  const log = recordingLog();
  const ac = new AbortController();
  const listener = new Listener({ store, source, clock, config, log, owner, reconnect: { base_ms: 1_000, max_ms: 8_000 } });
  const done = listener.run(ac.signal);
  const r = { ac, done, log };
  running.push(r);
  return r;
}

function controller(store: FactoryStore, clock: FakeClock, source: FakeStreamSource, replica_id: string): Controller {
  return new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, replica_id });
}

/** `store` with some methods replaced, e.g. to make the inbox write fail. */
function patched(store: FactoryStore, over: Partial<FactoryStore>): FactoryStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (Object.hasOwn(over, prop)) return over[prop as keyof FactoryStore];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function stateChangeCount(store: FactoryStore, n: number): Promise<number> {
  const item = await store.getWorkItemBySource(SLACK, `C1/${n}`);
  return item ? (await store.listStateChanges(item.id)).length : 0;
}

describe("stream intake: listener", () => {
  it("stores the event, then acks it, then the controller handles it once", async () => {
    const { store, clock } = await newStore();
    const source = new FakeStreamSource();
    const storedAtAck: boolean[] = [];
    source.onAck = async (key) => {
      storedAtAck.push((await store.listInboxAfter(SLACK, 0, 10)).some((r) => r.dedupe_key === key));
    };
    source.push(slackEvent(1), "ev-1");
    const l = startListener(store, clock, source, "replica-a");

    await waitFor(() => source.acks.length === 1, "ack");
    expect(storedAtAck).toEqual([true]);
    const [row] = await store.listInboxAfter(SLACK, 0, 10);
    expect(row).toMatchObject({ dedupe_key: "ev-1", event: slackEvent(1) });
    expect(l.log.lines.map((x) => x.msg)).toEqual(["listener lease taken", "stream connected"]);

    const c = controller(store, clock, source, "replica-a");
    await c.tickIntake();
    expect(await stateChangeCount(store, 1)).toBe(1);
    expect(await store.getCursor(inboxCursorName(SLACK))).toBe(String(row!.seq));
    expect(source.statusCalls.map((s) => s.status)).toEqual(["triaging"]);
    expect(source.reactions).toEqual([{ source: { type: SLACK, id: "C1/1", link: "https://slack.example/archives/C1/p1" }, comment_id: null }]);

    // Read again: nothing after the cursor, nothing handled twice.
    await c.tickIntake();
    expect(await stateChangeCount(store, 1)).toBe(1);
    expect(inboxCursorName(SLACK)).toBe("inbox:slack_thread");
  });

  it("a duplicate dedupe_key is stored once, acked both times, and handled once", async () => {
    const { store, clock } = await newStore();
    const source = new FakeStreamSource();
    source.push(slackEvent(1), "ev-1");
    source.push(slackEvent(1), "ev-1");
    startListener(store, clock, source, "replica-a");
    await waitFor(() => source.acks.length === 2, "both acks");
    expect(source.acks).toEqual(["ev-1", "ev-1"]);
    expect(await store.listInboxAfter(SLACK, 0, 10)).toHaveLength(1);

    const c = controller(store, clock, source, "replica-a");
    const handled = vi.spyOn(c, "handleEvent");
    await c.tickIntake();
    await c.tickIntake();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await stateChangeCount(store, 1)).toBe(1);
  });

  it("a failed inbox write is not acked; the listener reconnects with backoff and logs once", async () => {
    const { store, clock } = await newStore();
    let failing = true;
    const flaky = patched(store, {
      appendInbox: async (input) => {
        if (failing) throw new Error("disk full");
        return store.appendInbox(input);
      },
    });
    const source = new FakeStreamSource();
    source.push(slackEvent(1), "ev-1");
    const l = startListener(flaky, clock, source, "replica-a");

    await waitFor(() => source.subscribes === 1 && source.open === 0, "first connection dropped");
    await flush();
    expect(source.acks).toEqual([]);
    expect(await store.listInboxAfter(SLACK, 0, 10)).toEqual([]);

    // Backoff 1s, 2s, 4s: no reconnect before it is due, one per step after.
    clock.advance(999);
    await flush();
    expect(source.subscribes).toBe(1);
    clock.advance(1);
    await waitFor(() => source.subscribes === 2, "second connection");
    clock.advance(2_000);
    await waitFor(() => source.subscribes === 3, "third connection");
    await flush();
    expect(source.acks).toEqual([]);
    // One line per state change, not one per retry.
    expect(l.log.lines.filter((x) => x.msg.startsWith("stream disconnected"))).toHaveLength(1);

    failing = false;
    clock.advance(4_000);
    await waitFor(() => source.acks.length === 1, "redelivered and acked");
    expect(source.acks).toEqual(["ev-1"]);
    expect(await store.listInboxAfter(SLACK, 0, 10)).toHaveLength(1);
  });

  it("reconnects when the stream ends or errors, and logs each state change once", async () => {
    const { store, clock } = await newStore();
    const source = new FakeStreamSource();
    source.push(slackEvent(1), "ev-1");
    const l = startListener(store, clock, source, "replica-a");
    await waitFor(() => source.acks.length === 1, "first ack");

    source.connectError = new Error("socket refused");
    source.disconnect(new Error("socket closed"));
    await waitFor(() => source.open === 0, "disconnected");
    for (const ms of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      clock.advance(ms);
      await flush();
    }
    expect(source.subscribes).toBe(6);
    source.connectError = null;
    source.push(slackEvent(2), "ev-2");
    clock.advance(8_000);
    await waitFor(() => source.acks.length === 2, "second ack");
    expect(l.log.lines.map((x) => x.msg)).toEqual([
      "listener lease taken",
      "stream connected",
      "stream disconnected; reconnecting with backoff",
      "stream connected",
    ]);
  });

  it("two listeners racing for one source: exactly one subscribes, the other waits", async () => {
    const { store, clock } = await newStore();
    const a = new FakeStreamSource();
    const b = new FakeStreamSource();
    const la = startListener(store, clock, a, "replica-a");
    const lb = startListener(store, clock, b, "replica-b");
    await waitFor(() => a.subscribes + b.subscribes === 1, "one subscriber");
    // Several heartbeats later: the holder keeps renewing and the other keeps waiting.
    for (let i = 0; i < 8; i++) {
      clock.advance(config.heartbeat_ms);
      await flush();
    }
    expect(a.subscribes + b.subscribes).toBe(1);
    expect(a.open + b.open).toBe(1);
    const waiting = a.subscribes === 0 ? la : lb;
    expect(waiting.log.lines.map((x) => x.msg)).toEqual(["listener waiting: another replica holds the lease"]);
  });

  it("when the holder stops renewing past expiry, the other listener takes the lease and subscribes", async () => {
    const { store, clock } = await newStore();
    let frozen = false;
    const aStore = patched(store, {
      renewListenerLease: async (...args) => {
        if (frozen) throw new Error("store unreachable");
        return store.renewListenerLease(...args);
      },
    });
    const a = new FakeStreamSource();
    const b = new FakeStreamSource();
    const la = startListener(aStore, clock, a, "replica-a");
    await waitFor(() => a.open === 1, "a connected");
    const lb = startListener(store, clock, b, "replica-b");
    await flush();
    expect(b.subscribes).toBe(0);

    frozen = true;
    // Under lease_ms since a's last renew: b still waits.
    for (let t = 0; t < config.lease_ms - config.heartbeat_ms; t += config.heartbeat_ms) {
      clock.advance(config.heartbeat_ms);
      await flush();
    }
    expect(b.subscribes).toBe(0);
    clock.advance(config.heartbeat_ms);
    await waitFor(() => b.open === 1, "b connected");
    await waitFor(() => a.open === 0, "a closed its stream");
    expect(la.log.lines.map((x) => x.msg)).toContain("listener lease lost; stream closed");
    expect(lb.log.lines.map((x) => x.msg)).toContain("listener lease taken");

    // b now stores and acks; a cannot write with its old token.
    b.push(slackEvent(1), "ev-1");
    await waitFor(() => b.acks.length === 1, "b acked");
    const lease = await store.acquireListenerLease(SLACK, "someone", config.lease_ms);
    expect(lease).toMatchObject({ ok: false, holder: { owner: "replica-b", token: 2 } });
    expect(await store.appendInbox({ source_type: SLACK, dedupe_key: "x", event: slackEvent(9), lease_token: 1 })).toEqual({
      ok: false, reason: "lease_lost",
    });
  });

  it("stopping releases the lease so another replica takes it at once", async () => {
    const { store, clock } = await newStore();
    const a = new FakeStreamSource();
    const l = startListener(store, clock, a, "replica-a");
    await waitFor(() => a.open === 1, "connected");
    l.ac.abort();
    await l.done;
    expect(a.open).toBe(0);
    expect((await store.acquireListenerLease(SLACK, "replica-b", config.lease_ms)).ok).toBe(true);
  });
});

describe("stream intake: controller", () => {
  it("a second replica's controller handles the inbox events and advances the same cursor", async () => {
    const { store, clock } = await newStore();
    const a = new FakeStreamSource();
    const b = new FakeStreamSource();
    startListener(store, clock, a, "replica-a");
    a.push(slackEvent(1), "ev-1");
    a.push(slackEvent(2), "ev-2");
    await waitFor(() => a.acks.length === 2, "acks");

    const ca = controller(store, clock, a, "replica-a");
    const cb = controller(store, clock, b, "replica-b");
    const handledA = vi.spyOn(ca, "handleEvent");
    await cb.tickIntake();
    expect(await stateChangeCount(store, 1)).toBe(1);
    expect(await stateChangeCount(store, 2)).toBe(1);
    const rows = await store.listInboxAfter(SLACK, 0, 10);
    expect(await store.getCursor("inbox:slack_thread")).toBe(String(rows.at(-1)!.seq));
    // b's controller set status through its own copy of the source; a never subscribed b's.
    expect(b.subscribes).toBe(0);
    expect(b.statusCalls).toHaveLength(2);

    await ca.tickIntake();
    expect(handledA).not.toHaveBeenCalled();

    a.push(slackEvent(3), "ev-3");
    await waitFor(() => a.acks.length === 3, "third ack");
    await ca.tickIntake();
    expect(handledA).toHaveBeenCalledTimes(1);
    expect(await stateChangeCount(store, 3)).toBe(1);
  });

  it("Controller.run starts the listener for a stream source and reads the inbox every tick", async () => {
    const { store, clock } = await newStore();
    const source = new FakeStreamSource();
    const c = controller(store, clock, source, "replica-a");
    const ac = new AbortController();
    const done = c.run(ac.signal);
    running.push({ ac, done });
    await waitFor(() => source.open === 1, "listener connected");
    source.push(slackEvent(1), "ev-1");
    await waitFor(() => source.acks.length === 1, "ack");
    clock.advance(config.tick_ms);
    await waitFor(async () => (await stateChangeCount(store, 1)) === 1, "handled");
  });

  it("cleanup deletes only rows older than the retention and behind the cursor", async () => {
    const { store, clock } = await newStore();
    const source = new FakeStreamSource();
    const c = controller(store, clock, source, "replica-a");
    startListener(store, clock, source, "replica-a");

    // No cursor yet: nothing is deleted, however old.
    source.push(slackEvent(1), "ev-1");
    await waitFor(() => source.acks.length === 1, "ack 1");
    clock.advance(30 * DAY);
    await c.cleanupInbox();
    expect((await store.listInboxAfter(SLACK, 0, 10)).map((r) => r.dedupe_key)).toEqual(["ev-1"]);

    source.push(slackEvent(2), "ev-2");
    await waitFor(() => source.acks.length === 2, "ack 2");
    await c.tickIntake(); // cursor now at ev-2
    source.push(slackEvent(3), "ev-3"); // ahead of the cursor
    await waitFor(() => source.acks.length === 3, "ack 3");
    clock.advance((config.inbox_retention_days - 1) * DAY);
    source.push(slackEvent(4), "ev-4");
    await waitFor(() => source.acks.length === 4, "ack 4");
    clock.advance(DAY + 1);
    // ev-1, ev-2: old and behind the cursor → gone. ev-3: old but ahead of the cursor. ev-4: too new.
    await c.cleanupInbox();
    expect((await store.listInboxAfter(SLACK, 0, 10)).map((r) => r.dedupe_key)).toEqual(["ev-3", "ev-4"]);

    await c.tickIntake(); // cursor now at ev-4
    await c.cleanupInbox();
    expect((await store.listInboxAfter(SLACK, 0, 10)).map((r) => r.dedupe_key)).toEqual(["ev-4"]);
    expect(await stateChangeCount(store, 3)).toBe(1);
  });
});

describe("stream intake: config and wiring", () => {
  it("inbox_retention_days defaults to 14 and must be a positive integer", () => {
    expect(DEFAULT_INBOX_RETENTION_DAYS).toBe(14);
    expect(inboxRetentionDays({})).toBe(14);
    expect(inboxRetentionDays({ inbox_retention_days: 3 })).toBe(3);
    for (const bad of [0, -1, 1.5, "7", null]) {
      expect(() => inboxRetentionDays({ inbox_retention_days: bad as never })).toThrow(/inbox_retention_days must be a positive integer/);
    }
  });

  it("loadConfig carries inbox_retention_days and fails startup on a bad value", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const dir = mkdtempSync(join(tmpdir(), "sf-inbox-"));
    try {
      cpSync(join(root, "prompts"), join(dir, "prompts"), { recursive: true });
      const file = JSON.parse(readFileSync(join(root, "factory.config.json"), "utf8")) as Record<string, unknown>;
      const write = (extra: Record<string, unknown>) =>
        writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...file, store: { type: "sqlite" }, ...extra }));
      write({});
      expect((await loadConfig(dir)).config.inbox_retention_days).toBe(14);
      write({ inbox_retention_days: 30 });
      expect((await loadConfig(dir)).config.inbox_retention_days).toBe(30);
      write({ inbox_retention_days: 0 });
      await expect(loadConfig(dir)).rejects.toThrow(/inbox_retention_days/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fake-stream is test-only: absent from REGISTRY, available through the test registry", async () => {
    expect(Object.keys(REGISTRY.source.plugins)).not.toContain("fake-stream");
    const registry = fakeStreamRegistry();
    const source = await createPlugin(registry, "source", "fake-stream", {} as never);
    expect(source).toBeInstanceOf(FakeStreamSource);
    expect(source).toMatchObject({ type: "slack_thread", intake: "stream" });
  });
});
