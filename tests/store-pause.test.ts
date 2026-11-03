import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResume, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
// The pause part of the FactoryStore contract (design §5 Pause), on every backend. MySQL joins when
// SF_TEST_MYSQL_URL is set (see helpers/store.ts).
import { BACKENDS, issue, system } from "./helpers/store.js";

const LEASE = 60_000;
const BY = "github:1";
const RESUME: RunResume = { host: "h1", folder: "sbx_1", base_sha: "base", start_sha: "s0", head: "h9", bundle: "bundles/x" };
const wid = (n: number) => `h1:100:${n}` as WorkerId;

/** Five implement runs of five items, claimed by workers 0..4 in that order, one ms apart. */
async function fiveRunning(store: FactoryStore, clock: FakeClock) {
  for (let i = 0; i < 5; i++) {
    await store.createWorkItem(issue(i + 1), system, { enqueue: { kind: "implement", idempotency_key: `k${i}` } });
  }
  const runs = [];
  for (let i = 0; i < 5; i++) {
    clock.advance(1);
    runs.push((await store.claimRun({ worker_id: wid(i), kinds: ["implement"], lease_ms: LEASE }))!);
  }
  return runs;
}

describe.each(BACKENDS)("FactoryStore contract, pause: $name", ({ make }) => {
  it("pause <n> pauses the n workers whose runs started most recently, and only those", async () => {
    const { store, clock } = await make();
    await fiveRunning(store, clock);
    const r = await store.pauseWorkers({ count: 2 }, BY);
    expect(r.paused).toEqual([wid(4), wid(3)]);
    expect(await store.workerPause(wid(4))).toMatchObject({ worker_id: wid(4), paused_by: BY });
    expect(await store.workerPause(wid(3))).toMatchObject({ worker_id: wid(3), paused_by: BY });
    for (const i of [0, 1, 2]) expect(await store.workerPause(wid(i))).toBeNull();
    // A second pause takes the next ones, never one already paused.
    expect((await store.pauseWorkers({ count: 1 }, BY)).paused).toEqual([wid(2)]);
  });

  it("a paused worker's claim returns no run; the others still claim", async () => {
    const { store } = await make();
    await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    await store.createWorkItem(issue(2), system, { enqueue: { kind: "implement", idempotency_key: "i1" } });
    const busy = (await store.claimRun({ worker_id: wid(0), kinds: ["triage"], lease_ms: LEASE }))!;
    expect(busy.lease?.owner).toBe(wid(0));
    expect((await store.pauseWorkers({ count: 1 }, BY)).paused).toEqual([wid(0)]);
    expect(await store.claimRun({ worker_id: wid(0), kinds: ["implement"], lease_ms: LEASE })).toBeNull();
    expect(await store.claimRun({ worker_id: wid(1), kinds: ["implement"], lease_ms: LEASE })).not.toBeNull();
  });

  it("pause --all stops every claim, idle loops included, until resume clears every pause", async () => {
    const { store } = await make();
    await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    expect((await store.pauseWorkers({ all: true }, BY)).paused).toEqual(["*"]);
    expect(await store.workerPause(wid(7))).toMatchObject({ worker_id: "*", paused_by: BY });
    for (const i of [0, 1, 7]) expect(await store.claimRun({ worker_id: wid(i), kinds: ["triage"], lease_ms: LEASE })).toBeNull();
    expect((await store.listWorkerPauses()).map((p) => p.worker_id)).toEqual(["*"]);
    expect(await store.resumeWorkers()).toEqual({ cleared: 1 });
    expect(await store.listWorkerPauses()).toEqual([]);
    expect(await store.claimRun({ worker_id: wid(7), kinds: ["triage"], lease_ms: LEASE })).not.toBeNull();
  });

  it("pauseRun puts the run back in queued with paused_at, keeping attempt; the resuming claim adds nothing to it", async () => {
    const { store, clock } = await make();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i" } });
    const run = (await store.claimRun({ worker_id: wid(0), kinds: ["implement"], lease_ms: LEASE }))!;
    expect(run.attempt).toBe(1);
    clock.advance(5);
    const r = await store.pauseRun(run.id, run.lease!.token, { paused_by: BY, session_id: "sess-1", resume: RESUME });
    expect(r.ok).toBe(true);
    const paused = (await store.getRun(run.id))!;
    expect(paused).toMatchObject({
      status: "queued", attempt: 1, lease: null, outcome: null, acknowledged_at: null, finished_at: null,
      paused_at: clock.now().toISOString(), paused_by: BY, session_id: "sess-1", resume: RESUME,
    });
    // Not finished: nothing for the controller to acknowledge, and the item is untouched.
    expect(await store.listUnacknowledgedRuns(10)).toEqual([]);
    expect((await store.getWorkItem(item.id))!.version).toBe(item.version);
    // The old token is fenced off.
    expect(await store.heartbeat(run.id, run.lease!.token, LEASE)).toEqual({ ok: false, reason: "lease_lost" });
    expect(await store.pauseRun(run.id, run.lease!.token, { paused_by: BY, session_id: null, resume: RESUME })).toEqual({ ok: false, reason: "lease_lost" });

    const again = (await store.claimRun({ worker_id: wid(1), kinds: ["implement"], lease_ms: LEASE }))!;
    expect(again).toMatchObject({ id: run.id, status: "running", attempt: 1, paused_at: null, paused_by: null, session_id: "sess-1", resume: RESUME });
    expect(again.lease!.token).toBe(run.lease!.token + 1);
    // A later ordinary reclaim (after the reaper) counts again.
    clock.advance(LEASE + 1);
    await store.expireLeases(3);
    expect((await store.claimRun({ worker_id: wid(1), kinds: ["implement"], lease_ms: LEASE }))!.attempt).toBe(2);
  });

  it("new run columns are null on runs that were never paused", async () => {
    const { store } = await make();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    expect((await store.listRuns(item.id))[0]).toMatchObject({ paused_at: null, paused_by: null, session_id: null, resume: null });
  });
});

describe("pause survives a store reopen (SQLite file)", () => {
  it("paused workers stay paused and the paused run stays paused until workers resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-pause-"));
    try {
      const file = join(dir, "factory.db");
      const clock = new FakeClock();
      const open = async () => {
        const s = new SqlFactoryStore(new SqliteDriver(file), clock);
        await s.migrate();
        return s;
      };
      let store = await open();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i" } });
      const run = (await store.claimRun({ worker_id: wid(0), kinds: ["implement"], lease_ms: LEASE }))!;
      await store.pauseWorkers({ count: 1 }, BY);
      await store.pauseWorkers({ all: true }, BY);
      await store.pauseRun(run.id, run.lease!.token, { paused_by: BY, session_id: "s", resume: RESUME });
      await store.close();

      store = await open();
      expect((await store.listWorkerPauses()).map((p) => p.worker_id).sort()).toEqual(["*", wid(0)].sort());
      expect((await store.listRuns(item.id))[0]).toMatchObject({ status: "queued", paused_by: BY });
      expect(await store.claimRun({ worker_id: wid(0), kinds: ["implement"], lease_ms: LEASE })).toBeNull();
      expect(await store.claimRun({ worker_id: wid(1), kinds: ["implement"], lease_ms: LEASE })).toBeNull();
      await store.resumeWorkers();
      await store.close();

      store = await open();
      expect(await store.claimRun({ worker_id: wid(0), kinds: ["implement"], lease_ms: LEASE })).toMatchObject({ id: run.id, attempt: 1 });
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
