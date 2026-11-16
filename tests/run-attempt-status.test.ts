// A run's status in worker_runs and its latest attempt record in worker_run_attempts always agree once the run
// is finished: the finish paths close the current attempt in the same transaction, doctor flags any run where
// they disagree, and a one-off migration repairs rows written before.
import { describe, expect, it } from "vitest";
import type { RunId, WorkerId, WorkItemId } from "../src/core/types.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { checkLine } from "../src/setup.js";
import { runAttemptChecks, storeRunAttemptChecks } from "../src/worker/migrations/run-attempt-status.js";
import { discoverMigrations, type MigrationDb } from "../src/state/index.js";
import { issue, newStore, system } from "./helpers/store.js";

const LEASE = 60_000;
const W = "h1:100:1" as WorkerId;
const DONE = { status: "succeeded", summary: "done", data: {} } as const;
const MIGRATION = "20261116T1210-worker-run-attempt-status";

async function pausedRun(store: SqlFactoryStore, n = 1) {
  const { item } = await store.createWorkItem(issue(n), system, { enqueue: { kind: "implement", idempotency_key: `i${n}` } });
  const run = (await store.claimRun({ worker_id: W, kinds: ["implement"], lease_ms: LEASE }))!;
  const r = await store.pauseRun(run.id, run.lease!.token, { paused_by: "github:1", session_id: null, resume: null });
  expect(r.ok).toBe(true);
  return { item: item!, run };
}

async function latestAttempt(store: SqlFactoryStore, itemId: WorkItemId, runId: RunId) {
  const attempts = (await store.listRunAttempts(itemId)).filter((a) => a.run_id === runId);
  return { attempts, latest: attempts.reduce((a, b) => (b.attempt > a.attempt ? b : a)) };
}

/** Writes a mismatch the way the reported run looks: the run succeeded, its latest attempt still says paused. */
async function seedMismatch(store: SqlFactoryStore, n: number): Promise<RunId> {
  const { run } = await pausedRun(store, n);
  await store.db.run("UPDATE worker_runs SET status = 'succeeded', finished_at = updated_at WHERE id = ?", [run.id]);
  return run.id;
}

function mdb(store: SqlFactoryStore): MigrationDb {
  return { dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
}

describe("finishing a paused run", () => {
  it("resumed with a new claim and completed: the run and its latest attempt both say succeeded", async () => {
    const { store, clock } = await newStore();
    const { item, run } = await pausedRun(store);
    clock.advance(10);
    const resumed = (await store.claimRun({ worker_id: W, kinds: ["implement"], lease_ms: LEASE }))!;
    expect(resumed.id).toBe(run.id);
    expect((await store.completeRun(resumed.id, resumed.lease!.token, DONE)).ok).toBe(true);

    expect((await store.getRun(run.id))!.status).toBe("succeeded");
    const { attempts, latest } = await latestAttempt(store, item.id, run.id);
    expect(latest.status).toBe("succeeded");
    // Nothing left open: no record still running, and only the paused claim's own record keeps "paused".
    expect(attempts.filter((a) => a.status === "running")).toEqual([]);
    expect(attempts.map((a) => a.status)).toEqual(["paused", "succeeded"]);
  });

  it("not resumed and cancelled: the latest attempt ends cancelled, not paused", async () => {
    const { store, clock } = await newStore();
    const { item, run } = await pausedRun(store);
    clock.advance(10);
    const r = await store.transition({
      id: item.id, expected_version: item.version, patch: {}, actor: system, reason: "close", cancel_queued_runs: true,
    });
    expect(r.ok && r.cancelled).toEqual([run.id]);

    expect((await store.getRun(run.id))!.status).toBe("cancelled");
    const { latest } = await latestAttempt(store, item.id, run.id);
    expect(latest.status).toBe("cancelled");
  });
});

describe("doctor: run and attempt status", () => {
  it("prints one FAIL line naming the run and both statuses; a consistent run gives no line", async () => {
    const { store } = await newStore();
    const bad = await seedMismatch(store, 1);
    const { run: good } = await pausedRun(store, 2);
    const again = (await store.claimRun({ worker_id: W, kinds: ["implement"], lease_ms: LEASE }))!;
    await store.completeRun(again.id, again.lease!.token, DONE);

    const checks = await runAttemptChecks(store.db);
    const failing = checks.filter((c) => !c.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.msg).toContain(bad);
    expect(failing[0]!.msg).toContain("succeeded");
    expect(failing[0]!.msg).toContain("paused");
    expect(checks.some((c) => c.msg.includes(good.id))).toBe(false);
  });

  it("reads only: the check leaves the mismatch in place", async () => {
    const { store } = await newStore();
    await seedMismatch(store, 1);
    await runAttemptChecks(store.db);
    expect((await runAttemptChecks(store.db)).filter((c) => !c.ok)).toHaveLength(1);
  });

  it("on doctor's store: a FAIL line for the mismatch and the store closed; a store that is not SQL gives no line", async () => {
    const { store } = await newStore();
    const bad = await seedMismatch(store, 1);
    let closed = 0;
    const lines = (await storeRunAttemptChecks(async () => ({ sql: store.db, close: async () => void closed++ }))).map(checkLine);
    expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([expect.stringContaining(`run ${bad}: worker_runs.status is succeeded but its latest attempt is paused`)]);
    expect(closed).toBe(1);
    expect(await storeRunAttemptChecks(async () => ({ sql: null, close: async () => undefined }))).toEqual([]);
    const unreadable = await storeRunAttemptChecks(async () => { throw new Error("postgres://user:pw@host/db"); });
    expect(unreadable).toEqual([{ ok: false, warn: true, msg: "run and attempt status: could not read the store" }]);
  });
});

describe("migration: repair run attempt status", () => {
  it("is discovered as an additive worker migration", async () => {
    const m = (await discoverMigrations()).find((x) => x.id === MIGRATION);
    expect(m).toMatchObject({ component: "worker", change: "additive" });
  });

  it("sets the latest attempt of a finished run to the run's status, once; a second run changes nothing", async () => {
    const { store } = await newStore();
    const bad = await seedMismatch(store, 1);
    const m = (await discoverMigrations()).find((x) => x.id === MIGRATION)!;
    const columns = async () => (await store.db.all("SELECT name FROM pragma_table_info('worker_run_attempts')")).map((r) => r.name);
    const before = await columns();

    await m.up(mdb(store));
    const [row] = await store.db.all("SELECT status FROM worker_run_attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1", [bad]);
    expect(row!.status).toBe("succeeded");
    expect((await runAttemptChecks(store.db)).filter((c) => !c.ok)).toEqual([]);

    const snapshot = await store.db.all("SELECT * FROM worker_run_attempts ORDER BY run_id, attempt");
    await m.up(mdb(store));
    expect(await store.db.all("SELECT * FROM worker_run_attempts ORDER BY run_id, attempt")).toEqual(snapshot);
    expect(await columns()).toEqual(before);
  });
});
