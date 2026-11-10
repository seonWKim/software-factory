import { describe, expect, it } from "vitest";
import { OUTCOME_WAIT_MS, enqueueImprove, manualWindow, patternKey, settleOutcomes } from "../src/core/improver.js";
import { type ControllerDeps } from "../src/core/controller-deps.js";
import { RECURRING_FAILURE, type CloseReason, type RunOutcome, type WorkerId, type WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import outcomeMigration from "../src/controller/migrations/20261111T1500-controller-filed-pattern-outcome.migration.js";
import { tableColumns, type MigrationDb } from "../src/state/index.js";
import { FakeAuth, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Issue #511: a failed run of a filed pattern holds its item for a person at once (design 05-alarms), and a filed
// pattern's outcome says whether its fix held seven days after it closed (design 07-self-improvement).

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BOOM = { error_code: "checks_failed", detail: "npm test exited #: boom" };
const KEY = patternKey(BOOM);
const boom = (detail = "npm test exited 1: boom"): RunOutcome => ({ status: "failed", error_code: "checks_failed", detail, infra: false });

let next = 1;
/** Finishes one implement run on a new item with `outcome`, a minute after the last. */
async function finish(store: FactoryStore, clock: FakeClock, outcome: RunOutcome = boom()) {
  clock.advance(MIN);
  const n = next++;
  const { item } = await store.createWorkItem(issue(n), system);
  await store.enqueueRun({ work_item_id: item.id, kind: "implement", idempotency_key: `k${n}` });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, outcome);
  return run;
}

/** BOOM's pattern filed as item `n` (design §7), not in the store yet: filed, nobody started it. */
async function file(store: FactoryStore, n = 100) {
  const { run } = await enqueueImprove({ store, clock: new FakeClock() }, PROJECT_KEY, "manual");
  const { report } = await store.recordImproveReport({ run_id: run.id, project: PROJECT_KEY, ...manualWindow(new Date()), groups: [], patterns: [] });
  const row = await store.claimFiledPattern({ project: PROJECT_KEY, pattern_key: KEY, ...BOOM, report_id: report.id });
  await store.setFiledPatternRef(row.id, row.report_id, issueRef(n));
  return row;
}

/** The filed item `n` taken into the store and closed with `reason`. */
async function closeFix(store: FactoryStore, reason: CloseReason, n = 100) {
  const { item } = await store.createWorkItem({ ...issue(n), source: issueRef(n) }, system);
  await store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "closed",
    patch: { stage: "CLOSED", close_reason: reason, ...(reason === "completed" ? { merge_sha: "abc1234" } : {}) },
  });
  return item;
}

function controller(store: FactoryStore, clock: FakeClock, over: Partial<ControllerDeps> = {}): ControllerRole {
  return new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, source: new FakeSource(), ...over });
}

const holds = async (store: FactoryStore, id: WorkItemId) => (await store.listStateChanges(id)).filter((c) => c.reason === RECURRING_FAILURE);

describe("filed pattern: hold at the first matching run", () => {
  it("a failed run of an open filed pattern holds its item for a person, the pattern key in the state change", async () => {
    const { store, clock } = await newStore();
    await file(store);
    const r = await finish(store, clock);
    await controller(store, clock).tickAlarms();
    expect(await store.getWorkItem(r.work_item_id)).toMatchObject({ blocked_on: "human", blocked_reason: RECURRING_FAILURE });
    expect(await holds(store, r.work_item_id)).toEqual([expect.objectContaining({ detail: { pattern_key: KEY } })]);
  });

  it("a second hold step on the same runs changes nothing and writes no second state change", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    await file(store);
    const r = await finish(store, clock);
    await c.tickAlarms();
    const held = await store.getWorkItem(r.work_item_id);
    await c.tickAlarms();
    expect(await store.getWorkItem(r.work_item_id)).toEqual(held);
    expect(await holds(store, r.work_item_id)).toHaveLength(1);
  });

  it("a hold a person cleared is not put back by the same run", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    await file(store);
    const r = await finish(store, clock);
    await c.tickAlarms();
    const held = (await store.getWorkItem(r.work_item_id))!;
    clock.advance(MIN);
    await store.transition({ id: held.id, expected_version: held.version, actor: system, reason: "cleared", patch: { blocked_on: "none", blocked_reason: null } });
    await c.tickAlarms();
    expect(await store.getWorkItem(r.work_item_id)).toMatchObject({ blocked_on: "none" });
    expect(await holds(store, r.work_item_id)).toHaveLength(1);
  });

  it("the re-raise alert and the hold's state change name the same pattern key", async () => {
    const { store, clock } = await newStore();
    await file(store);
    const runs = [await finish(store, clock), await finish(store, clock), await finish(store, clock)];
    await controller(store, clock).tickAlarms();
    const reraise = (await store.listAlerts({ limit: 10 })).find((a) => a.pattern_key.startsWith("recurring:"));
    for (const r of runs) {
      const [hold] = await holds(store, r.work_item_id);
      expect(reraise?.pattern_key).toBe(`recurring:${hold!.detail!.pattern_key}`);
    }
  });

  it("holds nothing for a closed filed item, a run before the filing, or another pattern", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    const before = await finish(store, clock);
    clock.advance(MIN);
    await file(store);
    const other = await finish(store, clock, boom("something else"));
    await c.tickAlarms();
    for (const r of [before, other]) expect(await store.getWorkItem(r.work_item_id)).toMatchObject({ blocked_on: "none" });

    await closeFix(store, "failed");
    const after = await finish(store, clock);
    await c.tickAlarms();
    expect(await store.getWorkItem(after.work_item_id)).toMatchObject({ blocked_on: "none" });
  });
});

