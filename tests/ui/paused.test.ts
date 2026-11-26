import { describe, expect, it } from "vitest";
import type { WorkerId } from "../../src/core/types.js";
import { api } from "../../src/ui/api.js";
import { readApi } from "../../src/ui/read-routes.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { type PriorityInput, badgesOf, levelOf } from "../../src/ui/priority.js";
import { cleanScanner } from "../helpers/fakes/config.js";
import { issue, newStore, system } from "../helpers/store.js";

// Design §5 Pause: the dashboard shows a paused run as queued, never as stuck, however long it waits. Read
// through the JSON API without a server.

const LEASE = 60_000;
const BY = "github:42";

type Row = { id: string; item_phase: string; run: { kind: string; status: string } | null };

async function rows(deps: Parameters<typeof api>[0]): Promise<Row[]> {
  const r = await readApi(deps, new URL("http://127.0.0.1/api/v1/items"), { method: "GET", url: "/api/v1/items", host: "127.0.0.1" });
  expect(r.status).toBe(200);
  return (r.value as { items: Row[] }).items;
}

describe("dashboard: paused runs", () => {
  it("a paused run's item is queued, its run waits in the queue, and it is never stuck", async () => {
    const { store, clock } = await newStore();
    const { item } = await store.createWorkItem({ ...issue(1), title: "Pause me" }, system, {
      enqueue: { kind: "implement", idempotency_key: "i" },
    });
    await store.transition({ id: item.id, expected_version: item.version, patch: { stage: "RUNNING" }, actor: system, reason: "seed" });
    const worker = "hostA:1:0" as WorkerId;
    const run = (await store.claimRun({ worker_id: worker, kinds: ["implement"], lease_ms: LEASE }))!;
    await store.pauseWorkers({ count: 1 }, BY);
    const resume = { host: "hostA", folder: "sbx_1", base_sha: null, start_sha: "a", head: "b", bundle: null };
    await store.pauseRun(run.id, run.lease!.token, { paused_by: BY, session_id: null, resume });
    // Long past any lease: a running run this old would be stuck.
    clock.advance(10 * LEASE);

    const deps = {
      store, scanner: cleanScanner, clock, lease_ms: LEASE,
      health: new HealthMonitor(async () => [], clock),
    };
    const [row] = await rows(deps);
    expect(row).toMatchObject({ id: item.id, item_phase: "queued", run: { kind: "implement", status: "queued" } });
    const queue = (await api(deps, new URL("http://127.0.0.1/api/v1/queue"))).value as { queue: { id: string }[] };
    expect(queue.queue.map((q) => q.id)).toEqual([run.id]);

    // Resumed and claimed again: running, still not stuck.
    await store.resumeWorkers();
    await store.claimRun({ worker_id: worker, kinds: ["implement"], lease_ms: LEASE });
    expect((await rows(deps))[0]).toMatchObject({ item_phase: "running", run: { status: "running" } });
  });

  it("ranking: a paused queued run is queued with a `paused` badge, never stuck", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    const input: PriorityInput = {
      stage: "RUNNING", blocked_on: "none", blocked_reason: null, close_reason: null, tier: 2,
      since: "2026-10-01T00:00:00.000Z", dependents: 0, waiting_on: 0,
      run: { kind: "review", status: "queued", heartbeat_at: "2026-10-01T00:00:00.000Z", paused_at: "2026-10-01T00:00:00.000Z" },
    };
    expect(levelOf(input, now, LEASE)).toBe("queued");
    expect(badgesOf(input, "queued", now, LEASE)).toEqual(["paused review"]);
  });
});
