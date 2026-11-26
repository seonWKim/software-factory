// The coordinator cycle's gates (design 05-coordinator, 06-spend): no agent call when no item waits for a merge, none
// at the UTC-day limit (with one owner question per UTC day), and the common /approve <usd> and /reject answering
// that question. The agent is a scripted double with a cost, the clock a FakeClock: no live model.

import { describe, expect, it } from "vitest";
import { answerCoordinatorLimit, coordinatorLimitKey } from "../src/core/alarms.js";
import type { CoordinatorPorts } from "../src/core/controller-deps.js";
import { COORDINATOR_LEASE, CYCLE, CYCLE_MS, Coordinator, type CoordinatorAgent, NOTHING_TO_DO, type TickResult } from "../src/coordinator/cycle.js";
import { CoordinatorStore } from "../src/coordinator/store.js";
import { coordinatorLimitQuestion } from "../src/core/alarms.js";
import { StoreLease, syncLeaseOps } from "../src/core/lease.js";
import { awaitingMerge } from "../src/core/request-transition.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { cleanScanner, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

const KEY = "spend.coordinator_daily_usd";
const OWNER = "local:me" as UserId;
const DAY_MS = 24 * 3_600_000;

/** A local tier 1 item waiting for a merge. */
async function seedWaiting(store: FactoryStore): Promise<void> {
  const { item } = await store.createWorkItem({ source: { type: "local", id: "coord-1", link: "local:coord-1" }, title: "item", requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_seed", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 1 } });
  if (!r.ok) throw new Error(r.reason);
}

/**
 * A coordinator over `store` whose agent costs `cost` per call and proposes nothing. The daily limit is read from the
 * stored setting override (default 5), as the controller's live settings read it; the question goes through the store.
 */
function coordinator(store: FactoryStore, clock: FakeClock, cost = 3) {
  const calls: string[] = [];
  const agent: CoordinatorAgent = async ({ cycle_id }) => (calls.push(cycle_id), { status: "completed", actions: [], transcript_link: null, cost_usd: cost, tokens: 100 });
  const ports: CoordinatorPorts = {
    settings: async () => {
      const o = (await store.listSettingOverrides()).find((x) => x.key === KEY && x.project === "");
      return { on: true, max_tier: 2, daily_usd: o ? (JSON.parse(o.value) as number) : 5 };
    },
    waiting: async () => (await store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: 50 })).filter(awaitingMerge),
    merge: async () => null,
    activity: async () => undefined,
    limitReached: async (q) => void (await coordinatorLimitQuestion({ store, scanner: cleanScanner, log: silent }, q)),
  };
  const lease = new StoreLease(syncLeaseOps(store, COORDINATOR_LEASE), clock, { lease_ms: 60_000, heartbeat_ms: 10_000 }, "a");
  const c = new Coordinator({ store: new CoordinatorStore(storeSql(store)), lease, agent, clock, log: silent }, ports);
  /** The next due cycle: moves the clock on by one cycle first (except the first). */
  let first = true;
  const next = async (): Promise<Extract<TickResult, { kind: "ran" }>> => {
    if (!first) clock.advance(CYCLE_MS);
    first = false;
    const t = await c.tick();
    if (t.kind !== "ran") throw new Error(t.kind);
    return t;
  };
  return { calls, next };
}

const limitAlerts = async (store: FactoryStore) => (await store.listAlerts({ limit: 100 })).filter((a) => a.pattern === "coordinator_limit");
const answer = (store: FactoryStore, command: "approve" | "reject", value: string | null = null, owner = true) =>
  answerCoordinatorLimit(store, { command, value, by: OWNER, isOwner: async () => owner });

/** Runs cycles at $3 each until the $5 limit stops one: two calls ($6), then the stopped cycle. */
async function reachLimit(store: FactoryStore, clock: FakeClock) {
  await seedWaiting(store);
  const c = coordinator(store, clock);
  await c.next();
  await c.next();
  expect(c.calls).toHaveLength(2);
  const stopped = await c.next();
  return { ...c, stopped };
}

describe("the nothing-to-do gate", () => {
  it("a due cycle with no item waiting for a merge calls no agent, stores one skipped row and moves its due time", async () => {
    const { store, clock } = await newStore();
    const c = coordinator(store, clock);
    const start = clock.now().getTime();
    const t = await c.next();
    expect(c.calls).toEqual([]);
    expect(t.actions).toMatchObject([{ command: CYCLE, outcome: "skipped", work_item_id: null, reason: NOTHING_TO_DO }]);
    expect(NOTHING_TO_DO).toContain("nothing to do");
    const coord = new CoordinatorStore(storeSql(store));
    expect(await coord.actions(t.cycle_id)).toMatchObject([{ command: CYCLE, outcome: "skipped", reason: NOTHING_TO_DO }]);
    expect(await coord.dueAt()).toBe(new Date(start + CYCLE_MS).toISOString());
    // No agent call stores no spend.
    expect((await coord.spendOn("2026-01-01")).cycles).toBe(0);
    // The next due cycle with an item waiting calls the agent.
    await seedWaiting(store);
    await c.next();
    expect(c.calls).toHaveLength(1);
  });
});