describe("filed pattern: outcome seven days after its fix closed", () => {
  const outcome = async (store: FactoryStore) => (await store.getFiledPattern(PROJECT_KEY, KEY))!;

  it("no matching failed run in the seven days after a completed close: holds", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    await file(store);
    await closeFix(store, "completed");
    await finish(store, clock, boom("something else"));
    clock.advance(OUTCOME_WAIT_MS);
    await c.tickImprove();
    expect(await outcome(store)).toMatchObject({ outcome: "holds", outcome_at: clock.now().toISOString() });
  });

  it("a matching failed run in the seven days after a completed close: regressed", async () => {
    const { store, clock } = await newStore();
    await file(store);
    await closeFix(store, "completed");
    clock.advance(3 * DAY);
    await finish(store, clock);
    clock.advance(OUTCOME_WAIT_MS);
    await controller(store, clock).tickImprove();
    expect(await outcome(store)).toMatchObject({ outcome: "regressed" });
  });

  it("no outcome before seven days have passed since the close", async () => {
    const { store, clock } = await newStore();
    await file(store);
    await closeFix(store, "completed");
    clock.advance(OUTCOME_WAIT_MS - MIN);
    expect(await settleOutcomes({ store, clock }, PROJECT_KEY)).toEqual([]);
    expect(await outcome(store)).toMatchObject({ outcome: null, outcome_at: null });
  });

  it("is written once: a second step, or two at once, write nothing more", async () => {
    const { store, clock } = await newStore();
    const row = await file(store);
    await closeFix(store, "completed");
    clock.advance(OUTCOME_WAIT_MS);
    const [a, b] = await Promise.all([settleOutcomes({ store, clock }, PROJECT_KEY), settleOutcomes({ store, clock }, PROJECT_KEY)]);
    expect([...a, ...b].map((p) => p.pattern_key)).toEqual([KEY]);
    const first = await outcome(store);
    clock.advance(MIN);
    expect(await settleOutcomes({ store, clock }, PROJECT_KEY)).toEqual([]);
    expect(await store.setFiledPatternOutcome(row.id, "regressed", clock.now().toISOString() as never)).toBe(false);
    expect(await outcome(store)).toEqual(first);
  });

  it("an open item, or one closed as failed, rejected or duplicate, gets no outcome", async () => {
    for (const reason of [null, "failed", "rejected", "duplicate"] as const) {
      const { store, clock } = await newStore();
      await file(store);
      if (reason) await closeFix(store, reason);
      else await store.createWorkItem({ ...issue(100), source: issueRef(100) }, system);
      clock.advance(2 * OUTCOME_WAIT_MS);
      expect(await settleOutcomes({ store, clock }, PROJECT_KEY)).toEqual([]);
      expect(await outcome(store)).toMatchObject({ outcome: null });
    }
  });
});

describe("migration: filed pattern outcome", () => {
  it("adds nullable outcome and outcome_at, keeps existing rows unset, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db: MigrationDb = { dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
    const row = await file(store);
    for (const col of ["outcome", "outcome_at"]) await db.run(`ALTER TABLE controller_filed_patterns DROP COLUMN ${col}`);
    expect(outcomeMigration).toMatchObject({ change: "additive" });
    await outcomeMigration.up(db);
    await outcomeMigration.up(db);
    expect(await tableColumns(db, "controller_filed_patterns")).toEqual(expect.arrayContaining(["outcome", "outcome_at"]));
    expect(await store.getFiledPattern(PROJECT_KEY, KEY)).toMatchObject({ id: row.id, outcome: null, outcome_at: null });
  });
});
