import { afterEach, describe, expect, it, vi } from "vitest";
import { TRIGGER_FAILURES, TRIGGER_WINDOW_MS, systemSource, triggerImprove, triggerImproveKey } from "../src/core/improver.js";
import type { Actor, Run, RunId, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore, NewRun, NewWorkItem } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PROJECT } from "./helpers/fakes.js";

// Issue #514: the failure-count trigger on a fake store (plain maps, no database). The store is the only shared
// state: replicas are two triggerImprove calls on one fake store, with no process memory between them.

const built = vi.hoisted(() => ({ app: null as unknown }));
vi.mock("../src/compose.js", () => ({ build: async () => built.app }));

afterEach(() => {
  built.app = null;
  vi.restoreAllMocks();
});

/**
 * The store calls the improve trigger and `factory improve` make, in memory. enqueueRun is the conditional write:
 * it inserts only when no run has the idempotency key, with no await between the check and the insert, as a
 * unique key does in a real store. Every call is recorded, so tests compare what two callers wrote.
 */
class FakeImproveStore {
  readonly items = new Map<WorkItemId, WorkItem>();
  readonly runs: Run[] = [];
  readonly calls: { method: "createWorkItem" | "enqueueRun"; input: unknown }[] = [];
  constructor(private readonly clock: FakeClock) {}

  async createWorkItem(input: NewWorkItem, _actor: Actor): Promise<{ item: WorkItem; created: boolean }> {
    this.calls.push({ method: "createWorkItem", input });
    await Promise.resolve(); // another replica may run here
    const found = [...this.items.values()].find((i) => i.source.type === input.source.type && i.source.id === input.source.id);
    if (found) return { item: found, created: false };
    const item = { id: `wi_${this.items.size + 1}` as WorkItemId, source: input.source, project: input.project } as WorkItem;
    this.items.set(item.id, item);
    return { item, created: true };
  }

  async enqueueRun(input: NewRun): Promise<{ run: Run; created: boolean }> {
    this.calls.push({ method: "enqueueRun", input });
    await Promise.resolve(); // another replica may run here
    const found = this.runs.find((r) => r.idempotency_key === input.idempotency_key);
    if (found) return { run: found, created: false };
    const run = this.run({ work_item_id: input.work_item_id, kind: input.kind, idempotency_key: input.idempotency_key, input: input.input ?? null });
    return { run, created: true };
  }

  async getWorkItemBySource(type: string, id: string): Promise<WorkItem | null> {
    return [...this.items.values()].find((i) => i.source.type === type && i.source.id === id) ?? null;
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return this.items.get(id) ?? null;
  }

  async listRuns(id: WorkItemId): Promise<Run[]> {
    return this.runs.filter((r) => r.work_item_id === id);
  }

  async listRunsFinishedBetween(start: Timestamp, end: Timestamp): Promise<Run[]> {
    return this.runs.filter((r) => r.finished_at !== null && r.finished_at >= start && r.finished_at < end);
  }

  /** A failed triage run of a new item in PROJECT, finished now. */
  fail(): void {
    const item = { id: `wi_${this.items.size + 1}` as WorkItemId, source: { type: "local", id: `f${this.items.size}`, link: "" }, project: PROJECT.key } as WorkItem;
    this.items.set(item.id, item);
    this.run({
      work_item_id: item.id, kind: "triage", idempotency_key: `t${item.id}`, status: "failed", finished_at: this.clock.now().toISOString() as Timestamp,
      outcome: { status: "failed", error_code: "checks_failed", detail: "x", infra: false },
    });
  }

  private run(r: Partial<Run>): Run {
    const run = { id: `run_${this.runs.length + 1}` as RunId, status: "queued", finished_at: null, outcome: null, created_at: this.clock.now().toISOString(), ...r } as Run;
    this.runs.push(run);
    return run;
  }
}

