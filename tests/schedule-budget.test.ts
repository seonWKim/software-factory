// The per-schedule token cap (design 08-schedules): summed over the schedule's runs (a `day` cap: only the runs of
// the claimed slot's UTC date) and checked by the claim pass before an occurrence of a model-calling action runs. Over the cap the occurrence is kept as a `checkpoint` run
// row, no action (so no model) runs, the schedule stays idle so its next occurrences still come due, and a local
// item waits for the owner. The common `/approve` on that item raises the cap and runs the held occurrence; the
// common `/reject` ends it as `rejected`.

import { describe, expect, it } from "vitest";
import { applies, approveRefusal, commandSpec, commandState } from "../src/core/commands.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { approveCheck } from "../src/core/request-transition.js";
import {
  SCHEDULE_CHECKPOINT, SCHEDULE_CHECKPOINT_APPROVED, SCHEDULE_TOKEN_CAP, type ScheduleActionSpec, type TokenPeriod, addSchedule, checkpointSourceId, raisedCap,
  runDueSchedules,
} from "../src/core/schedule.js";
import type { Timestamp, UserId, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { ScheduleAction } from "../src/interfaces/schedule-action.js";
import { silent } from "./helpers/fakes/config.js";

const ME = "local:owner" as UserId;
const OWNER = { kind: "user" as const, id: ME };
const PROJECT = "local:here:repo";
const DAY = 86_400_000;
const D1 = "2026-11-23T00:00:00.000Z", D2 = "2026-11-24T00:00:00.000Z", D3 = "2026-11-25T00:00:00.000Z";
const at = (iso: string) => new Date(iso);

/** A stand-in for a model-calling action: each run "calls the model" once, using `tokens`, recorded on its run row. */
function modelAction(store: SqlFactoryStore, tokens: number): ScheduleAction & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(s, slot) {
      calls.push(slot);
      await store.recordScheduleRunResult(s.id, slot, { output: `answer for ${slot}`, tokens, cost_usd: 0.25 });
    },
  };
}

const AGENT: ScheduleActionSpec = { kind: "agent", settings: { prompt: "Look" } };

/** A daily schedule; its cap counts all its runs (`lifetime`) unless `token_period` says otherwise (null: none given). */
async function setup(action: ScheduleActionSpec = AGENT, token_cap: number | null = 1000, token_period: TokenPeriod | null = "lifetime") {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  await addSchedule(store, {
    id: "sch_c", title: "Nightly look", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME, action, token_cap, ...(token_period ? { token_period } : {}),
  }, clock.now());
  const model = modelAction(store, 1500);
  return { store, model, pass: scheduledAction(store, model, silent, PROJECT) };
}

const holder = (store: SqlFactoryStore, slot: string) => store.getWorkItemBySource("local", checkpointSourceId("sch_c", slot)) as Promise<WorkItem>;

/** The common approve gate on `it`, applied as the controller and the dashboard apply its transition. */
async function approve(store: SqlFactoryStore, it: WorkItem) {
  const answers = { split: (note: string | null) => ({ note, answers: [] }), detail: () => ({}) };
  const t = await approveCheck(store, it, { actor: OWNER, note: null, paths: [], comment_id: "c1", tag: null, widen: () => ({ patch: {}, detail: {} }), answers });
  if (!t || "refuse" in t || "split" in t) throw new Error(`approve refused: ${JSON.stringify(t)}`);
  expect(t.reason).toBe(SCHEDULE_CHECKPOINT_APPROVED);
  expect((await store.transition({ ...t, id: it.id, expected_version: it.version })).ok).toBe(true);
}

