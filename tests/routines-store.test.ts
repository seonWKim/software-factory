import { describe, expect, it } from "vitest";
import { ROUTINES, SNOOZE_MS, type RoutineInput, addRoutine, carrierItem, fingerprint, routineRunKey } from "../src/core/routines.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The routine store (src/impl/store/sql/routines.ts) behind addRoutine: a routine's first slot comes from the
// injected Clock; a routine with both a schedule and a trigger, or neither, is refused and stores nothing;
// suggestions keep one row per fingerprint, and a snooze runs out by the store's Clock.

const OWNER = "local:owner" as UserId;
const input = (over: Partial<RoutineInput> = {}): RoutineInput => ({
  id: "rt_1", name: "License", instruction: "Check the license.", url: null, schedule: { kind: "daily", spec: "09:00" }, zone: "UTC",
  trigger: null, run_cap_usd: 0.5, daily_cap_usd: 2, created_by: OWNER, ...over,
});

describe("routines in the store", () => {
  it("stores a scheduled routine with its first slot from the Clock, and a trigger routine with none", async () => {
    const clock = new FakeClock("2026-11-23T10:00:00.000Z");
    const { store } = await newStore(clock);
    const a = await addRoutine(store, input(), clock.now());
    expect(a).toMatchObject({ ok: true, routine: { id: "rt_1", next_due_at: "2026-11-24T09:00:00.000Z", created_at: "2026-11-23T10:00:00.000Z", paused: false } });
    clock.advance(60_000);
    const b = await addRoutine(store, input({ id: "rt_2", schedule: null, trigger: "merge", url: "https://status.example.com/" }), clock.now());
    expect(b).toMatchObject({ ok: true, routine: { id: "rt_2", next_due_at: null, trigger: "merge", schedule: null, url: "https://status.example.com/" } });
    expect((await store.listRoutines()).map((r) => r.id)).toEqual(["rt_1", "rt_2"]);
    expect(await store.getRoutine("rt_2")).toEqual(b.ok && b.routine);
  });

  it("refuses a routine with both a schedule and a trigger, or neither, and stores nothing", async () => {
    const clock = new FakeClock("2026-11-23T10:00:00.000Z");
    const { store } = await newStore(clock);
    expect(await addRoutine(store, input({ trigger: "merge" }), clock.now())).toMatchObject({ ok: false });
    expect(await addRoutine(store, input({ schedule: null }), clock.now())).toMatchObject({ ok: false });
    expect(await store.listRoutines()).toEqual([]);
  });

  it("keeps one suggestion per fingerprint: a later run's repeat is counted, the same run's second call adds nothing", async () => {
    const { store } = await newStore(new FakeClock("2026-11-23T10:00:00.000Z"));
    const f = (text: string) => ({ fingerprint: fingerprint(text), text });
    expect(await store.addRoutineSuggestions("rt_1", "run_1", [f("a"), f("b")])).toEqual({ added: 2, duplicates: 0 });
    expect(await store.addRoutineSuggestions("rt_1", "run_1", [f("a"), f("b")])).toEqual({ added: 0, duplicates: 0 });
    expect(await store.addRoutineSuggestions("rt_1", "run_2", [f("A."), f("c")])).toEqual({ added: 1, duplicates: 1 });
    expect(await store.addRoutineSuggestions("rt_2", "run_3", [f("a")])).toEqual({ added: 1, duplicates: 0 });
    expect((await store.listRoutineSuggestions("rt_1")).map((s) => [s.text, s.state, s.duplicates])).toEqual([["a", "pending", 1], ["b", "pending", 0], ["c", "pending", 0]]);
  });

  it("a snoozed suggestion reads as pending again 14 days later, with no write", async () => {
    const clock = new FakeClock("2026-11-23T10:00:00.000Z");
    const { store } = await newStore(clock);
    await store.addRoutineSuggestions("rt_1", "run_1", [{ fingerprint: "f", text: "a" }]);
    const [s] = await store.listRoutineSuggestions("rt_1");
    expect(await store.decideRoutineSuggestion(s!.id, { to: "snoozed", by: OWNER, snooze_ms: SNOOZE_MS })).toBe(true);
    expect(await store.getRoutineSuggestion(s!.id)).toMatchObject({ state: "snoozed", snoozed_until: "2026-12-07T10:00:00.000Z" });
    clock.advance(SNOOZE_MS - 1);
    expect((await store.listRoutineSuggestions("rt_1"))[0]).toMatchObject({ state: "snoozed" });
    clock.advance(1);
    expect((await store.listRoutineSuggestions("rt_1"))[0]).toMatchObject({ state: "pending", snoozed_until: "2026-12-07T10:00:00.000Z" });
  });
});

