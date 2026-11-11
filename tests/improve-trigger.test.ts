import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import {
  TRIGGER_AGE_MS, TRIGGER_FAILURES, TRIGGER_WINDOW_MS, dailyImproveKey, enqueueImprove, improveTriggerDue, listImproveRuns, triggerImprove, triggerImproveKey,
} from "../src/core/improver.js";
import type { Run, RunId, RunKind, Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeAuth, PROJECT, cleanScanner, config, silent } from "./helpers/fakes.js";

const DAY = 86_400_000;

/** A controller with no source plugin (solo, local store): the improve step needs only the store. */
function controller(store: FactoryStore, clock: FakeClock): ControllerRole {
  return new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
}

let n = 0;
/** Fails one `kind` run of a new local item, half a second after the last; the clock moves on half a second more. */
async function failRun(store: FactoryStore, clock: FakeClock, kind: RunKind = "triage"): Promise<RunId> {
  clock.advance(500);
  const i = ++n;
  await store.createWorkItem({ ...issue(i), source: { type: "local", id: `local-${i}`, link: "" } }, system, { enqueue: { kind, idempotency_key: `f${i}` } });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: `failure ${i}`, infra: false });
  clock.advance(500);
  return run.id;
}

async function failMany(store: FactoryStore, clock: FakeClock, count: number, kind: RunKind = "triage"): Promise<void> {
  for (let i = 0; i < count; i++) await failRun(store, clock, kind);
}

/** Claims and finishes the queued improve run, as a worker would. */
async function finishImprove(store: FactoryStore): Promise<Run> {
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["improve"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "reported", data: {} });
  return run;
}

/** A store whose day's improve run is queued and finished: the trigger counts from it. */
async function settled() {
  const clock = new FakeClock("2026-03-04T08:00:00.000Z");
  const { store } = await newStore(clock);
  await controller(store, clock).tickImprove();
  const daily = await finishImprove(store);
  expect(daily.idempotency_key).toBe(dailyImproveKey(PROJECT.key, "2026-03-04"));
  return { clock, store, daily };
}

async function triggered(store: FactoryStore): Promise<Run[]> {
  return (await listImproveRuns(store, PROJECT.key)).filter((r) => r.idempotency_key?.includes(":trigger:"));
}

describe("improve trigger: the rule", () => {
  const run = (id: string, kind: RunKind, finished_at: string): Run =>
    ({
      id: id as RunId, work_item_id: "wi_1" as WorkItemId, kind, status: "failed", finished_at: finished_at as Timestamp,
      outcome: { status: "failed", error_code: "x", detail: "y", infra: false },
    }) as Run;
  const now = new Date("2026-03-04T00:00:00.000Z");
  const recent = (i: number) => new Date(now.getTime() - (i + 1) * 60_000).toISOString();

  it("K failed runs in the last 24 hours are due, whatever their kinds; K-1 are not", () => {
    const ten = Array.from({ length: TRIGGER_FAILURES }, (_, i) => run(`r${i}`, "implement", recent(i)));
    expect(improveTriggerDue(ten, now)).toEqual({ reason: "count", failures: TRIGGER_FAILURES });
    expect(improveTriggerDue(ten.slice(1), now)).toBeNull();
    const mixed = ten.map((r, i) => ({ ...r, kind: i % 2 === 0 ? "implement" : "review" }) as Run);
    expect(improveTriggerDue(mixed, now)).toEqual({ reason: "count", failures: TRIGGER_FAILURES });
  });

  it("a failure finished more than 24 hours ago does not count toward K", () => {
    const nine = Array.from({ length: TRIGGER_FAILURES - 1 }, (_, i) => run(`r${i}`, "triage", recent(i)));
    const edge = new Date(now.getTime() - TRIGGER_WINDOW_MS).toISOString();
    const older = new Date(now.getTime() - TRIGGER_WINDOW_MS - 1).toISOString();
    expect(improveTriggerDue([...nine, run("old", "triage", older)], now)).toBeNull();
    expect(improveTriggerDue([...nine, run("edge", "triage", edge)], now)).toEqual({ reason: "count", failures: TRIGGER_FAILURES });
  });

  it("one failure older than the age limit is due; improve runs and runs that did not fail never count", () => {
    const old = new Date(now.getTime() - TRIGGER_AGE_MS - 1).toISOString();
    expect(improveTriggerDue([run("a", "triage", old)], now)).toEqual({ reason: "age", oldest: old });
    expect(improveTriggerDue([run("a", "improve", old)], now)).toBeNull();
    expect(improveTriggerDue([{ ...run("a", "triage", old), status: "succeeded", outcome: { status: "succeeded", summary: "", data: {} } }], now)).toBeNull();
  });
});

