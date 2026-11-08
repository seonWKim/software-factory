import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCHING, budgetWindowMs, capped, chattyDebounceMs, flushAt, joins, type BatchingPolicy,
} from "../../src/outbound/aggregator/batching.js";
import { ManualTickGenerator } from "../../src/shared/ticks/plugins/manual/manual-tick-generator.js";

// RFC 0015 §15.1: each batching rule is a pure function of (destination stats, budget, batch, tick.now). The tick's
// time comes from ManualTickGenerator, so no clock is read.

const T0 = Date.parse("2026-11-08T00:00:00.000Z");
const quiet = { recent_deliveries: 0 };
const chatty = { recent_deliveries: 3 };
const full = { remaining: 5000, limit: 5000 };

/** The flush time the rules give at a manual tick `at` ms after T0. */
async function decided(at: number, rule: (now: string) => string): Promise<string> {
  const g = new ManualTickGenerator();
  let out = "";
  g.schedule("outbound-flush", 2_000, async (t) => void (out = rule(t.now)));
  await g.tick("outbound-flush", T0 + at);
  return out;
}

const iso = (ms: number) => new Date(T0 + ms).toISOString();
const batch = (n = 1, reply = false, opened = 0) => ({ opened_at: iso(opened), intent_count: n, reply });

describe("outbound batching rules (RFC 0015 §15.1)", () => {
  it("auto: a quiet destination with budget is sent with no added delay", async () => {
    expect(await decided(0, (now) => flushAt(DEFAULT_BATCHING, quiet, full, batch(), now))).toBe(iso(0));
  });

  it("a chatty destination (3 deliveries in 60 s) waits a 2 s debounce", async () => {
    expect(chattyDebounceMs(chatty, DEFAULT_BATCHING)).toBe(2_000);
    expect(chattyDebounceMs({ recent_deliveries: 2 }, DEFAULT_BATCHING)).toBe(0);
    expect(await decided(1_000, (now) => flushAt(DEFAULT_BATCHING, chatty, full, batch(), now))).toBe(iso(3_000));
  });

  it("never delays a reply to a person, however chatty or low the budget", async () => {
    expect(await decided(0, (now) => flushAt(DEFAULT_BATCHING, chatty, { remaining: 0, limit: 5000 }, batch(1, true), now))).toBe(iso(0));
  });

  it("a low budget widens the window step by step up to max_wait, and shrinks it as the budget recovers", () => {
    const at = (remaining: number) => budgetWindowMs({ remaining, limit: 1000 }, DEFAULT_BATCHING);
    expect([at(500), at(199), at(99), at(49), at(0)]).toEqual([0, 7_500, 15_000, 30_000, 30_000]);
    expect(budgetWindowMs(null, DEFAULT_BATCHING)).toBe(0);
  });

  it("never waits past opened_at + max_wait", async () => {
    const low = { remaining: 0, limit: 5000 };
    expect(await decided(20_000, (now) => flushAt(DEFAULT_BATCHING, quiet, low, batch(1, false, 0), now))).toBe(iso(30_000));
  });

  it("flushes at max_messages", async () => {
    expect(capped(batch(10), DEFAULT_BATCHING)).toBe(true);
    expect(await decided(0, (now) => flushAt(DEFAULT_BATCHING, chatty, full, batch(10), now))).toBe(iso(0));
  });

  it("commit mode sends each commit at once; fixed mode always waits its debounce", async () => {
    const commit: BatchingPolicy = { ...DEFAULT_BATCHING, mode: "commit" };
    const fixed: BatchingPolicy = { ...DEFAULT_BATCHING, mode: "fixed", debounce_ms: 5_000 };
    expect(await decided(0, (now) => flushAt(commit, chatty, full, batch(), now))).toBe(iso(0));
    expect(await decided(0, (now) => flushAt(fixed, quiet, full, batch(), now))).toBe(iso(5_000));
  });

  it("a new commit joins an open batch only while it still waits, and never a full one or in commit mode", () => {
    const open = { ...batch(2), flush_at: iso(2_000) };
    expect(joins(DEFAULT_BATCHING, open, iso(1_000))).toBe(true);
    expect(joins(DEFAULT_BATCHING, open, iso(2_000))).toBe(false);
    expect(joins({ ...DEFAULT_BATCHING, mode: "commit" }, open, iso(1_000))).toBe(false);
    expect(joins(DEFAULT_BATCHING, { ...batch(10), flush_at: iso(2_000) }, iso(1_000))).toBe(false);
  });
});
