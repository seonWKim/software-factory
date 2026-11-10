import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import type { SqlDriver } from "../src/state/index.js";
import {
  LeaseLostError,
  RunDeadlineError,
  StepTimeoutError,
  type ExecutionEngine,
  type RunRef,
  type RunTimeouts,
} from "../src/worker/engine/index.js";
import { JournalEngine, type JournalEngineOptions } from "../src/worker/engine/plugins/journal/journal-engine.js";
import { issue, MYSQL_URL, newMigratedMysqlDatabase, system } from "./helpers/store.js";

// RFC 0015 §9 `execution-engine` contract: an engine never recomputes a stored step, resumes after a crash at
// any step, and never misses a timeout. A run the controller's reaper requeued (the one takeover path) and a second
// engine claimed never runs a finished step twice. Runs on SQLite always, on MySQL when SF_TEST_MYSQL_URL is set.
// The engine's time comes only from the ticks a test hands it.

const T0 = Date.parse("2026-01-01T00:00:00.000Z"); // the store's FakeClock start: every run's created_at
const S = 1000;
const MIN = 60 * S;
const STEPS = ["prepare-branch", "run-agent", "pre-push-checks", "store-artifacts"] as const;

const KINDS: Record<string, RunTimeouts> = {
  implement: { start_to_close_ms: MIN, heartbeat_ms: 30 * S, schedule_to_close_ms: 60 * MIN, steps: { "run-agent": { start_to_close_ms: 10 * MIN } } },
  review: { start_to_close_ms: 10 * MIN, heartbeat_ms: 30 * S, schedule_to_close_ms: 5 * MIN },
};

interface Backend {
  name: string;
  /** Two drivers on one database, as two worker processes would hold. */
  open(): Promise<{ db: [SqlDriver, SqlDriver]; store: SqlFactoryStore; clock: FakeClock }>;
}

const BACKENDS: Backend[] = [
  {
    name: "sqlite",
    async open() {
      const driver = new SqliteDriver(":memory:");
      const clock = new FakeClock();
      const store = new SqlFactoryStore(driver, clock);
      await store.migrate();
      return { db: [driver, driver], store, clock };
    },
  },
  ...(MYSQL_URL
    ? [
        {
          name: "mysql",
          async open() {
            const mysql = await newMigratedMysqlDatabase();
            const a = new MysqlDriver(mysql.options);
            const b = new MysqlDriver(mysql.options);
            mysql.onCleanup(async () => {
              await a.close();
              await b.close();
            });
            const clock = new FakeClock();
            return { db: [a, b] as [SqlDriver, SqlDriver], store: new SqlFactoryStore(a, clock), clock };
          },
        },
      ]
    : []),
];

class Crash extends Error {}

interface Worker {
  engine: ExecutionEngine;
  /** Step bodies this worker executed, in order. */
  calls: string[];
  /** The worker's heartbeat tick at `ms`. */
  tick(ms: number): Promise<void>;
}

function worker(db: SqlDriver, workerId: string, opts: Partial<JournalEngineOptions> = {}): Worker {
  const engine = new JournalEngine({ db, workerId, codeVersion: "v1", kinds: KINDS, ...opts });
  return { engine, calls: [], tick: (ms) => engine.heartbeat(tickAt("heartbeat", 10 * S, ms)) };
}

/** The controller's reaper at `ms` (the store's `expireLeases`, as its `expire_leases` write runs it): the ids it requeued. */
async function reap(b: { store: SqlFactoryStore; clock: FakeClock }, ms: number): Promise<string[]> {
  b.clock.set(new Date(ms));
  return b.store.expireLeases(3);
}

/** A second worker's claim of a requeued run, at `ms`. */
async function claimAt(w: Worker, id: string, ms: number): Promise<RunRef | null> {
  await w.tick(ms);
  return w.engine.claim(id);
}