describe("improve trigger: the controller tick", () => {
  it("10 unreviewed failed runs in the last 24 hours queue exactly one improve run for the project, not two", async () => {
    const { clock, store, daily } = await settled();
    await failMany(store, clock, TRIGGER_FAILURES);
    const c = controller(store, clock);
    await c.tickImprove();
    await c.tickImprove();
    const runs = await triggered(store);
    expect(runs.map((r) => r.idempotency_key)).toEqual([triggerImproveKey(PROJECT.key, daily.id)]);
    // It reports the failures since the last improve run was queued.
    expect(runs[0]!.input?.improve).toEqual({ window_start: daily.created_at, window_end: clock.now().toISOString() });
    expect(runs[0]!.status).toBe("queued");
  });

  it("9 unreviewed failures with the oldest under 3 days queue nothing", async () => {
    const { clock, store } = await settled();
    await failMany(store, clock, TRIGGER_FAILURES - 1);
    clock.advance(DAY / 2); // still 2026-03-04: no new daily run
    await controller(store, clock).tickImprove();
    expect(await listImproveRuns(store, PROJECT.key)).toHaveLength(1);
    // With no improve run at all, 9 failures whose oldest is just under 3 days old queue nothing either.
    const solo = await newStore(new FakeClock("2026-03-01T00:00:00.000Z"));
    await failMany(solo.store, solo.clock, TRIGGER_FAILURES - 1);
    solo.clock.set("2026-03-03T23:59:00.000Z");
    expect(await triggerImprove(solo, PROJECT.key)).toBeNull();
    expect(await listImproveRuns(solo.store, PROJECT.key)).toEqual([]);
  });

  it("two controllers on one store, same tick, queue one improve run in total", async () => {
    const { clock, store, daily } = await settled();
    await failMany(store, clock, TRIGGER_FAILURES, "implement");
    await Promise.all([controller(store, clock).tickImprove(), controller(store, clock).tickImprove()]);
    expect((await triggered(store)).map((r) => r.idempotency_key)).toEqual([triggerImproveKey(PROJECT.key, daily.id)]);
  });

  it("nothing is triggered while an improve run is queued or running", async () => {
    const { clock, store } = await settled();
    await failMany(store, clock, TRIGGER_FAILURES);
    const manual = await enqueueImprove({ store, clock }, PROJECT.key, "manual");
    await controller(store, clock).tickImprove();
    expect(await triggered(store)).toEqual([]);
    const claimed = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["improve"], lease_ms: 60_000 }))!;
    expect(claimed.id).toBe(manual.run.id);
    await controller(store, clock).tickImprove();
    expect(await triggered(store)).toEqual([]);
  });

  it("failures before an improve run was queued are not counted again after it", async () => {
    const { clock, store } = await settled();
    await failMany(store, clock, TRIGGER_FAILURES);
    const c = controller(store, clock);
    await c.tickImprove();
    const [first] = await triggered(store);
    await finishImprove(store);
    clock.advance(1_000);
    await c.tickImprove();
    expect((await triggered(store)).map((r) => r.id)).toEqual([first!.id]);
    // Nine more after it: still under K. The tenth queues the next run, keyed by the first.
    await failMany(store, clock, TRIGGER_FAILURES - 1);
    await c.tickImprove();
    expect((await triggered(store)).map((r) => r.id)).toEqual([first!.id]);
    await failRun(store, clock);
    await c.tickImprove();
    expect((await triggered(store)).map((r) => r.idempotency_key)).toEqual([first!.idempotency_key, triggerImproveKey(PROJECT.key, first!.id)]);
  });
});

describe("improve trigger: age", () => {
  it("one unreviewed failure older than 3 days queues exactly one improve run", async () => {
    const clock = new FakeClock("2026-03-01T08:00:00.000Z");
    const { store } = await newStore(clock);
    await failRun(store, clock); // finished half a second ago
    clock.advance(TRIGGER_AGE_MS - 1_000);
    expect(await triggerImprove({ store, clock }, PROJECT.key)).toBeNull();
    clock.advance(1_000);
    const r = await triggerImprove({ store, clock }, PROJECT.key);
    expect(r).toMatchObject({ created: true, why: { reason: "age" } });
    expect(r!.run.idempotency_key).toBe(triggerImproveKey(PROJECT.key, null));
    expect(await triggerImprove({ store, clock }, PROJECT.key)).toBeNull();
    expect((await triggered(store)).map((x) => x.id)).toEqual([r!.run.id]);
  });
});
