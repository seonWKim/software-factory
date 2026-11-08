import { describe, expect, it } from "vitest";
import { defineHandler } from "../src/shared/handler.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { TimeBasedTickGenerator } from "../src/shared/ticks/plugins/time-based/time-based-tick-generator.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { defineTopic, maxRedeliveryMs, partitionOf, topicTable } from "../src/shared/topic.js";
import { Registry } from "../src/runtime/registry/registry.js";
import type { Tick } from "../src/shared/ticks/tick-generator.js";

const topic = (name: string, messages: Record<string, "command" | "event">) =>
  ({ file: `x/topics/${name}.topic.ts`, descriptor: defineTopic({ name, owner: "x", messages, consumption: "partitioned", retentionDays: 1 }) });
const handler = (name: string, accepts: string[], canHandle?: () => boolean) =>
  ({ file: `x/handlers/${name}/${name}.handler.ts`, descriptor: defineHandler({ name, accepts, ...(canHandle ? { canHandle } : {}), handle: async () => {} }) });

describe("topics", () => {
  it("map to bus_ tables, partition stably, and bound redelivery", () => {
    expect(topicTable("runs.requests")).toBe("bus_runs_requests");
    expect(partitionOf("wi_1", 16)).toBe(partitionOf("wi_1", 16));
    expect(partitionOf("wi_1", 16)).toBeLessThan(16);
    expect(maxRedeliveryMs({ baseMs: 1000, maxMs: 4000, maxAttempts: 4 })).toBe(1000 + 2000 + 4000);
    expect(() => defineTopic({ name: "Bad", owner: "x", messages: { A: "event" }, consumption: "fanout", retentionDays: 1 })).toThrow(/dotted/);
  });
});

describe("registry", () => {
  it("fans events out, filters by canHandle, and refuses a command with no or two handlers", () => {
    const r = new Registry(
      [handler("a", ["Happened"]), handler("b", ["Happened"], () => false), handler("c", ["Do"])],
      [topic("x.events", { Happened: "event" }), topic("x.commands", { Do: "command", Undone: "command" })],
    );
    const m = { type: "Happened" } as never;
    expect(r.handlersFor("Happened").map((h) => h.name)).toEqual(["a", "b"]);
    expect(r.dispatch(m).map((h) => h.name)).toEqual(["a"]);
    expect(r.problems()).toEqual(["command Undone has 0 handlers; a command needs exactly one"]);
  });

  it("refuses duplicate handler names and a type on two topics", () => {
    expect(() => new Registry([handler("a", ["X"]), handler("a", ["Y"])], [])).toThrow(/used by/);
    expect(() => new Registry([], [topic("x.one", { X: "event" }), topic("x.two", { X: "event" })])).toThrow(/two topics/);
  });
});

describe("tick generators", () => {
  it("manual: a test steps time exactly; the slot follows the period", async () => {
    const g = new ManualTickGenerator();
    const seen: Tick[] = [];
    g.schedule("reaper", 30_000, async (t) => void seen.push(t));
    await g.tick("reaper", "2026-11-08T00:00:59.000Z");
    expect(seen).toEqual([{ schedule: "reaper", now: "2026-11-08T00:00:59.000Z", slot: Math.floor(Date.parse("2026-11-08T00:00:59.000Z") / 30_000) }]);
    await expect(g.tick("nope", 0)).rejects.toThrow(/no tick schedule/);
  });

  it("time-based: ticks until aborted and keeps going after a failing tick", async () => {
    const errors: string[] = [];
    const g = new TimeBasedTickGenerator((s) => errors.push(s));
    let n = 0;
    const stop = new AbortController();
    g.schedule("fast", 1, async () => {
      n++;
      if (n === 1) throw new Error("boom");
      if (n === 3) stop.abort();
    });
    await g.run(stop.signal);
    expect(n).toBe(3);
    expect(errors).toEqual(["fast"]);
  });

  it("time-based: a live period is read again after each tick, so a change sets the next wait and slot", async () => {
    const waits: number[] = [];
    let now = 0;
    const stop = new AbortController();
    const g = new TimeBasedTickGenerator(() => {}, {
      now: () => new Date(now),
      sleep: async (ms) => void (waits.push(ms), (now += ms)),
    });
    let period = 1_000;
    const slots: number[] = [];
    g.schedule("decide", () => period, async (t) => {
      slots.push(t.slot);
      if (slots.length === 1) period = 5_000; // a tick that refreshed tick_ms
      if (slots.length === 3) stop.abort();
    });
    await g.run(stop.signal);
    expect(waits).toEqual([5_000, 5_000, 5_000]);
    expect(slots).toEqual([0, 1, 2]);
  });

  it("time-based on an injected time: `due` is one period after the previous tick ended; a live period applies at the next wait", async () => {
    const start = Date.parse("2026-11-08T00:00:00.000Z");
    const clock = new FakeClock(new Date(start));
    const g = new TimeBasedTickGenerator(() => {}, clock);
    let period = 1_000;
    const seen: Tick[] = [];
    const stop = new AbortController();
    g.schedule("watch", () => period, async (t) => {
      seen.push(t);
      if (seen.length === 1) {
        // A slow first tick, and a new period read before the wait that follows it.
        clock.advance(500);
        period = 2_000;
      } else stop.abort();
    });
    const loop = g.run(stop.signal);
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    clock.advance(1_999);
    await settle();
    expect(seen).toHaveLength(1);
    clock.advance(1);
    await loop;
    expect(seen[0]!.due).toBeUndefined();
    // Due at the end of the slow tick plus the new period, so the slow tick never reads as a late wake.
    expect(seen[1]).toMatchObject({ now: new Date(start + 2_500).toISOString(), due: new Date(start + 2_500).toISOString() });
  });
});