describe("the schedule token cap", () => {
  it("defaults to 200000 tokens over all the schedule's runs, and an approve raises it by that much over what was used", async () => {
    expect(SCHEDULE_TOKEN_CAP).toBe(200_000);
    expect(raisedCap(1000, 1500)).toBe(201_500);
    expect(raisedCap(200_000, 10)).toBe(400_000);
    const { store } = await setup(undefined, null);
    expect((await store.listSchedules())[0]!.token_cap).toBeNull();
    await store.close();
  });

  it("holds an occurrence over the cap at a checkpoint: no model call, the occurrence kept, the schedule idle and still coming due", async () => {
    const { store, model, pass } = await setup();
    await pass.fireDue(at(D1));
    expect(model.calls).toEqual([D1]);
    expect(await store.scheduleTokensUsed("sch_c")).toBe(1500);

    await pass.fireDue(at(D2));
    expect(model.calls).toEqual([D1]);
    const [schedule] = await store.listSchedules();
    expect(schedule).toMatchObject({ running_since: null, next_due_at: D3 });
    expect((await store.listScheduleRuns("sch_c")).map((r) => [r.occurrence_at, r.outcome])).toEqual([[D1, "fired"], [D2, "checkpoint"]]);
    const it = await holder(store, D2);
    expect(it).toMatchObject({ stage: "NEW", blocked_on: "human", blocked_reason: SCHEDULE_CHECKPOINT, project: PROJECT, requester_id: ME });
    expect(it.problem).toContain("used 1500 tokens of its 1000-token cap");
    expect(it.problem).toContain("`/approve` to raise the cap to 201500 tokens");
    expect(await store.listRuns(it.id)).toEqual([]);

    // A second pass at the same slot files no second item; the next slot comes due and is held too.
    await pass.fireDue(at(D2));
    await pass.fireDue(at(D3));
    expect(model.calls).toEqual([D1]);
    expect((await store.listScheduleRuns("sch_c")).map((r) => r.outcome)).toEqual(["fired", "checkpoint", "checkpoint"]);
    expect((await store.listWorkItems(50)).map((i) => i.source.id).sort()).toEqual([checkpointSourceId("sch_c", D2), checkpointSourceId("sch_c", D3)].sort());
    await store.close();
  });

  it("a build schedule calls no model, so the cap never holds it", async () => {
    const { store } = await setup({ kind: "build", settings: {} }, 1);
    await store.recordScheduleRunResult("sch_c", D1 as Timestamp, { output: "x", tokens: 5, cost_usd: null });
    expect((await runDueSchedules(store, at(D1))).fired.map((r) => r.occurrence_at)).toEqual([D1]);
    await store.close();
  });

  it("the common /approve raises the cap and runs the held occurrence once", async () => {
    const { store, model, pass } = await setup();
    await pass.fireDue(at(D1));
    await pass.fireDue(at(D2));
    const it = await holder(store, D2);
    expect(approveRefusal(it)).toBeNull();
    await approve(store, it);
    expect(await holder(store, D2)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });

    await pass.fireDue(at(D2));
    expect(model.calls).toEqual([D1, D2]);
    const [schedule] = await store.listSchedules();
    expect(schedule).toMatchObject({ token_cap: 201_500, running_since: null });
    expect((await store.listScheduleRuns("sch_c")).map((r) => [r.occurrence_at, r.outcome, r.output])).toEqual([[D1, "fired", `answer for ${D1}`], [D2, "fired", `answer for ${D2}`]]);

    // Answered once: another pass runs nothing again, and the raised cap lets the next occurrence fire.
    await pass.fireDue(at(D2));
    await pass.fireDue(at(D3));
    expect(model.calls).toEqual([D1, D2, D3]);
    await store.close();
  });

  it("the common /reject ends the held occurrence as rejected and runs nothing", async () => {
    const { store, model, pass } = await setup();
    await pass.fireDue(at(D1));
    await pass.fireDue(at(D2));
    const it = await holder(store, D2);
    expect(applies(commandSpec("reject"), commandState(it))).toBe(true);
    // The controller's `/reject`: the item closes as rejected.
    expect((await store.transition({ id: it.id, expected_version: it.version, patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor: OWNER, reason: "spec_rejected" })).ok).toBe(true);

    await pass.fireDue(at(D2));
    await pass.fireDue(at(new Date(Date.parse(D2) + DAY / 2).toISOString()));
    expect(model.calls).toEqual([D1]);
    expect((await store.listScheduleRuns("sch_c")).map((r) => r.outcome)).toEqual(["fired", "rejected"]);
    expect(await store.listHeldScheduleRuns()).toEqual([]);
    expect((await store.listSchedules())[0]!.token_cap).toBe(1000);
    await store.close();
  });

  it("an approved checkpoint waits while its schedule is running, and resumes once it is idle", async () => {
    const { store } = await setup();
    await store.recordScheduleRunResult("sch_c", D1 as Timestamp, { output: "x", tokens: 0, cost_usd: null });
    expect(await store.resumeHeldScheduleRun("sch_c", D1 as Timestamp, 5)).toBeNull(); // not held
    await runDueSchedules(store, at(D1)); // fired: running
    await store.recordScheduleRunResult("sch_c", D1 as Timestamp, { output: "x", tokens: 2000, cost_usd: null });
    await runDueSchedules(store, at(D2)); // refused: still running
    const [s] = await store.listSchedules();
    await store.endScheduleRun("sch_c", s!.running_since!);
    expect((await runDueSchedules(store, at(D3))).checkpoint.map((r) => r.occurrence_at)).toEqual([D3]);
    await runDueSchedules(store, at("2026-11-26T00:00:00.000Z")); // held again; the schedule stays idle
    expect(await store.resumeHeldScheduleRun("sch_c", D3 as Timestamp, 9000)).not.toBeNull();
    expect(await store.resumeHeldScheduleRun("sch_c", "2026-11-26T00:00:00.000Z" as Timestamp, 9000)).toBeNull(); // running now
    expect(await store.rejectHeldScheduleRun("sch_c", D3 as Timestamp)).toBe(false); // no longer held
    await store.close();
  });

  it("a daily schedule added without a period stores day; any other cadence stores lifetime", async () => {
    const { store } = await setup(AGENT, 1000, null);
    for (const [id, cadence] of [["sch_i", { kind: "interval", spec: "60" }], ["sch_w", { kind: "weekly", spec: "mon 09:00" }], ["sch_x", { kind: "cron", spec: "0 9 * * *" }]] as const) {
      expect(await addSchedule(store, { id, title: id, cadence, zone: "UTC", created_by: ME, action: AGENT }, at(D1))).toMatchObject({ ok: true });
    }
    expect(Object.fromEntries((await store.listSchedules()).map((s) => [s.id, s.token_period]))).toEqual({ sch_c: "day", sch_i: "lifetime", sch_w: "lifetime", sch_x: "lifetime" });
    await store.close();
  });

  it("a day cap counts only the runs of the claimed slot's UTC date, so the next day's occurrence runs with its cap fresh", async () => {
    const { store, model, pass } = await setup(AGENT, 1000, "day");
    expect(await store.scheduleTokensUsed("sch_c", "2026-11-23")).toBe(0);
    await pass.fireDue(at(D1));
    await pass.fireDue(at(D2));
    await pass.fireDue(at(D3));
    // Each day's occurrence fired though the runs used 1500 tokens a day, over the 1000-token cap in total.
    expect(model.calls).toEqual([D1, D2, D3]);
    expect(await store.scheduleTokensUsed("sch_c")).toBe(4500);
    expect(await store.scheduleTokensUsed("sch_c", "2026-11-24")).toBe(1500);

    // A second occurrence on the same UTC date (run now) counts that day's runs, and is held.
    const run = `${D3.slice(0, 10)}T06:00:00.000Z`;
    expect(await store.updateSchedule("sch_c", "2026-11-26T00:00:00.000Z" as Timestamp, { next_due_at: run as Timestamp })).toBe(true);
    await pass.fireDue(at(run));
    expect(model.calls).toEqual([D1, D2, D3]);
    const it = await holder(store, run);
    expect(it.problem).toContain("used 1500 tokens of its 1000-token cap");
    // An approve raises the cap over that day's tokens, not over all of them.
    expect(it.problem).toContain("`/approve` to raise the cap to 201500 tokens");
    await approve(store, it);
    await pass.fireDue(at(run));
    expect(model.calls).toEqual([D1, D2, D3, run]);
    expect((await store.listSchedules())[0]).toMatchObject({ token_cap: 201_500, token_period: "day" });
    await store.close();
  });

  it("a day cap's held occurrence still ends as rejected on /reject", async () => {
    const { store, model, pass } = await setup(AGENT, 1000, "day");
    await pass.fireDue(at(D1));
    const run = `${D1.slice(0, 10)}T06:00:00.000Z`;
    expect(await store.updateSchedule("sch_c", D2 as Timestamp, { next_due_at: run as Timestamp })).toBe(true);
    await pass.fireDue(at(run));
    const it = await holder(store, run);
    expect((await store.transition({ id: it.id, expected_version: it.version, patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor: OWNER, reason: "spec_rejected" })).ok).toBe(true);
    await pass.fireDue(at(run));
    expect(model.calls).toEqual([D1]);
    expect((await store.listScheduleRuns("sch_c")).map((r) => r.outcome)).toEqual(["fired", "rejected"]);
    await store.close();
  });

  it("a daily schedule with no stored period (stored before the period existed) counts per day, so yesterday's runs do not hold today's", async () => {
    const { store, model, pass } = await setup(AGENT, 1000, null);
    await store.db.run("UPDATE controller_schedules SET token_period = NULL");
    expect((await store.listSchedules())[0]!.token_period).toBeNull();
    await pass.fireDue(at(D1));
    await pass.fireDue(at(D2)); // 1500 tokens on D1's date, over the 1000-token cap; D2's date has none
    expect(model.calls).toEqual([D1, D2]);
    expect((await store.listScheduleRuns("sch_c")).map((r) => r.outcome)).toEqual(["fired", "fired"]);
    await store.close();
  });

  it("a non-daily schedule with no stored period counts all its runs", async () => {
    const { store, model, pass } = await setup(AGENT, 1000, null);
    await store.db.run("UPDATE controller_schedules SET cadence_kind = 'interval', cadence_spec = '60', token_period = NULL");
    expect((await store.listSchedules())[0]).toMatchObject({ cadence: { kind: "interval" }, token_period: null });
    await pass.fireDue(at(D1));
    await pass.fireDue(at(D2));
    expect(model.calls).toEqual([D1]);
    expect((await store.listScheduleRuns("sch_c")).map((r) => r.outcome)).toEqual(["fired", "checkpoint"]);
    await store.close();
  });
});
