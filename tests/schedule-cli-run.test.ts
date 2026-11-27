// `factory schedule pause`, `resume`, `run`, `runs` and `delete` (design 08-schedules), the owner-only writes, a stale write, and the Check a page forms.

import { describe, expect, it } from "vitest";
import { SCHEDULE_LOST, type ScheduleStore, pauseSchedule, runDueSchedules } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { ADD, DAILY_PAGE, FIRST, HOUR, MERGE_PAGE, OWNER, page, setup, stored } from "./helpers/schedule-cli.js";
describe("factory schedule pause and resume", () => {
  it("pause clears the next due time and its slots do not fire; resume sets the first slot after now", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    expect((await cli(["pause", "sch_fb"])).lines[0]).toMatch(/^paused sch_fb\tFeedback\tpaused\t/);
    expect((await stored(store))!.next_due_at).toBeNull();
    expect(await cli(["pause", "sch_fb"])).toEqual({ code: 1, lines: ["schedule pause sch_fb refused: already paused"] });
    clock.advance(30 * HOUR); // past the 2026-11-23 and 2026-11-24 slots
    expect((await runDueSchedules(store, clock.now())).fired).toEqual([]);
    expect(await store.listScheduleRuns("sch_fb")).toEqual([]);
    const r = await cli(["resume", "sch_fb"]);
    expect(r.code).toBe(0);
    expect((await stored(store))!.next_due_at).toBe("2026-11-24T00:00:00.000Z"); // now is 2026-11-23 18:00Z
    expect(await cli(["resume", "sch_fb"])).toEqual({ code: 1, lines: ["schedule resume sch_fb refused: not paused"] });
  });
});

describe("factory schedule run", () => {
  it("sets the next due time to now, so the next tick fires it once", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    clock.advance(HOUR);
    expect((await cli(["run", "sch_fb"])).code).toBe(0);
    expect((await stored(store))!.next_due_at).toBe(clock.now().toISOString());
    const pass = await runDueSchedules(store, clock.now());
    expect(pass.fired.map((x) => x.occurrence_at)).toEqual([clock.now().toISOString()]);
    expect((await runDueSchedules(store, clock.now())).fired).toEqual([]);
    expect((await stored(store))!.next_due_at).toBe(FIRST);
  });

  it("on a paused schedule is refused and writes nothing", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    await cli(["pause", "sch_fb"]);
    const before = await store.listSchedules();
    expect(await cli(["run", "sch_fb"])).toEqual({ code: 1, lines: ["schedule run sch_fb refused: paused"] });
    expect(await store.listSchedules()).toEqual(before);
  });
});

describe("factory schedule runs", () => {
  it("prints one line per run: occurrence, outcome, recorded time, tokens, cost; an unknown ID is refused", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    expect(await cli(["runs", "sch_fb"])).toEqual({ code: 0, lines: ["no runs of sch_fb"] });
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    await store.recordScheduleRunResult("sch_fb", FIRST, { output: "ok", tokens: 120, cost_usd: 0.5 });
    expect((await cli(["runs", "sch_fb"])).lines).toEqual([`${FIRST}\tfired\t${clock.now().toISOString()}\t120 tokens\t$0.5`]);
    expect(await cli(["runs", "nope"])).toEqual({ code: 1, lines: ["no schedule nope"] });
  });
});

describe("schedule writes are the owner's only", () => {
  it("anyone but the owner is refused, and nothing is stored", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    const before = await store.listSchedules();
    const other = "local:guest@example.com" as UserId;
    for (const args of [[...ADD.map((w) => (w === "sch_fb" ? "sch_2" : w))], ["edit", "sch_fb", "--title", "x"], ["pause", "sch_fb"], ["resume", "sch_fb"], ["run", "sch_fb"], ["delete", "sch_fb"]]) {
      const r = await cli(args, other);
      expect({ args, r }).toMatchObject({ r: { code: 1, lines: [expect.stringContaining("only the owner manages schedules")] } });
    }
    expect((await cli(["pause", "sch_fb"], "local:anonymous" as UserId)).code).toBe(1);
    expect(await store.listSchedules()).toEqual(before);
    // Reads print for anyone.
    expect((await cli(["list"], other)).code).toBe(0);
  });
});