let seq = 0;
async function newRun(store: SqlFactoryStore, kind: "implement" | "review" = "implement"): Promise<string> {
  const { item } = await store.createWorkItem(issue(++seq), system);
  const { run } = await store.enqueueRun({ work_item_id: item.id, kind, idempotency_key: `${item.id}:${kind}` });
  return run.id;
}

interface Output {
  step: string;
  input: unknown;
  attempt: number;
}

/** The worker pipeline: each step gets the previous step's output. Throws Crash after step `crashAfter`. */
async function pipeline(w: Worker, run: RunRef, crashAfter = Infinity): Promise<Output[]> {
  const outs: Output[] = [];
  let prev: Output | null = null;
  for (const [i, id] of STEPS.entries()) {
    const input: Output | null = prev;
    const out = await w.engine.step(run, id, async (): Promise<Output> => {
      w.calls.push(id);
      return { step: id, input, attempt: run.attempt };
    });
    prev = out;
    outs.push(out);
    if (i === crashAfter) throw new Crash(`crash after ${id}`);
  }
  await w.engine.complete(run, { status: "succeeded" });
  return outs;
}

async function runRow(db: SqlDriver, id: string) {
  const [row] = await db.all("SELECT status, attempt, lease_token, lease_owner, code_version, deadline_at, outcome FROM worker_runs WHERE id = ?", [id]);
  return row!;
}

