import { describe, expect, it } from "vitest";
import type { Claimed, EventBus, Inbox } from "../../src/bus/index.js";
import { ComponentConsumer } from "../../src/runtime/consumer.js";
import type { Registry } from "../../src/runtime/registry/registry.js";
import { envelope, type Envelope } from "../../src/shared/envelope.js";
import type { HandlerContext } from "../../src/shared/handler.js";
import type { SqlDriver } from "../../src/state/index.js";

// A SqlDriver may run a transaction's function again (MySQL retries a deadlock: SqlDriver.transaction). The
// messages a handler emitted on the attempt that rolled back must not be published by the attempt that commits:
// each extra copy would be handled again downstream.

const NOW = "2026-11-09T00:00:00.000Z";

describe("component consumer", () => {
  it("publishes only what the committing attempt emitted when the transaction runs twice", async () => {
    const m = envelope(
      { type: "Ping", subject: "s", idempotency_key: "k", idempotency_key_ttl_ms: null, payload: {} },
      { id: null, correlation_id: "c", project_id: "p", passport_id: null, occurred_at: NOW },
      "test",
    );
    const claimed = { topic: "t", group: "h", partition: 0, seq: 1, attempt: 1, message: m } as unknown as Claimed;
    const published: Envelope[][] = [];
    const bus = {
      subscribe: async () => {},
      consume: async () => [claimed],
      renew: async () => true,
      publish: async (_tx: unknown, ms: Envelope[]) => void published.push(ms),
      claim: async () => "new",
      ack: async () => {},
      nack: async () => {},
    } as unknown as EventBus & Inbox;
    let attempts = 0;
    const db = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        attempts++;
        await fn({}); // rolled back: a deadlock, retried as MySQL's driver does
        return fn({});
      },
    } as unknown as SqlDriver;
    const handler = {
      kind: "handler", name: "h", accepts: ["Ping"],
      handle: async (_m: Envelope, ctx: { emit: (d: unknown) => void }) => {
        ctx.emit({ type: "Pong", subject: "s", idempotency_key: "pong:k", idempotency_key_ttl_ms: null, payload: {} });
      },
    };
    const registry = {
      handlers: [{ file: "x/handlers/h/h.handler.ts", descriptor: handler }],
      topicOf: () => ({ name: "t" }),
    } as unknown as Registry;
    const consumer = new ComponentConsumer<HandlerContext>({
      db, bus, registry, component: "x", transactional: true,
      context: (_tx, emit) => ({ emit }) as unknown as HandlerContext,
    });

    await consumer.consume();
    expect(attempts).toBe(1);
    expect(published.map((ms) => ms.length)).toEqual([1, 1]);
  });
});
