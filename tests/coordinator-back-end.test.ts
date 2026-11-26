// The coordinator back end (design 05-coordinator): one cycle against a seeded store with a fake runner and a fake
// clock, the lease, the due time, the switch and the merge gate in code. No test calls a live model: the agent is
// FakeRunner, the sandbox a stub, the clock FakeClock.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COORDINATOR_PROMPT, coordinatorAgent } from "../src/coordinator/agent.js";
import { COORDINATOR_LEASE, CYCLE_MS, Coordinator, type CoordinatorAgent, type CoordinatorPorts, mergeRefusal } from "../src/coordinator/cycle.js";
import { CoordinatorStore } from "../src/coordinator/store.js";
import { StoreLease, syncLeaseOps } from "../src/core/lease.js";
import { SETTABLE_DEFAULTS } from "../src/core/settings.js";
import { awaitingMerge } from "../src/core/request-transition.js";
import type { Tier, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { READ_TOOLS } from "../src/worker/index.js";
import coordinatorSetting from "../src/controller/settings/coordinator.setting.js";
import coordinatorUnit from "../src/controller/units/coordinator/coordinator.unit.js";
import { CoordinatorUnit } from "../src/controller/units/coordinator/coordinator.unit.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const REPO = join(import.meta.dirname, "..");
const LEASE = { lease_ms: 60_000, heartbeat_ms: 10_000 };
const stubSandbox = {
  create: async () => ({ id: "sbx_test", workdir: "/nonexistent" }),
  destroy: async () => undefined,
} as unknown as Sandbox;

/** A waiting item of `tier` from the local source (or GitHub with `github`), seeded through the store's transition. */
async function seed(store: FactoryStore, n: number, tier: Tier, github = false): Promise<WorkItem> {
  const source = github ? issue(n).source : { type: "local", id: `coord-${n}`, link: `local:coord-${n}` };
  const { item } = await store.createWorkItem({ source, title: `item ${n}`, requester_id: "local:me" as UserId, project: PROJECT_KEY, problem: `p${n}`, resources: [] }, system);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_seed", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier } });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

interface Replica {
  coordinator: Coordinator;
  merges: WorkItemId[];
  lease: StoreLease;
}

/** One replica's coordinator over the shared store: the live settings in `live`, the agent `agent`, merges recorded. */
function replica(store: FactoryStore, clock: FakeClock, owner: string, live: { on: boolean; max_tier: number }, agent: CoordinatorAgent): Replica {
  const merges: WorkItemId[] = [];
  const lease = new StoreLease(syncLeaseOps(store, COORDINATOR_LEASE), clock, LEASE, owner);
  const ports: CoordinatorPorts = {
    settings: async () => ({ ...live }),
    waiting: async () => (await store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human" })).filter(awaitingMerge),
    merge: async (id) => {
      merges.push(id);
      return null;
    },
  };
  return { coordinator: new Coordinator({ store: new CoordinatorStore(storeSql(store)), lease, agent, clock, log: silent }, ports), merges, lease };
}

/** The agent: FakeRunner answering `answer` for every waiting item it is shown. */
function fakeAgent(answer: (items: { id: string }[]) => { command: string; work_item_id: string; reason: string }[]) {
  const runner = new FakeRunner({
    triage: async (spec) => {
      const items = JSON.parse(/\[[\s\S]*\]/.exec(spec.prompt)![0]) as { id: string }[];
      return { output: { actions: answer(items) }, transcript: "the coordinator looked at the items" };
    },
  });
  const storage = new MemoryStorage();
  const agent = coordinatorAgent({
    runner, sandbox: stubSandbox, scanner: cleanScanner, storage, tools: READ_TOOLS,
    config: { repo: { path: REPO, base_branch: "main" } as never, deny_paths: [], run_timeout_ms: 60_000 },
    prompt: () => readFile(join(REPO, COORDINATOR_PROMPT), "utf8"),
  });
  return { runner, storage, agent };
}

const mergeAll = (items: { id: string }[]) => items.map((it) => ({ command: "merge", work_item_id: it.id, reason: "ready" }));

describe("coordinator cycle against a seeded factory", () => {
  it("runs one cycle with a fake runner and records each action with outcome, reason and transcript link", async () => {
    const { store, clock } = await newStore();
    const t1 = await seed(store, 1, 1), t2 = await seed(store, 2, 2), t3 = await seed(store, 3, 3), t4 = await seed(store, 4, 4), gh = await seed(store, 5, 1, true);
    const { runner, storage, agent } = fakeAgent(mergeAll);
    const r = replica(store, clock, "a", { on: true, max_tier: 2 }, agent);
    const tick = await r.coordinator.tick();
    expect(tick.kind).toBe("ran");
    if (tick.kind !== "ran") return;
    // The agent ran once, through the runner, with the standing prompt and read-only tools only.
    expect(runner.specs.map((s) => s.role)).toEqual(["triage"]);
    expect(runner.specs[0]!.system_prompt).toBe(await readFile(join(REPO, COORDINATOR_PROMPT), "utf8"));
    expect(runner.specs[0]!.tools.every((t) => t.capability === "read")).toBe(true);
    // Only the local tier 1 and 2 items were merged; the others are refused with the reason, in code.
    expect(r.merges.sort()).toEqual([t1.id, t2.id].sort());
    const rows = await new CoordinatorStore(storeSql(store)).actions(tick.cycle_id);
    const byItem = new Map(rows.map((a) => [a.work_item_id, a]));
    expect(byItem.get(t1.id)).toMatchObject({ command: "merge", outcome: "requested", reason: "ready" });
    expect(byItem.get(t2.id)).toMatchObject({ outcome: "requested" });
    expect(byItem.get(t3.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("tier 3") });
    expect(byItem.get(t4.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("tier 4") });
    expect(byItem.get(gh.id)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("only local items") });
    // Each record carries the transcript link, and the link names the stored transcript.
    const link = rows[0]!.transcript_link!;
    expect(link).toMatch(/^storage:transcripts\/coordinator\//);
    expect(rows.every((a) => a.transcript_link === link && a.recorded_at !== "")).toBe(true);
    expect(new TextDecoder().decode(storage.data.get(link.slice("storage:".length))!)).toContain("looked at the items");
    expect(rows.map((a) => a.seq)).toEqual(rows.map((_, i) => i + 1));
  });

  it("records a failed agent call as one failed action, and skips and unknown commands as such", async () => {
    const { store, clock } = await newStore();
    const t1 = await seed(store, 1, 1);
    const failing: CoordinatorAgent = async () => ({ status: "timed_out", actions: [], transcript_link: null });
    const a = replica(store, clock, "a", { on: true, max_tier: 2 }, failing);
    const first = await a.coordinator.tick();
    if (first.kind !== "ran") throw new Error(first.kind);
    expect(first.actions).toMatchObject([{ command: "cycle", outcome: "failed", reason: expect.stringContaining("timed_out") }]);
    clock.advance(CYCLE_MS);
    const { agent } = fakeAgent(() => [{ command: "skip", work_item_id: t1.id, reason: "wait for the owner" }, { command: "close", work_item_id: t1.id, reason: "x" }]);
    const b = replica(store, clock, "a", { on: true, max_tier: 2 }, agent);
    const second = await b.coordinator.tick();
    if (second.kind !== "ran") throw new Error(second.kind);
    expect(second.actions.map((x) => [x.command, x.outcome])).toEqual([["skip", "skipped"], ["close", "refused"]]);
    expect(b.merges).toEqual([]);
  });
});

describe("one cycle at a time across replicas", () => {
  it("starts no cycle while another replica holds the store lease, and takes over a lease whose holder stopped", async () => {
    const { store, clock } = await newStore();
    await seed(store, 1, 1);
    // Replica A took the lease and stopped without releasing it.
    const stopped = new StoreLease(syncLeaseOps(store, COORDINATOR_LEASE), clock, LEASE, "a");
    expect((await stopped.acquire()).ok).toBe(true);
    const { runner, agent } = fakeAgent(mergeAll);
    const b = replica(store, clock, "b", { on: true, max_tier: 2 }, agent);
    expect(await b.coordinator.tick()).toEqual({ kind: "busy", holder: "a" });
    expect(runner.specs).toEqual([]);
    clock.advance(LEASE.lease_ms + 1);
    expect((await b.coordinator.tick()).kind).toBe("ran");
    expect(runner.specs).toHaveLength(1);
    // B released the lease after its cycle.
    expect(await store.getSyncLease(COORDINATOR_LEASE).then((l) => l === null || l.owner === null || Date.parse(l.expires_at) <= clock.now().getTime())).toBe(true);
  });

  it("two replicas ticking at the same time run one cycle between them", async () => {
    const { store, clock } = await newStore();
    await seed(store, 1, 1);
    const { runner, agent } = fakeAgent(mergeAll);
    const a = replica(store, clock, "a", { on: true, max_tier: 2 }, agent), b = replica(store, clock, "b", { on: true, max_tier: 2 }, agent);
    const results = await Promise.all([a.coordinator.tick(), b.coordinator.tick()]);
    expect(results.filter((r) => r.kind === "ran")).toHaveLength(1);
    expect(runner.specs).toHaveLength(1);
    expect([...a.merges, ...b.merges]).toHaveLength(1);
  });
});

describe("the merge gate is in code", () => {
  const item = (tier: Tier | null, type = "local") => ({ tier, source: { type } }) as WorkItem;

  it("allows only local items of tier 1 or 2 within auto_merge_max_tier", () => {
    expect(mergeRefusal(item(1), 2)).toBeNull();
    expect(mergeRefusal(item(2), 2)).toBeNull();
    expect(mergeRefusal(item(2), 1)).toMatch(/auto_merge_max_tier is 1/);
    expect(mergeRefusal(item(1), 0)).toMatch(/auto_merge_max_tier is 0/);
    expect(mergeRefusal(item(3), 4)).toMatch(/tier 3/);
    expect(mergeRefusal(item(4), 4)).toMatch(/tier 4/);
    expect(mergeRefusal(item(null), 4)).toMatch(/tier unset/);
    expect(mergeRefusal(item(1, "github_issue"), 4)).toMatch(/only local items/);
    expect(mergeRefusal(undefined, 4)).toMatch(/not waiting for a merge/);
  });

  it("refuses a tier 2 item when auto_merge_max_tier is 1, whatever the agent answers", async () => {
    const { store, clock } = await newStore();
    const t1 = await seed(store, 1, 1), t2 = await seed(store, 2, 2);
    const { agent } = fakeAgent(mergeAll);
    const r = replica(store, clock, "a", { on: true, max_tier: 1 }, agent);
    await r.coordinator.tick();
    expect(r.merges).toEqual([t1.id]);
    expect(r.merges).not.toContain(t2.id);
  });

  it("the standing prompt names no private or absolute path", async () => {
    const text = await readFile(join(REPO, COORDINATOR_PROMPT), "utf8");
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\|~\//);
  });
});

describe("the switch and the cadence", () => {
  it("the coordinator setting is a boolean, off by default, read at each tick", async () => {
    expect(coordinatorSetting).toMatchObject({ key: "coordinator", type: "boolean", default: false, changed_by: "runtime" });
    expect(SETTABLE_DEFAULTS.coordinator).toBe(false);
    const { store, clock } = await newStore();
    await seed(store, 1, 1);
    const { runner, agent } = fakeAgent(mergeAll);
    const live = { on: false, max_tier: 2 };
    const r = replica(store, clock, "a", live, agent);
    expect(await r.coordinator.tick()).toEqual({ kind: "off" });
    live.on = true;
    expect((await r.coordinator.tick()).kind).toBe("ran");
    clock.advance(CYCLE_MS);
    live.on = false;
    expect(await r.coordinator.tick()).toEqual({ kind: "off" });
    live.on = true;
    expect((await r.coordinator.tick()).kind).toBe("ran");
    expect(runner.specs).toHaveLength(2);
  });

  it("a cycle is due every 15 minutes on the clock, and the stored due time is the same for every replica", async () => {
    expect(CYCLE_MS).toBe(15 * 60_000);
    const { store, clock } = await newStore();
    const { runner, agent } = fakeAgent(mergeAll);
    const a = replica(store, clock, "a", { on: true, max_tier: 2 }, agent), b = replica(store, clock, "b", { on: true, max_tier: 2 }, agent);
    const start = clock.now().getTime();
    expect((await a.coordinator.tick()).kind).toBe("ran");
    const due = new Date(start + CYCLE_MS).toISOString();
    expect(await new CoordinatorStore(storeSql(store)).dueAt()).toBe(due);
    expect(await b.coordinator.tick()).toEqual({ kind: "not_due", due_at: due });
    clock.advance(CYCLE_MS - 1);
    expect(await a.coordinator.tick()).toEqual({ kind: "not_due", due_at: due });
    clock.advance(1);
    expect((await b.coordinator.tick()).kind).toBe("ran");
    expect(runner.specs).toHaveLength(2);
  });
});

describe("the action table", () => {
  it("the migration creates controller_coordinator_actions with its columns", async () => {
    const { store } = await newStore();
    const cols = await storeSql(store).all("SELECT name FROM pragma_table_info('controller_coordinator_actions')");
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["cycle_id", "seq", "work_item_id", "command", "outcome", "reason", "transcript_link", "recorded_at"]));
  });
});

describe("the coordinator unit", () => {
  it("binds the live settings, the waiting items and the local merge under the service passport", async () => {
    let ports: CoordinatorPorts | null = null;
    const values = { coordinator: false, auto_merge_max_tier: 2 };
    const merged: string[] = [];
    const waitingItem = { id: "wi_1", stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", project: PROJECT_KEY } as WorkItem;
    const other = { ...waitingItem, id: "wi_2", blocked_reason: "spec_pending" } as WorkItem;
    const ctx = {
      k: {
        d: { coordinator: (p: CoordinatorPorts) => ((ports = p), { tick: async () => ({ kind: "off" as const }) }) },
        live: { values: () => values },
        reader: { listWorkItemsWhere: async () => [waitingItem, other], getWorkItem: async (id: string) => (id === "wi_1" ? waitingItem : null) },
      },
      unit: (name: string) => name === "auth"
        ? { automatic: async () => null }
        : { mergeLocal: async (id: string, who: unknown) => (merged.push(`${id}:${JSON.stringify(who)}`), null) },
    };
    const u = coordinatorUnit.create(ctx as never) as CoordinatorUnit;
    await u.step();
    expect(ports).not.toBeNull();
    const p = ports as unknown as CoordinatorPorts;
    expect(await p.settings()).toEqual({ on: false, max_tier: 2 });
    values.coordinator = true;
    expect(await p.settings()).toEqual({ on: true, max_tier: 2 });
    expect((await p.waiting()).map((it) => it.id)).toEqual(["wi_1"]);
    expect(await p.merge("wi_1" as WorkItemId, "k")).toBeNull();
    expect(merged).toEqual(['wi_1:{"auto":true}']);
    expect(await p.merge("wi_9" as WorkItemId, "k")).toMatch(/not found/);
    expect(coordinatorUnit.steps?.map((s) => s.name)).toContain("coordinator");
  });
});