function world() {
  const clock = new FakeClock("2026-03-04T08:00:00.000Z");
  const store = new FakeImproveStore(clock);
  return { clock, store, d: { store: store as unknown as FactoryStore, clock } };
}

const improveRuns = (store: FakeImproveStore) => store.runs.filter((r) => r.kind === "improve");

describe("improve trigger on a fake store", () => {
  it("two replicas that hit the trigger at the same time create exactly one improve run", async () => {
    const { clock, store, d } = world();
    for (let i = 0; i < TRIGGER_FAILURES; i++) {
      store.fail();
      clock.advance(1_000);
    }
    const [a, b] = await Promise.all([triggerImprove(d, PROJECT.key), triggerImprove(d, PROJECT.key)]);
    // Both replicas found the trigger due and wrote the same key; the store kept one run.
    expect([a?.created, b?.created].sort()).toEqual([false, true]);
    expect(a!.run.id).toBe(b!.run.id);
    expect(improveRuns(store).map((r) => r.idempotency_key)).toEqual([triggerImproveKey(PROJECT.key, null)]);
    expect(store.calls.filter((c) => c.method === "enqueueRun")).toHaveLength(2);
    // The dedupe is the stored run: a third call, a fresh process with nothing in memory, sees it and queues nothing.
    expect(await triggerImprove(d, PROJECT.key)).toBeNull();
    expect(improveRuns(store)).toHaveLength(1);
  });

  it("10 failed runs spread over more than 24 hours queue nothing; the 10th inside 24 hours queues one", async () => {
    const { clock, store, d } = world();
    store.fail();
    clock.advance(TRIGGER_WINDOW_MS + 1);
    for (let i = 0; i < TRIGGER_FAILURES - 1; i++) store.fail();
    clock.advance(1_000);
    expect(await triggerImprove(d, PROJECT.key)).toBeNull();
    store.fail();
    clock.advance(1_000);
    expect(await triggerImprove(d, PROJECT.key)).toMatchObject({ created: true, why: { reason: "count", failures: TRIGGER_FAILURES } });
    expect(improveRuns(store)).toHaveLength(1);
  });
});

describe("factory improve and the trigger share one enqueue path", () => {
  it("both make the same store writes on the project's system work item, through enqueueImprove", async () => {
    const { clock, store, d } = world();
    built.app = { store, clock, project: PROJECT, close: async () => undefined };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const command = (await import("../src/cli/handlers/improve/improve.command.js")).default;
    expect(await command.run([], { name: "improve", usage: "", load: async () => ({}) as never })).toBe(0);
    const manual = store.calls.splice(0);

    for (let i = 0; i < TRIGGER_FAILURES; i++) store.fail();
    clock.advance(1_000);
    // The manual run above is finished, so the trigger may queue one after it.
    improveRuns(store)[0]!.status = "succeeded";
    expect(await triggerImprove(d, PROJECT.key)).toMatchObject({ created: true });
    const triggered = store.calls.splice(0);

    // The same two writes in the same order: the system work item, then one improve run on it.
    expect(manual.map((c) => c.method)).toEqual(["createWorkItem", "enqueueRun"]);
    expect(triggered.map((c) => c.method)).toEqual(manual.map((c) => c.method));
    expect(triggered[0]!.input).toEqual(manual[0]!.input);
    expect((manual[0]!.input as NewWorkItem).source).toEqual(systemSource(PROJECT.key));
    const [m, t] = [manual[1]!.input as NewRun, triggered[1]!.input as NewRun];
    expect(t.work_item_id).toBe(m.work_item_id);
    expect([m.kind, t.kind]).toEqual(["improve", "improve"]);
    expect(m.idempotency_key).toMatch(/:manual:/);
    expect(t.idempotency_key).toBe(triggerImproveKey(PROJECT.key, improveRuns(store)[0]!.id));
    expect(Object.keys(m.input!)).toEqual(Object.keys(t.input!));
  });
});
