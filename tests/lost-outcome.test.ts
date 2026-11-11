import { describe, expect, it } from "vitest";
import { commandPhase } from "../src/core/commands.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { RunOutcome, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeSource, cleanScanner, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// A failed run's outcome always lands, and an item whose failed run's outcome never landed is repaired
// (design 05-restarts, 2026-11-11). Live case: an implement run's spec_conflict at the revision limit moved the
// item RUNNING → READY, which the WorkItem state table refused, so the run stayed unacknowledged and the item
// sat RUNNING with nothing queued; /retry found no failed run.

const failed = (error_code: string | null, detail = "it broke"): RunOutcome =>
  ({ status: "failed", error_code, detail, infra: false }) as RunOutcome;

/** An item RUNNING with its implement run claimed; `fields` patches the item first (e.g. revision_count). */
async function implementing(fields: Partial<WorkItem> = {}, cfg: Partial<FactoryConfig> = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const controller = new ControllerRole({
    store, source: new FakeSource(), auth: new FakeAuth(), clock, config: { ...config, ...cfg }, log: silent, scanner: cleanScanner,
    repeated_failure_rule: false,
  });
  const { item } = await store.createWorkItem(issue(1), system);
  const t = await store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "x",
    patch: { stage: "RUNNING", ...fields }, enqueue: { kind: "implement", idempotency_key: `${item.id}:implement:l0:r0` },
  });
  if (!t.ok) throw new Error(t.reason);
  const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
  const get = async () => (await store.getWorkItem(item.id))!;
  const runs = () => store.listRuns(item.id);
  const stranded = async () => (await controller.unit("stranded")).strandedStep();
  return { store, controller, run, get, runs, stranded };
}

describe("a failed run's outcome lands", () => {
  it("a failed implement run with a null error_code is acknowledged and queues its retry under the code unknown", async () => {
    const f = await implementing();
    await f.store.completeRun(f.run.id, f.run.lease!.token, failed(null));
    await f.controller.tickRuns();
    const [first, retry] = await f.runs();
    expect(first!.acknowledged_at).not.toBeNull();
    expect(retry).toMatchObject({ kind: "implement", status: "queued" });
    const change = (await f.store.listStateChanges(first!.work_item_id)).at(-1)!;
    expect(change).toMatchObject({ reason: "run_retry_scheduled", detail: { run_id: first!.id, error_code: "unknown" } });
  });

  it("an implement spec_conflict at the revision limit lands as max_revisions (RUNNING → READY), acknowledged", async () => {
    const f = await implementing({ revision_count: 1 }, { max_loops: 1 });
    await f.store.completeRun(f.run.id, f.run.lease!.token, failed("spec_conflict", "criterion 2 needs src/core/x.ts"));
    await f.controller.tickRuns();
    const it = await f.get();
    expect(it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" });
    expect(commandPhase(it)).toBe("max_revisions");
    expect((await f.runs()).every((r) => r.acknowledged_at !== null)).toBe(true);
  });
});

describe("the safety net for a lost run outcome", () => {
  it("repairs an item RUNNING with nothing queued whose last implement run failed and was acknowledged, once", async () => {
    const f = await implementing();
    await f.store.completeRun(f.run.id, f.run.lease!.token, failed("no_commits"));
    // The outcome missed across a restart: the run is acknowledged, the item never moved.
    const before = await f.get();
    const acked = await f.store.transition({ id: before.id, expected_version: before.version, actor: system, reason: "x", patch: {}, ack_run: f.run.id });
    expect(acked.ok).toBe(true);
    const stranded = await f.get();
    expect(stranded).toMatchObject({ stage: "RUNNING", blocked_on: "none" });

    await f.stranded();
    const it = await f.get();
    expect(it).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:no_commits" });
    expect(commandPhase(it)).toBe("failed_implement");
    const change = (await f.store.listStateChanges(it.id)).at(-1)!;
    expect(change).toMatchObject({ reason: "run_failed", detail: { run_id: f.run.id, repaired: "lost_outcome" } });

    // A second pass finds nothing to repair: one transition, no run queued.
    await f.stranded();
    expect((await f.get()).version).toBe(it.version);
    expect((await f.runs()).filter((r) => r.status === "queued")).toEqual([]);
  });

  it("leaves an item whose failed run already queued its retry", async () => {
    const f = await implementing();
    await f.store.completeRun(f.run.id, f.run.lease!.token, failed("tests_failed"));
    await f.controller.tickRuns();
    const it = await f.get();
    expect(it).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    await f.stranded();
    expect((await f.get()).version).toBe(it.version);
  });
});
