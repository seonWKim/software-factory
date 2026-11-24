// `factory schedule …` (design 08-schedules): list, add, edit, pause, resume, run and runs from the CLI, each storing its
// change or refusing it with the reason and storing nothing. Pause clears the next due time, so no slot fires; resume
// sets the first slot after now; run sets now, so the next tick fires once. Writes are the owner's only.

import { describe, expect, it } from "vitest";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { SCHEDULE_LOST, type ScheduleStore, pauseSchedule, runDueSchedules } from "../src/core/schedule.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { answers } from "./helpers/local-cli.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const HOUR = 3_600_000;
const START = "2026-11-22T12:00:00.000Z"; // 21:00 Seoul: a daily 09:00 Seoul schedule is first due 2026-11-23 00:00Z
const FIRST = "2026-11-23T00:00:00.000Z" as Timestamp;
const ADD = ["add", "--id", "sch_fb", "--title", "Feedback", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "build"];

async function setup() {
  const clock = new FakeClock(START);
  const { store } = await newStore(clock);
  const d = (user: UserId): LocalCliDeps => ({ store, identity: { user, from: "cli_user" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "id", answers });
  /** `factory schedule <args>` as `user` (the owner unless given). */
  const cli = (args: string[], user: UserId = OWNER) => {
    const a = parseLocalCliArgs("schedule", args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d(user), a as CliAction);
  };
  return { clock, store, cli };
}

const stored = async (store: ScheduleStore) => (await store.listSchedules()).find((s) => s.id === "sch_fb");

describe("parsing `factory schedule …`", () => {
  it("reads each command, and add and edit their flags", () => {
    expect(parseLocalCliArgs("schedule", ["list"])).toEqual({ action: "schedule", command: { verb: "list" } });
    expect(parseLocalCliArgs("schedule", ["runs", "sch_fb"])).toEqual({ action: "schedule", command: { verb: "runs", id: "sch_fb" } });
    for (const verb of ["pause", "resume", "run", "delete"]) expect(parseLocalCliArgs("schedule", [verb, "sch_fb"])).toEqual({ action: "schedule", command: { verb, id: "sch_fb", fields: {} } });
    expect(parseLocalCliArgs("schedule", [...ADD, "--body", "Look again", "--skip-when-busy", "on", "--token-cap", "5000"])).toEqual({
      action: "schedule",
      command: {
        verb: "add", id: "sch_fb",
        fields: { title: "Feedback", cadence: "daily", spec: "09:00", zone: "Asia/Seoul", action: "build", body: "Look again", skip_when_busy: true, token_cap: 5000 },
      },
    });
    expect(parseLocalCliArgs("schedule", ["edit", "sch_fb", "--zone", "UTC", "--skip-when-busy", "off"])).toEqual({
      action: "schedule", command: { verb: "edit", id: "sch_fb", fields: { zone: "UTC", skip_when_busy: false } },
    });
    // No flag is a command too: the core refuses it with its reason.
    expect(parseLocalCliArgs("schedule", ["edit", "sch_fb"])).toEqual({ action: "schedule", command: { verb: "edit", id: "sch_fb", fields: {} } });
  });

  it("refuses anything incomplete or unknown with the usage", () => {
    for (const args of [
      [], ["list", "x"], ["pause"], ["delete"], ["delete", "a", "b"], ["run", "a", "b"], ["show", "sch_fb"], ["add", "--title", "T"], ["edit"], ["edit", "--title", "T"],
      ["edit", "sch_fb", "--id", "other"], ["edit", "sch_fb", "--title"], ["edit", "sch_fb", "--label", "x"], ["edit", "sch_fb", "--title", "a", "--title", "b"],
      ["edit", "sch_fb", "--skip-when-busy", "yes"], ["edit", "sch_fb", "--token-cap", "lots"], [...ADD, "--id", "again"],
    ]) {
      expect({ args, r: parseLocalCliArgs("schedule", args) }).toMatchObject({ r: { error: expect.stringContaining("usage:") } });
    }
  });
});

describe("factory schedule add and list", () => {
  it("stores the schedule with the owner's user ID, first due at the next slot, and lists it", async () => {
    const { store, cli } = await setup();
    expect(await cli(["list"])).toEqual({ code: 0, lines: ["no schedules"] });
    const r = await cli([...ADD, "--body", "Check the docs"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^added sch_fb\tFeedback\t2026-11-23T00:00:00.000Z\tidle\tbuild\tskip when busy off\ttoken cap 200000$/);
    expect(await stored(store)).toMatchObject({
      created_by: OWNER, next_due_at: FIRST, cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", action: { kind: "build", settings: { body: "Check the docs" } }, token_cap: null,
    });
    expect((await cli(["list"])).lines).toEqual([`sch_fb\tFeedback\t${FIRST}\tidle\tbuild\tskip when busy off\ttoken cap 200000`]);
  });

  it("an agent or feedback action's body is its prompt; feedback's max_tasks is left to the action", async () => {
    const { store, cli } = await setup();
    await cli(["add", "--id", "a1", "--title", "Ask", "--cadence", "interval", "--spec", "90", "--zone", "UTC", "--action", "agent", "--body", "Summarise", "--token-cap", "9000"]);
    await cli(["add", "--id", "f1", "--title", "Fb", "--cadence", "weekly", "--spec", "mon 09:00", "--zone", "UTC", "--action", "feedback", "--body", "Find gaps", "--skip-when-busy", "on"]);
    const all = await store.listSchedules();
    expect(all.find((s) => s.id === "a1")).toMatchObject({ action: { kind: "agent", settings: { prompt: "Summarise" } }, token_cap: 9000 });
    expect(all.find((s) => s.id === "f1")).toMatchObject({ action: { kind: "feedback", settings: { prompt: "Find gaps" } }, skip_when_busy: true });
    expect(all.find((s) => s.id === "f1")!.action!.settings).not.toHaveProperty("max_tasks");
  });

  it("refuses an ID already stored, a bad cadence, zone or action, a bad token cap and agent or feedback without a body, storing nothing", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    const before = await store.listSchedules();
    const set = (flag: string, v: string) => ADD.map((w, i) => (ADD[i - 1] === flag ? v : w === "sch_fb" ? "sch_2" : w));
    for (const [args, why] of [
      [ADD, "schedule sch_fb is already stored"],
      [set("--cadence", "hourly"), '"hourly" is not a cadence'],
      [set("--spec", "25:00"), ""],
      [set("--zone", "Mars/Base"), '"Mars/Base" is not a time zone'],
      [set("--action", "deploy"), 'unknown action kind "deploy"'],
      [set("--action", "agent"), "an agent action needs a body"],
      [set("--action", "feedback"), "a feedback action needs a body"],
      [[...set("--title", "T"), "--token-cap", "0"], "the token cap must be a whole number"],
    ] as [string[], string][]) {
      const r = await cli(args);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.lines[0]).toContain("refused: ");
      expect(r.lines[0]).toContain(why);
    }
    expect(await store.listSchedules()).toEqual(before);
  });
});

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

