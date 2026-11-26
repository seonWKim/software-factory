import { describe, expect, it } from "vitest";
import { autoResolveKey } from "../../src/core/policy.js";
import type { WorkItem } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { readApi } from "../../src/ui/read-routes.js";
import { HealthMonitor } from "../../src/ui/health.js";
import type { UiDeps } from "../../src/ui/deps.js";
import { issue, newStore, system, w1 } from "../helpers/store.js";

// The dashboard shows each item's merge-conflict counts (design §5 Merge conflict, decided 2026-11-02):
// resolved automatically, and needed a person. Read through the JSON API without a server, so no port is opened.

const LEASE = 60_000;

function deps(store: FactoryStore, clock: FakeClock): UiDeps {
  return {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: LEASE,
    health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], clock),
  };
}

/** One run of `kind` under `key`, claimed and completed with `data` (succeeded) or failed. */
async function runOnce(store: FactoryStore, item: WorkItem, kind: "resolve" | "implement", key: string, data: Record<string, unknown> | null) {
  const cur = (await store.getWorkItem(item.id))!;
  const t = await store.transition({ id: item.id, expected_version: cur.version, patch: {}, actor: system, reason: "x", enqueue: { kind, idempotency_key: key } });
  if (!t.ok) throw new Error("enqueue failed");
  const r = (await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, data
    ? { status: "succeeded", summary: "", data }
    : { status: "failed", error_code: "tests_failed", detail: "", infra: false });
}

async function block(store: FactoryStore, item: WorkItem, blocked_reason: string) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason, change_ref: "42" }, actor: system, reason: "x" });
  if (!r.ok) throw new Error("transition failed");
}

async function get(store: FactoryStore, clock: FakeClock, path: string): Promise<unknown> {
  const r = await readApi(deps(store, clock), new URL(`http://127.0.0.1/api/v1${path}`), { method: "GET", url: `/api/v1${path}`, host: "127.0.0.1" });
  expect(r.status).toBe(200);
  return r.value;
}

describe("dashboard: merge-conflict counts per item", () => {
  it("each listed item gives how many conflicts were resolved automatically and how many needed a person", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const a = (await store.createWorkItem(issue(1), system)).item;
    const b = (await store.createWorkItem(issue(2), system)).item;

    // a: one automatic resolve pushed, one implement sync resolved a conflict, a failed automatic attempt,
    // then twice waiting on a person.
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 1), null);
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 2), { result: "pushed", conflicts: ["x.ts"] });
    await runOnce(store, a, "implement", `${a.id}:implement:l0:r0`, { pr_number: 42, conflicts: ["y.ts"] });
    await block(store, a, "merge_conflict_pending");
    await block(store, a, "merge_pending");
    await block(store, a, "merge_conflict_pending");

    const { items } = (await get(store, clock, "/items")) as { items: { id: string; conflicts: unknown }[] };
    const byId = new Map(items.map((r) => [r.id, r.conflicts]));
    expect(byId.get(a.id)).toEqual({ automatic: 2, person: 2 });
    expect(byId.get(b.id)).toEqual({ automatic: 0, person: 0 });
  });

  it("the item's detail gives the same two counts", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const a = (await store.createWorkItem(issue(3), system)).item;
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 1), { result: "pushed", conflicts: ["x.ts"] });
    const { item } = (await get(store, clock, `/items/${a.id}`)) as { item: { conflicts: unknown } };
    expect(item.conflicts).toEqual({ automatic: 1, person: 0 });
  });
});
