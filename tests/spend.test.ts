import { describe, expect, it } from "vitest";
import { SPEND_KINDS, readSpend, spendTotals } from "../src/core/spend.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { respond } from "../src/ui/server.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Spend (design 06-spend) counts a routine's runs: `routine` is one of SPEND_KINDS, so a routine run's harness cost
// adds to the day's and the item's totals, and one with no cost is counted apart as unknown.

describe("spend counts routine runs", () => {
  it("SPEND_KINDS has routine, and a finished routine run adds its cost and tokens", async () => {
    expect(SPEND_KINDS).toContain("routine");
    const clock = new FakeClock("2026-11-23T09:00:00.000Z");
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    for (const [key, cost_usd] of [["r1", 0.25], ["r2", null]] as const) {
      await store.enqueueRun({ work_item_id: item.id, kind: "routine", idempotency_key: key, input: { routine: { instruction: "x", url: null } } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
      const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null };
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { routine: { verdict: "pass", findings: [], summary: "s" }, usage } });
      clock.advance(60_000);
    }
    const runs = (await store.listRuns(item.id)).filter((r) => r.kind === "routine");
    expect(spendTotals(runs)).toMatchObject({ cost_usd: 0.25, runs: 2, unknown: 1 });
    const spend = await readSpend(store, "2026-11-23", "2026-11-23");
    expect(spend.items).toEqual([expect.objectContaining({ work_item_id: item.id, kinds: ["routine"], cost_usd: 0.25, runs: 2, unknown: 1 })]);
    expect(spend.days[0]).toMatchObject({ day: "2026-11-23", cost_usd: 0.25 });
  });
});

// Chat turns (design 04-chat-agent) are no runs: their stored spend rows are totalled apart, under `chat`.
describe("spend counts chat turns apart", () => {
  it("readSpend and GET /api/v1/spend answer a chat total of the range's turns, unknown cost apart, and leave the run totals alone", async () => {
    const clock = new FakeClock("2026-11-26T09:00:00.000Z");
    const { store } = await newStore(clock);
    await store.recordChatSpend({ turn_id: "t1", session_id: "s1", day: "2026-11-25", cost_usd: 0.5, tokens: 100 });
    await store.recordChatSpend({ turn_id: "t2", session_id: "s1", day: "2026-11-26", cost_usd: 0.25, tokens: 40 });
    await store.recordChatSpend({ turn_id: "t3", session_id: "s2", day: "2026-11-26", cost_usd: null, tokens: 7 });
    await store.recordChatSpend({ turn_id: "t4", session_id: "s3", day: "2026-11-27", cost_usd: 9, tokens: 1 });

    const spend = await readSpend(store, "2026-11-25", "2026-11-26");
    expect(spend.chat).toEqual({ cost_usd: 0.75, tokens: 147, turns: 3, unknown: 1 });
    expect(spend.total).toEqual({ cost_usd: 0, tokens: 0, runs: 0, unknown: 0 });

    const d = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
    const r = await respond(d, { method: "GET", url: "/api/v1/spend?from=2026-11-26&to=2026-11-26", host: "127.0.0.1:4310" });
    expect(r.status).toBe(200);
    expect((JSON.parse(r.body!) as { chat: unknown }).chat).toEqual({ cost_usd: 0.25, tokens: 47, turns: 2, unknown: 1 });
  });
});

// Coordinator cycles (design 06-spend) store one spend row each in controller_chat_spend with kind `coordinator`:
// totalled apart, under `coordinator`, never added to the run totals or to `chat`.
describe("spend counts coordinator cycles apart", () => {
  const coordinatorRow = (turn: string, day: string, cost: number | null, tokens: number) =>
    `INSERT INTO controller_chat_spend (turn_id, session_id, day, cost_usd, tokens, created_at, kind) VALUES ('${turn}', 'coordinator', '${day}', ${cost === null ? "NULL" : cost}, ${tokens}, '${day}T09:00:00.000Z', 'coordinator')`;

  it("readSpend and GET /api/v1/spend answer a coordinator total of the range's cycles, unknown cost apart, and leave chat and runs alone", async () => {
    const clock = new FakeClock("2026-11-26T09:00:00.000Z");
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    await store.enqueueRun({ work_item_id: item.id, kind: "routine", idempotency_key: "r1", input: { routine: { instruction: "x", url: null } } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1, model: null };
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { routine: { verdict: "pass", findings: [], summary: "s" }, usage } });
    await store.recordChatSpend({ turn_id: "t1", session_id: "s1", day: "2026-11-26", cost_usd: 0.5, tokens: 100 });
    await store.db.run(coordinatorRow("c1", "2026-11-25", 1.5, 300));
    await store.db.run(coordinatorRow("c2", "2026-11-26", 0.25, 50));
    await store.db.run(coordinatorRow("c3", "2026-11-26", null, 9));
    await store.db.run(coordinatorRow("c4", "2026-11-27", 9, 1));

    const before = await readSpend(store, "2026-11-25", "2026-11-26");
    expect(before.coordinator).toEqual({ cost_usd: 1.75, tokens: 359, turns: 3, unknown: 1 });
    expect(before.chat).toEqual({ cost_usd: 0.5, tokens: 100, turns: 1, unknown: 0 });
    expect(before.total).toMatchObject({ cost_usd: 0.1, runs: 1, unknown: 0 });
    expect(before.days.map((d) => d.cost_usd)).toEqual([0, 0.1]);
    expect(before.items).toEqual([expect.objectContaining({ work_item_id: item.id, cost_usd: 0.1, runs: 1 })]);

    const d = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
    const r = await respond(d, { method: "GET", url: "/api/v1/spend?from=2026-11-26&to=2026-11-26", host: "127.0.0.1:4310" });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body!) as { coordinator: unknown; chat: unknown; total: unknown };
    expect(body.coordinator).toEqual({ cost_usd: 0.25, tokens: 59, turns: 2, unknown: 1 });
    expect(body.chat).toEqual({ cost_usd: 0.5, tokens: 100, turns: 1, unknown: 0 });
    expect(body.total).toEqual(before.total);
  });

  it("the store's spend-list read takes a kind, chat by default", async () => {
    const { store } = await newStore();
    await store.recordChatSpend({ turn_id: "t1", session_id: "s1", day: "2026-11-26", cost_usd: 0.5, tokens: 100 });
    await store.db.run(coordinatorRow("c1", "2026-11-26", null, 9));
    expect((await store.listChatSpendBetween("2026-11-26", "2026-11-26")).map((s) => s.turn_id)).toEqual(["t1"]);
    expect((await store.listChatSpendBetween("2026-11-26", "2026-11-26", "chat")).map((s) => s.turn_id)).toEqual(["t1"]);
    expect(await store.listChatSpendBetween("2026-11-26", "2026-11-26", "coordinator")).toEqual([
      { turn_id: "c1", session_id: "coordinator", day: "2026-11-26", cost_usd: null, tokens: 9 },
    ]);
  });
});