describe("editing and deleting a routine in the store", () => {
  it("editRoutine writes only the fields given, and only while the marks still equal the ones read", async () => {
    const clock = new FakeClock("2026-11-23T10:00:00.000Z");
    const { store } = await newStore(clock);
    const a = await addRoutine(store, input(), clock.now());
    if (!a.ok) throw new Error(a.problem);
    const read = { next_due_at: a.routine.next_due_at, last_run_at: a.routine.last_run_at };
    expect(await store.editRoutine("rt_1", { ...read, last_run_at: "2026-11-23T09:00:00.000Z" as never }, { name: "Other" })).toBe(false);
    expect(await store.getRoutine("rt_1")).toEqual(a.routine);
    expect(await store.editRoutine("rt_1", read, {})).toBe(false);
    expect(await store.editRoutine("nope", read, { name: "Other" })).toBe(false);
    const fields = { name: "Licence", schedule: null, trigger: "merge" as const, url: "https://example.com/", daily_cap_usd: null, next_due_at: null };
    expect(await store.editRoutine("rt_1", read, fields)).toBe(true);
    expect(await store.getRoutine("rt_1")).toEqual({ ...a.routine, ...fields });
    // The marks moved: an edit on the old marks loses.
    expect(await store.editRoutine("rt_1", read, { name: "Again" })).toBe(false);
    expect(await store.editRoutine("rt_1", { next_due_at: null, last_run_at: null }, { schedule: { kind: "interval", spec: "60" }, trigger: null, zone: "Asia/Seoul" })).toBe(true);
    expect(await store.getRoutine("rt_1")).toMatchObject({ schedule: { kind: "interval", spec: "60" }, trigger: null, zone: "Asia/Seoul", name: "Licence", instruction: "Check the license." });
  });

  it("deleteRoutine removes the routine and its suggestions, keeps other routines' suggestions and its runs", async () => {
    const clock = new FakeClock("2026-11-23T10:00:00.000Z");
    const { store } = await newStore(clock);
    await addRoutine(store, input(), clock.now());
    await addRoutine(store, input({ id: "rt_2" }), clock.now());
    const r = (await store.getRoutine("rt_1"))!;
    const { item } = await store.createWorkItem(carrierItem(r, PROJECT_KEY), ROUTINES);
    const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "routine", idempotency_key: routineRunKey("rt_1", "s"), input: { routine: { instruction: r.instruction, url: null } } });
    await store.addRoutineSuggestions("rt_1", run.id, [{ fingerprint: "f", text: "a" }]);
    await store.addRoutineSuggestions("rt_2", "run_2", [{ fingerprint: "f", text: "a" }]);
    expect(await store.deleteRoutine("rt_1")).toBe(true);
    expect(await store.getRoutine("rt_1")).toBeNull();
    expect(await store.listRoutineSuggestions("rt_1")).toEqual([]);
    expect((await store.listRoutineSuggestions("rt_2")).map((s) => s.text)).toEqual(["a"]);
    expect((await store.listRuns(item.id)).map((x) => x.id)).toContain(run.id);
    expect(await store.deleteRoutine("rt_1")).toBe(false);
    expect((await store.listRoutines()).map((x) => x.id)).toEqual(["rt_2"]);
  });
});