describe("factory schedule delete", () => {
  it("removes the schedule and its due occurrence, so nothing fires after; its past runs stay readable", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    const r = await cli(["delete", "sch_fb"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^deleted \(its past runs stay\) sch_fb\tFeedback\t/);
    expect(await store.listSchedules()).toEqual([]);
    // Its next slot (2026-11-24 00:00Z) comes and goes: no run of it is claimed.
    clock.advance(48 * HOUR);
    expect(await runDueSchedules(store, clock.now())).toEqual({ fired: [], refused: [], skipped: [], checkpoint: [] });
    expect((await store.listScheduleRuns("sch_fb")).map((x) => [x.occurrence_at, x.outcome])).toEqual([[FIRST, "fired"]]);
  });

  it("ends a held checkpoint as rejected, so no pass resumes it", async () => {
    const { clock, store, cli } = await setup();
    await cli(["add", "--id", "sch_fb", "--title", "Ask", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "agent", "--body", "Summarise", "--token-cap", "10"]);
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    await store.recordScheduleRunResult("sch_fb", FIRST, { output: "ok", tokens: 50, cost_usd: null });
    await store.endScheduleRun("sch_fb", (await stored(store))!.running_since!);
    // A daily schedule's cap is per UTC day: a second occurrence on FIRST's date is held.
    clock.advance(HOUR);
    expect((await cli(["run", "sch_fb"])).code).toBe(0);
    expect((await runDueSchedules(store, clock.now())).checkpoint).toHaveLength(1);
    expect(await store.listHeldScheduleRuns()).toHaveLength(1);
    expect((await cli(["delete", "sch_fb"])).code).toBe(0);
    expect(await store.listHeldScheduleRuns()).toEqual([]);
    expect((await store.listScheduleRuns("sch_fb")).map((x) => x.outcome)).toEqual(["fired", "rejected"]);
  });

  it("succeeds while a run is in flight; that run still records its result and ends without error", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    const since = (await stored(store))!.running_since!;
    expect(since).not.toBeNull();
    expect((await cli(["delete", "sch_fb"])).code).toBe(0);
    await store.recordScheduleRunResult("sch_fb", FIRST, { output: "done", tokens: 7, cost_usd: null });
    expect(await store.endScheduleRun("sch_fb", since)).toBe(false);
    expect(await store.listScheduleRuns("sch_fb")).toMatchObject([{ outcome: "fired", output: "done", tokens: 7 }]);
  });

  it("an unknown ID fails with a clear message and changes nothing", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    expect(await cli(["delete", "nope"])).toEqual({ code: 1, lines: ["schedule delete nope refused: no schedule nope"] });
    expect((await store.listSchedules()).map((s) => s.id)).toEqual(["sch_fb"]);
  });
});

describe("a write whose read is stale", () => {
  it("changes nothing and says so when a claim moved the next due time since its read", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    clock.advance(12 * HOUR);
    // A claim lands between the pause's read and its write.
    const racing: ScheduleStore = Object.assign(Object.create(store) as ScheduleStore, {
      updateSchedule: async (...a: Parameters<ScheduleStore["updateSchedule"]>) => {
        await runDueSchedules(store, clock.now());
        return store.updateSchedule(...a);
      },
    });
    expect(await pauseSchedule(racing, "sch_fb", clock.now())).toEqual({ ok: false, problem: SCHEDULE_LOST });
    expect((await stored(store))!.next_due_at).toBe("2026-11-24T00:00:00.000Z");
  });
});

describe("factory schedule pause, resume, run and runs on a Check a page schedule", () => {
  it("pause and resume set its paused mark; run sets a cadence row due now and is refused for on-merge", async () => {
    const { clock, store, cli } = await setup();
    await cli(DAILY_PAGE);
    expect((await cli(["pause", "cp_1"])).lines[0]).toMatch(/^paused cp_1\tDocs page\tpaused\t/);
    expect(await page(store)).toMatchObject({ paused: true });
    expect((await cli(["run", "cp_1"])).lines[0]).toContain("refused: paused");
    expect((await cli(["resume", "cp_1"])).code).toBe(0);
    expect(await page(store)).toMatchObject({ paused: false, next_due_at: FIRST });
    expect((await cli(["run", "cp_1"])).code).toBe(0);
    expect((await page(store))!.next_due_at).toBe(clock.now().toISOString());
    expect(await cli(["runs", "cp_1"])).toEqual({ code: 0, lines: ["no runs of cp_1"] });
    await cli(MERGE_PAGE.map((w) => (w === "cp_1" ? "cp_2" : w)));
    expect((await cli(["run", "cp_2"])).lines[0]).toContain("runs on each merge");
  });
});

describe("factory schedule delete on a Check a page schedule", () => {
  it("removes the schedule and its suggestions in one transaction, owner only", async () => {
    const { store, cli } = await setup();
    await cli(MERGE_PAGE);
    await store.addRoutineSuggestions("cp_1", "run_1", [{ fingerprint: "f1", text: "A broken link" }]);
    expect(await store.listRoutineSuggestions("cp_1")).toHaveLength(1);
    expect((await cli(["delete", "cp_1"], "local:other@example.com" as UserId)).code).toBe(1);
    expect(await store.listRoutineSuggestions("cp_1")).toHaveLength(1);
    expect((await cli(["delete", "cp_1"])).lines[0]).toMatch(/^deleted \(its past runs stay\) cp_1\t/);
    expect(await store.listCheckPages()).toEqual([]);
    expect(await store.listRoutineSuggestions("cp_1")).toEqual([]);
    expect(await store.getRoutine("cp_1")).toBeNull();
  });
});