/** The run's journal rows in pipeline order. */
async function stepRows(db: SqlDriver, id: string) {
  const rows = await db.all("SELECT step_id, attempt, status, result_ref, error_code FROM worker_run_steps WHERE run_id = ?", [id]);
  const order = (r: { step_id?: unknown }) => (STEPS as readonly unknown[]).indexOf(r.step_id);
  return rows.sort((x, y) => order(x) - order(y));
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending promise callbacks run (driver I/O included), so a test can see a step has not settled. */
const settle = () => new Promise((r) => setImmediate(r));

/** What a step settles with: its error, or null. Never rejects. */
function outcome(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** A step whose body never returns. `started` resolves with its signal once the body runs. */
function hang(w: Worker, run: RunRef, stepId: string) {
  const started = deferred<AbortSignal>();
  const state = { settled: false };
  const result = outcome(
    w.engine.step(run, stepId, (ctx) => {
      started.resolve(ctx.signal);
      return new Promise<never>(() => {});
    }),
  ).finally(() => (state.settled = true));
  return { started: started.promise, result, state };
}

describe.each(BACKENDS)("execution-engine contract: journal on $name", (backend) => {
  it("runs the steps in order, journals each result, and completes the run", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const id = await newRun(store);
    await a.tick(T0 + S);
    const run = (await a.engine.claim(id))!;
    expect(run).toMatchObject({ id, kind: "implement", attempt: 1 });

    const outs = await pipeline(a, run);
    expect(a.calls).toEqual([...STEPS]);
    expect(outs.map((o) => o.step)).toEqual([...STEPS]);
    expect((await stepRows(db[0], id)).map((r) => [r.step_id, Number(r.attempt), r.status])).toEqual(STEPS.map((s) => [s, 1, "succeeded"]));
    expect(await runRow(db[0], id)).toMatchObject({
      status: "succeeded",
      lease_owner: null,
      code_version: "v1",
      deadline_at: new Date(T0 + 60 * MIN).toISOString(),
    });
  });

  it("adopts a run another claim path leased under its token, refuses a stale token, and forgets it on release", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const id = await newRun(store);
    const claimed = (await store.claimRun({ worker_id: "worker-a" as never, kinds: ["implement"], lease_ms: 5 * MIN }))!;
    const ref = { id, kind: "implement", attempt: claimed.attempt, lease_token: claimed.lease!.token };
    const now = { schedule: "claim", now: new Date(T0 + S).toISOString(), slot: 0 };
    expect(await a.engine.adopt({ ...ref, lease_token: ref.lease_token + 1 }, now)).toBe(false);
    await expect(a.engine.step(ref, "prepare-branch", async () => 1)).rejects.toThrow(/lease/);
    expect(await a.engine.adopt(ref, now)).toBe(true);
    expect(await a.engine.step(ref, "prepare-branch", async () => 1)).toBe(1);
    expect(await runRow(db[0], id)).toMatchObject({ status: "running", code_version: "v1", deadline_at: new Date(T0 + 60 * MIN).toISOString() });
    a.engine.release(ref);
    await expect(a.engine.step(ref, "run-agent", async () => 2)).rejects.toThrow(/lease/);
  });

  it("refuses to work before its first tick, a second claim, and a step id used twice", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await expect(a.engine.claim(id)).rejects.toThrow(/no tick yet/);
    await a.tick(T0 + S);
    await b.tick(T0 + S);
    const claims = await Promise.all([a.engine.claim(id), b.engine.claim(id)]);
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    const [w, run] = claims[0] ? [a, claims[0]] : [b, claims[1]!];
    await w.engine.step(run, "prepare-branch", async () => 1);
    await expect(w.engine.step(run, "prepare-branch", async () => 2)).rejects.toThrow(/used twice/);
  });

  // A crash after step k: the worker is gone (no more heartbeats), the reaper requeues the run, another worker
  // claims it and resumes from the journal.
  it.each([-1, 0, 1, 2, 3])("a crash after step %i resumes at the next step with the journaled outputs", async (k) => {
    const opened = await backend.open();
    const { db, store } = opened;
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await a.tick(T0 + S);
    const first = (await a.engine.claim(id))!;
    const before = k < 0 ? [] : await pipeline(a, first, k).catch((e: unknown) => {
      if (!(e instanceof Crash)) throw e;
      return [];
    });
    expect(before).toEqual([]); // the pipeline crashed, nothing returned
    expect(a.calls).toEqual(STEPS.slice(0, k + 1));

    expect(await reap(opened, T0 + S + 29 * S)).toEqual([]); // the lease (30s) has not expired yet
    expect(await reap(opened, T0 + S + 30 * S)).toEqual([id]);
    const resumed = await claimAt(b, id, T0 + S + 30 * S);
    expect(resumed).toEqual({ id, kind: "implement", attempt: 2, lease_token: first.lease_token + 1 });

    const outs = await pipeline(b, resumed!);
    expect(b.calls).toEqual(STEPS.slice(k + 1));
    expect(outs.map((o) => o.attempt)).toEqual(STEPS.map((_, i) => (i <= k ? 1 : 2)));
    outs.forEach((o, i) => expect(o.input).toEqual(i === 0 ? null : outs[i - 1]));
    expect((await stepRows(db[0], id)).map((r) => Number(r.attempt))).toEqual(STEPS.map((_, i) => (i <= k ? 1 : 2)));
    expect(await runRow(db[0], id)).toMatchObject({ status: "succeeded", attempt: 2, lease_owner: null });
  });

  it("a requeue during a running step: the old worker's late result is dropped, the journal keeps the new one", async () => {
    const opened = await backend.open();
    const { db, store } = opened;
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    await a.engine.step(run, "prepare-branch", async () => "branch");
    const started = deferred();
    const release = deferred<string>();
    const late = outcome(
      a.engine.step(run, "run-agent", async () => {
        started.resolve();
        return release.promise;
      }),
    );
    await started.promise;

    // While A heartbeats, the reaper leaves the run.
    await a.tick(T0 + 20 * S);
    expect(await reap(opened, T0 + 40 * S)).toEqual([]);
    // A stops (host asleep); the reaper requeues the run after the lease runs out, and B claims and finishes it.
    expect(await reap(opened, T0 + 50 * S)).toEqual([id]);
    const resumed = (await claimAt(b, id, T0 + 50 * S))!;
    expect(await b.engine.step(resumed, "prepare-branch", async () => "recomputed")).toBe("branch");
    expect(await b.engine.step(resumed, "run-agent", async () => "by-b")).toBe("by-b");

    release.resolve("by-a");
    expect(await late).toBeInstanceOf(LeaseLostError);
    const rows = await stepRows(db[0], id);
    expect(rows.find((r) => r.step_id === "run-agent")).toMatchObject({ status: "succeeded", result_ref: JSON.stringify("by-b") });
    await expect(a.engine.step(run, "pre-push-checks", async () => "x")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(a.engine.complete(run, { status: "succeeded" })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await b.engine.complete(resumed, { status: "succeeded" })).toBe(true);
  });

  it("takes no run over itself: another worker's ticks leave an expired lease to the controller's reaper", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    await b.tick(T0 + 10 * MIN);
    expect(await b.engine.claim(id)).toBeNull();
    expect(await runRow(db[0], id)).toMatchObject({ status: "running", lease_owner: "worker-a", lease_token: run.lease_token });
  });

  it("the old worker's heartbeat finds its run requeued and claimed again, and aborts its running step", async () => {
    const opened = await backend.open();
    const { db, store } = opened;
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    const hung = hang(a, run, "run-agent");
    const signal = await hung.started;
    expect(await reap(opened, T0 + 30 * S)).toEqual([id]);
    expect(await claimAt(b, id, T0 + 30 * S)).not.toBeNull();
    await a.tick(T0 + 31 * S);
    expect(await hung.result).toBeInstanceOf(LeaseLostError);
    expect(signal.aborted).toBe(true);
    expect(await runRow(db[0], id)).toMatchObject({ status: "running", lease_owner: "worker-b" });
  });

  it("a step past its start_to_close times out on the heartbeat tick; per-step timeouts override", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    const hung = hang(a, run, "prepare-branch");
    const signal = await hung.started;
    await a.tick(T0 + 59 * S);
    await settle();
    expect(hung.state.settled).toBe(false);
    await a.tick(T0 + 60 * S);
    expect(await hung.result).toBeInstanceOf(StepTimeoutError);
    expect(signal.aborted).toBe(true);
    expect((await stepRows(db[0], id))[0]).toMatchObject({ step_id: "prepare-branch", status: "failed", error_code: "start_to_close" });

    // run-agent has 10 minutes.
    const agent = hang(a, run, "run-agent");
    await agent.started;
    await a.tick(T0 + 60 * S + 9 * MIN);
    await settle();
    expect(agent.state.settled).toBe(false);
    await a.tick(T0 + 60 * S + 10 * MIN);
    expect(await agent.result).toBeInstanceOf(StepTimeoutError);
  });

  it("a run past its schedule_to_close deadline is aborted on the heartbeat, and no step runs after it", async () => {
    const { db, store } = await backend.open();
    const a = worker(db[0], "worker-a");
    const id = await newRun(store, "review"); // schedule_to_close 5 minutes, start_to_close 10
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    const hung = hang(a, run, "run-agent");
    await hung.started;
    await a.tick(T0 + 5 * MIN - S);
    await settle();
    expect(hung.state.settled).toBe(false);
    await a.tick(T0 + 5 * MIN);
    expect(await hung.result).toBeInstanceOf(RunDeadlineError);
    await expect(a.engine.step(run, "store-artifacts", async () => 1)).rejects.toBeInstanceOf(RunDeadlineError);
    // The worker fails the run with the step's code (the runner's stepFailure).
    expect(await a.engine.complete(run, { status: "failed", error_code: "schedule_to_close" })).toBe(true);
    expect(JSON.parse(String((await runRow(db[0], id)).outcome))).toMatchObject({ status: "failed", error_code: "schedule_to_close" });
  });

  it("a resumed step sees what the interrupted attempt saved as partial (the agent's session id)", async () => {
    const opened = await backend.open();
    const { db, store } = opened;
    const a = worker(db[0], "worker-a");
    const b = worker(db[1], "worker-b");
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    const saved = deferred();
    void a.engine
      .step(run, "run-agent", async (ctx) => {
        expect(ctx.partial).toBeNull();
        await ctx.savePartial({ session: "s-1" });
        saved.resolve();
        return new Promise<never>(() => {});
      })
      .catch(() => {});
    await saved.promise;
    await reap(opened, T0 + 30 * S);
    const seen = await b.engine.step((await claimAt(b, id, T0 + 30 * S))!, "run-agent", async (ctx) => ctx.partial);
    expect(seen).toEqual({ session: "s-1" });
  });

  it("a run journaled by other code is resumed only by a worker that can resume that code version", async () => {
    const opened = await backend.open();
    const { db, store } = opened;
    const old = worker(db[0], "worker-old", { codeVersion: "v1" });
    const id = await newRun(store);
    await old.tick(T0);
    const run = (await old.engine.claim(id))!;
    await old.engine.step(run, "prepare-branch", async () => "branch");

    expect(await reap(opened, T0 + 30 * S)).toEqual([id]);
    const next = worker(db[1], "worker-new", { codeVersion: "v2" });
    expect(await claimAt(next, id, T0 + 30 * S)).toBeNull();
    expect(await runRow(db[0], id)).toMatchObject({ status: "queued", code_version: "v1" });

    const compatible = worker(db[1], "worker-compatible", { codeVersion: "v3", resumes: (v) => v === "v1" });
    expect(await claimAt(compatible, id, T0 + 30 * S)).not.toBeNull();
    expect(await runRow(db[0], id)).toMatchObject({ lease_owner: "worker-compatible", code_version: "v3" });

    // A run with no journal yet adopts the claiming worker's code.
    const fresh = await newRun(store);
    await next.tick(T0 + 30 * S);
    expect(await next.engine.claim(fresh)).not.toBeNull();
    expect(await runRow(db[0], fresh)).toMatchObject({ code_version: "v2" });
  });

  it("a journal write that fails while recording a failed step keeps the step's own error and logs the write", async () => {
    const { db, store } = await backend.open();
    let down = false;
    // The database goes away after the step body started: recording its failure throws.
    const flaky: SqlDriver = {
      dialect: db[0].dialect,
      all: (sql, params) => db[0].all(sql, params),
      run: (sql, params) => db[0].run(sql, params),
      migrate: () => db[0].migrate(),
      schemaVersion: () => db[0].schemaVersion(),
      transaction: (fn) => (down ? Promise.reject(new Error("database is locked")) : db[0].transaction(fn)),
      isDuplicateKey: (err) => db[0].isDuplicateKey(err),
      close: () => db[0].close(),
    };
    const warned: unknown[] = [];
    const a = worker(flaky, "worker-a", { log: { warn: (msg, fields) => warned.push({ msg, ...fields }) } });
    const id = await newRun(store);
    await a.tick(T0);
    const run = (await a.engine.claim(id))!;
    const paused = new Crash("paused");
    const err = await outcome(
      a.engine.step(run, "run-agent", async () => {
        down = true;
        throw paused;
      }),
    );
    expect(err).toBe(paused);
    expect(warned).toEqual([expect.objectContaining({ msg: "step failure not journaled", run_id: id, step_id: "run-agent", error: "database is locked" })]);
  });

  it("a run whose journal holds only a failed step (a paused or network-requeued agent) is resumed by other code", async () => {
    const opened = await backend.open();
    const { db, store } = opened;
    const old = worker(db[0], "worker-old", { codeVersion: "v1" });
    const id = await newRun(store);
    await old.tick(T0);
    const run = (await old.engine.claim(id))!;
    await expect(
      old.engine.step(run, "run-agent", async (ctx) => {
        await ctx.savePartial({ session: "s-1" });
        throw new Crash("network_unavailable");
      }),
    ).rejects.toBeInstanceOf(Crash);
    expect(await reap(opened, T0 + 30 * S)).toEqual([id]);

    const next = worker(db[1], "worker-new", { codeVersion: "v2" });
    const resumed = await claimAt(next, id, T0 + 30 * S);
    expect(resumed).not.toBeNull();
    expect(await runRow(db[0], id)).toMatchObject({ lease_owner: "worker-new", code_version: "v2" });
    expect(await next.engine.step(resumed!, "run-agent", async (ctx) => ctx.partial)).toEqual({ session: "s-1" });
  });
});
