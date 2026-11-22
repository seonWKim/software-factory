import { describe, expect, it } from "vitest";
import migration from "../src/worker/migrations/20261122T1200-worker-cancel-closed-item-runs.migration.js";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import type { MigrationDb } from "../src/state/index.js";
import { issue, newStore, system } from "./helpers/store.js";

// One-off repair (design 05-restarts, 2026-11-22): a queued run left on a CLOSED item, as a takeover's retry was after a
// merge, is cancelled so no worker claims it; open items' runs and finished runs are untouched; safe to rerun.

const W = "h1:100:1" as WorkerId;
const mdb = (store: SqlFactoryStore): MigrationDb => ({ dialect: "sqlite", all: (q, p) => store.db.all(q, p), run: (q, p) => store.db.run(q, p) });

/** Closes the item the way rows from before the fix look: the stage written with its queued runs left in place. */
const closeLeavingRuns = (store: SqlFactoryStore, id: WorkItemId) =>
  store.db.run("UPDATE controller_work_items SET stage = 'CLOSED', close_reason = 'completed' WHERE id = ?", [id]);

describe("20261122T1200-worker-cancel-closed-item-runs", () => {
  it("cancels a closed item's queued runs, a paused one's attempt too, leaves the rest, and is safe to rerun", async () => {
    const { store } = await newStore();
    const { item: closed } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i1:a1" } });
    const { item: other } = await store.createWorkItem(issue(2), system, { enqueue: { kind: "implement", idempotency_key: "i2" } });
    const claimed = (await store.claimRun({ worker_id: W, kinds: ["implement"], lease_ms: 60_000 }))!;
    expect(claimed.work_item_id).toBe(closed.id); // claimed then paused: queued again with a paused attempt record
    expect((await store.pauseRun(claimed.id, claimed.lease!.token, { paused_by: "github:1", session_id: null, resume: null })).ok).toBe(true);
    const { item: open } = await store.createWorkItem(issue(3), system, { enqueue: { kind: "implement", idempotency_key: "i3" } });
    await closeLeavingRuns(store, closed.id);
    await closeLeavingRuns(store, other.id);
    const [stale1] = await store.listRuns(closed.id);
    const [stale2] = await store.listRuns(other.id);
    expect([stale1!.status, stale2!.status]).toEqual(["queued", "queued"]);

    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(store));
    for (const run of [stale1!, stale2!]) {
      expect(await store.getRun(run.id)).toMatchObject({ status: "cancelled", acknowledged_at: null, lease: null });
    }
    expect((await store.listRunAttempts(closed.id)).map((a) => a.status)).toEqual(["cancelled"]);
    expect((await store.listRuns(open.id)).map((r) => r.status)).toEqual(["queued"]);
    expect((await store.claimRun({ worker_id: W, kinds: ["implement"], lease_ms: 60_000 }))!.work_item_id).toBe(open.id);

    const before = JSON.stringify(await store.db.all("SELECT * FROM worker_runs ORDER BY id"));
    await migration.up(mdb(store));
    expect(JSON.stringify(await store.db.all("SELECT * FROM worker_runs ORDER BY id"))).toBe(before);
  });
});