describe("factory schedule edit", () => {
  it("changes only the flags given; a new cadence or zone on an unpaused schedule sets its first slot after now", async () => {
    const { clock, store, cli } = await setup();
    await cli(ADD);
    clock.advance(HOUR);
    expect((await cli(["edit", "sch_fb", "--title", "Nightly"])).code).toBe(0);
    expect(await stored(store)).toMatchObject({ title: "Nightly", next_due_at: FIRST, zone: "Asia/Seoul", cadence: { kind: "daily", spec: "09:00" } });
    await cli(["edit", "sch_fb", "--zone", "UTC"]); // now 13:00Z: the next 09:00 UTC is tomorrow
    expect(await stored(store)).toMatchObject({ zone: "UTC", next_due_at: "2026-11-23T09:00:00.000Z", cadence: { spec: "09:00" } });
    await cli(["edit", "sch_fb", "--spec", "18:00"]);
    expect(await stored(store)).toMatchObject({ next_due_at: "2026-11-22T18:00:00.000Z", cadence: { kind: "daily", spec: "18:00" } });
    await cli(["edit", "sch_fb", "--action", "agent", "--body", "Read it", "--token-cap", "100", "--skip-when-busy", "on"]);
    expect(await stored(store)).toMatchObject({ action: { kind: "agent", settings: { prompt: "Read it" } }, token_cap: 100, skip_when_busy: true, title: "Nightly" });
    await cli(["edit", "sch_fb", "--body", "Read it twice"]);
    expect((await stored(store))!.action).toEqual({ kind: "agent", settings: { prompt: "Read it twice" } });
  });

  it("a paused schedule stays paused when its cadence changes", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    await cli(["pause", "sch_fb"]);
    expect((await cli(["edit", "sch_fb", "--cadence", "interval", "--spec", "60"])).code).toBe(0);
    expect(await stored(store)).toMatchObject({ next_due_at: null, cadence: { kind: "interval", spec: "60" } });
  });

  it("refuses no flag, and a bad cadence, zone, action or token cap, with its reason, storing nothing", async () => {
    const { store, cli } = await setup();
    await cli(ADD);
    const before = await store.listSchedules();
    for (const [args, why] of [
      [[], "nothing to change"],
      [["--cadence", "hourly"], '"hourly" is not a cadence'],
      [["--spec", "noon"], ""],
      [["--zone", "Nowhere"], '"Nowhere" is not a time zone'],
      [["--action", "deploy"], 'unknown action kind "deploy"'],
      [["--action", "feedback"], "a feedback action needs a body"],
      [["--token-cap", "0"], "the token cap must be a whole number"],
      [["--title", " "], "the title cannot be empty"],
    ] as [string[], string][]) {
      const r = await cli(["edit", "sch_fb", ...args]);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.lines[0]).toContain(`schedule edit sch_fb refused: ${why}`);
    }
    expect(await cli(["edit", "nope", "--title", "x"])).toEqual({ code: 1, lines: ["schedule edit nope refused: no schedule nope"] });
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
    clock.advance(24 * HOUR);
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