describe("the UTC-day limit", () => {
  it("at the limit the next due cycle calls no agent and stores one skipped row naming the limit", async () => {
    const { store, clock } = await newStore();
    const { calls, stopped, next } = await reachLimit(store, clock);
    expect(calls).toHaveLength(2);
    expect(stopped.actions).toHaveLength(1);
    expect(stopped.actions[0]).toMatchObject({ command: CYCLE, outcome: "skipped", work_item_id: null });
    expect(stopped.actions[0]!.reason).toContain("daily limit");
    expect(stopped.actions[0]!.reason).toContain(`${KEY} $5.00`);
    await next();
    expect(calls).toHaveLength(2);
  });

  it("stores exactly one Needs-you question per UTC day, with the current and the proposed limit", async () => {
    const { store, clock } = await newStore();
    const { next } = await reachLimit(store, clock);
    await next();
    await next();
    const alerts = await limitAlerts(store);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.pattern_key).toBe(coordinatorLimitKey("2026-01-01"));
    expect(alerts[0]!.detail).toContain("Current limit $5.00");
    expect(alerts[0]!.detail).toContain("proposed limit $10.00");
    expect(alerts[0]!.detail).toContain("approve 10");
  });
});

describe("answering the question with the common /approve and /reject", () => {
  it("/approve 10 sets spend.coordinator_daily_usd to 10, and cycles run again while today's spend is below it", async () => {
    const { store, clock } = await newStore();
    const { calls, next } = await reachLimit(store, clock);
    const r = await answer(store, "approve", "10");
    expect(r).toMatchObject({ set_usd: 10 });
    const override = (await store.listSettingOverrides()).find((o) => o.key === KEY);
    expect(override).toMatchObject({ project: "", value: "10", set_by: OWNER });
    // The answer is on the alert: it is dismissed by the owner, so it leaves Needs you.
    expect((await limitAlerts(store))[0]!.dismissed_at).toBeDefined();
    // $6 spent is below $10: the next cycle calls the agent ($9), and the one after that too ($12), then it stops.
    await next();
    expect(calls).toHaveLength(3);
    await next();
    expect(calls).toHaveLength(4);
    const stopped = await next();
    expect(calls).toHaveLength(4);
    expect(stopped.actions[0]!.reason).toContain(`${KEY} $10.00`);
    // Still one question that day: the answered one is not asked again.
    expect(await limitAlerts(store)).toHaveLength(1);
  });

  it("/approve needs a positive amount and the owner; a refusal sets nothing", async () => {
    const { store, clock } = await newStore();
    await reachLimit(store, clock);
    for (const v of [null, "0", "-3", "ten"]) expect(await answer(store, "approve", v)).toMatchObject({ refused: expect.stringContaining("positive dollar amount") });
    expect(await answer(store, "approve", "10", false)).toMatchObject({ refused: expect.stringContaining("only the owner") });
    expect((await store.listSettingOverrides()).find((o) => o.key === KEY)).toBeUndefined();
    expect((await limitAlerts(store))[0]!.dismissed_at).toBeUndefined();
  });

  it("/reject keeps cycles stopped for the rest of the UTC day and leaves spend.coordinator_daily_usd unchanged", async () => {
    const { store, clock } = await newStore();
    const { calls, next } = await reachLimit(store, clock);
    const r = await answer(store, "reject");
    expect(r).toMatchObject({ set_usd: null });
    expect((await store.listSettingOverrides()).find((o) => o.key === KEY)).toBeUndefined();
    expect((await limitAlerts(store))[0]!.dismissed_at).toBeDefined();
    // A second answer finds no open question.
    expect(await answer(store, "approve", "10")).toBeNull();
    // Every due cycle left that UTC day stops; none asks again.
    for (let i = 0; i < 4; i++) expect((await next()).actions[0]).toMatchObject({ command: CYCLE, outcome: "skipped" });
    expect(calls).toHaveLength(2);
    expect(await limitAlerts(store)).toHaveLength(1);
    // The next UTC day starts with no coordinator spend: cycles run again.
    clock.advance(DAY_MS);
    await next();
    expect(calls).toHaveLength(3);
  });
});
