// The coordinator cycle's spend (design 06-spend): each cycle that calls the agent stores exactly one spend row of kind
// `coordinator` in controller_chat_spend (null cost when the call failed or reported none) and one `coordinator`
// Activity record whose reason shows the cost. The ports are the coordinator unit's own, bound to a real store; the
// agent is a scripted double, the clock a FakeClock: no live model.

import { describe, expect, it } from "vitest";
import type { CoordinatorPorts } from "../src/core/controller-deps.js";
import { COORDINATOR_LEASE, CYCLE_MS, Coordinator, type CoordinatorAgent, costReason } from "../src/coordinator/cycle.js";
import { CoordinatorStore, SPEND_SESSION } from "../src/coordinator/store.js";
import { StoreLease, syncLeaseOps } from "../src/core/lease.js";
import { awaitingMerge } from "../src/core/request-transition.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import coordinatorUnit from "../src/controller/units/coordinator/coordinator.unit.js";
import { cleanScanner, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

async function seedWaiting(store: FactoryStore): Promise<void> {
  const { item } = await store.createWorkItem({ source: { type: "local", id: "spend-1", link: "local:spend-1" }, title: "item", requester_id: "local:me" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_seed", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 1 } });
  if (!r.ok) throw new Error(r.reason);
}

/** The coordinator unit's ports over `store`, as the controller binds them (live settings: on, tier 2, $5 a day). */
async function unitPorts(store: FactoryStore): Promise<CoordinatorPorts> {
  let ports: CoordinatorPorts | null = null;
  const ctx = {
    k: {
      d: { store, scanner: cleanScanner, log: silent, coordinator: (p: CoordinatorPorts) => ((ports = p), { tick: async () => ({ kind: "off" as const }) }) },
      live: { values: () => ({ coordinator: true, auto_merge_max_tier: 2, "spend.coordinator_daily_usd": 5 }) },
      reader: { listWorkItemsWhere: (q: Parameters<FactoryStore["listWorkItemsWhere"]>[0]) => store.listWorkItemsWhere(q), getWorkItem: (id: string) => store.getWorkItem(id as never) },
    },
    unit: () => ({ automatic: async () => null, mergeLocal: async () => null }),
  };
  await (coordinatorUnit.create(ctx as never) as { step(): Promise<unknown> }).step();
  if (ports === null) throw new Error("the unit bound no ports");
  return { ...(ports as CoordinatorPorts), waiting: async () => (await store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", limit: 50 })).filter(awaitingMerge) };
}

async function coordinator(store: FactoryStore, clock: FakeClock, agent: CoordinatorAgent): Promise<Coordinator> {
  const lease = new StoreLease(syncLeaseOps(store, COORDINATOR_LEASE), clock, { lease_ms: 60_000, heartbeat_ms: 10_000 }, "a");
  return new Coordinator({ store: new CoordinatorStore(storeSql(store)), lease, agent, clock, log: silent }, await unitPorts(store));
}

const spendRows = (store: FactoryStore) =>
  storeSql(store).all("SELECT turn_id, session_id, day, cost_usd, tokens, kind FROM controller_chat_spend WHERE kind = 'coordinator'", []);

describe("a cycle's spend row", () => {
  it("a cycle that calls the agent stores exactly one coordinator spend row with its cost", async () => {
    const { store, clock } = await newStore();
    await seedWaiting(store);
    const c = await coordinator(store, clock, async () => ({ status: "completed", actions: [], transcript_link: null, cost_usd: 0.42, tokens: 1200 }));
    const t = await c.tick();
    if (t.kind !== "ran") throw new Error(t.kind);
    expect(await spendRows(store)).toEqual([{ turn_id: t.cycle_id, session_id: SPEND_SESSION, day: "2026-01-01", cost_usd: 0.42, tokens: 1200, kind: "coordinator" }]);
    // A second due cycle adds its own row, still one per cycle.
    clock.advance(CYCLE_MS);
    const t2 = await c.tick();
    if (t2.kind !== "ran") throw new Error(t2.kind);
    const rows = await spendRows(store);
    expect(rows.filter((r) => r.turn_id === t.cycle_id)).toHaveLength(1);
    expect(rows.filter((r) => r.turn_id === t2.cycle_id)).toHaveLength(1);
    expect((await new CoordinatorStore(storeSql(store)).spendOn("2026-01-01")).cost_usd).toBeCloseTo(0.84);
  });

  it("a failed agent call stores its row with a null cost, which adds nothing to the day's spend", async () => {
    const { store, clock } = await newStore();
    await seedWaiting(store);
    const c = await coordinator(store, clock, async () => { throw new Error("runner down"); });
    const t = await c.tick();
    if (t.kind !== "ran") throw new Error(t.kind);
    expect(await spendRows(store)).toMatchObject([{ turn_id: t.cycle_id, cost_usd: null, kind: "coordinator" }]);
    expect(await new CoordinatorStore(storeSql(store)).spendOn("2026-01-01")).toEqual({ cost_usd: 0, cycles: 1, unknown: 1 });
  });

  it("a cycle the gate skips stores no spend row", async () => {
    const { store, clock } = await newStore();
    const c = await coordinator(store, clock, async () => ({ status: "completed", actions: [], transcript_link: null, cost_usd: 1, tokens: 1 }));
    expect((await c.tick()).kind).toBe("ran");
    expect(await spendRows(store)).toEqual([]);
  });
});

describe("a cycle's Activity record", () => {
  it("each cycle that calls the agent stores one coordinator Activity record whose reason shows the cost", async () => {
    const { store, clock } = await newStore();
    await seedWaiting(store);
    const c = await coordinator(store, clock, async () => ({ status: "completed", actions: [], transcript_link: null, cost_usd: 0.42, tokens: 1200 }));
    const t = await c.tick();
    if (t.kind !== "ran") throw new Error(t.kind);
    const rows = await store.listActivity({ kind: "coordinator" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "system:coordinator", kind: "coordinator", subject: t.cycle_id, outcome: "completed" });
    expect(rows[0]!.reason).toContain("$0.42");
    expect(rows[0]!.reason).toContain("$5.00 coordinator daily limit");
  });

  it("a failed call's record says no cost was reported and names the uncounted cycles", async () => {
    const { store, clock } = await newStore();
    await seedWaiting(store);
    const c = await coordinator(store, clock, async () => ({ status: "failed", actions: [], transcript_link: null, cost_usd: null, tokens: 0, error: "boom" }));
    await c.tick();
    const [row] = await store.listActivity({ kind: "coordinator" });
    expect(row!.outcome).toBe("failed");
    expect(row!.reason).toContain("reported no cost");
    expect(row!.reason).toContain("1 cycle with no reported cost not counted");
  });

  it("costReason gives the cost and the day's spend against the limit", () => {
    expect(costReason(1.5, "2026-11-27", 5, { cost_usd: 3, cycles: 2, unknown: 0 })).toBe("the agent call cost $1.50; $3.00 of the $5.00 coordinator daily limit spent (UTC day 2026-11-27)");
  });
});
