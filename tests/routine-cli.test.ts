import { describe, expect, it } from "vitest";
import { ROUTINE_USAGE, type RoutineAction, parseRoutineArgs, routineLine, runRoutineCommand } from "../src/cli/handlers/routine/routine.js";
import ROUTINE from "../src/cli/handlers/routine/routine.command.js";
import { NO_NEXT_SLOT } from "../src/core/routines.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { newStore } from "./helpers/store.js";

// `factory routine` (design 08-routines): each write goes through the core's writeRoutine, as the routine API's.

const ME = "local:me@example.com" as UserId;
const OTHER = "local:other@example.com" as UserId;

async function owned(): Promise<{ store: FactoryStore; clock: FakeClock }> {
  const { store, clock } = await newStore();
  await store.claimOwner(ME);
  return { store, clock };
}

function cli(store: FactoryStore, clock: FakeClock, o: { user?: UserId; refusal?: string | null; asked?: string[] } = {}) {
  return (args: string[]) => {
    const a = parseRoutineArgs(args);
    if ("error" in a) throw new Error(a.error);
    return runRoutineCommand({
      store, user: o.user ?? ME, now: () => clock.now(),
      refusal: async () => (o.asked?.push(args[0]!), o.refusal ?? null),
    }, a);
  };
}

const DAILY = ["--name", "Docs", "--instruction", "Check the docs", "--cadence", "daily", "--spec", "09:00", "--zone", "UTC"];

describe("routine command: arguments", () => {
  it("parses list, each write with its ID, and add/edit flags into the API's fields", () => {
    expect(parseRoutineArgs(["list"])).toEqual({ op: "list" });
    for (const w of ["pause", "resume", "delete", "run"] as const) expect(parseRoutineArgs([w, "r1"])).toEqual({ op: w, id: "r1", fields: {} });
    expect(parseRoutineArgs(["add", "r1", ...DAILY, "--url", "https://example.com", "--run-cap", "0.5", "--daily-cap", "none"])).toEqual({
      op: "add", id: "r1",
      fields: { name: "Docs", instruction: "Check the docs", url: "https://example.com", schedule: { kind: "daily", spec: "09:00" }, zone: "UTC", run_cap_usd: 0.5, daily_cap_usd: null },
    });
    expect(parseRoutineArgs(["edit", "r1", "--cadence", "none", "--trigger", "merge", "--url", "none"])).toEqual({ op: "edit", id: "r1", fields: { schedule: null, trigger: "merge", url: null } });
  });

  it("refuses a bad argument before any store call", () => {
    for (const bad of [[], ["stop"], ["list", "x"], ["pause"], ["pause", "r1", "x"], ["add", "--name", "x"], ["add", "r1", "--bogus", "x"], ["add", "r1", "--name"],
      ["add", "r1", "--cadence", "daily"], ["add", "r1", "--run-cap", "lots"], ["edit", "r1", "--name", "a", "--name", "b"]]) {
      expect(parseRoutineArgs(bad), bad.join(" ")).toEqual({ error: expect.any(String) });
    }
    expect(ROUTINE.names).toEqual(["routine"]);
    expect(ROUTINE.usage).toContain("routine list");
    expect(ROUTINE_USAGE).toContain("factory routine add");
  });
});

describe("routine command: writes through writeRoutine", () => {
  it("add, edit, pause, resume, run and list", async () => {
    const { store, clock } = await owned();
    const run = cli(store, clock);
    expect(await run(["list"])).toEqual({ code: 0, lines: ["no routine is stored"] });

    expect(await run(["add", "r1", ...DAILY])).toMatchObject({ code: 0, lines: ["added routine r1", expect.any(String)] });
    const added = await store.getRoutine("r1");
    expect(added).toMatchObject({ name: "Docs", instruction: "Check the docs", schedule: { kind: "daily", spec: "09:00" }, created_by: ME, paused: false, next_due_at: "2026-01-01T09:00:00.000Z" });
    await run(["add", "t1", "--name", "On merge", "--instruction", "Review the merge", "--trigger", "merge"]);

    expect((await run(["edit", "r1", "--name", "Docs check"])).code).toBe(0);
    expect((await store.getRoutine("r1"))?.name).toBe("Docs check");

    expect((await run(["pause", "r1"])).code).toBe(0);
    expect((await store.getRoutine("r1"))?.paused).toBe(true);
    expect((await run(["list"])).lines).toEqual(["r1  Docs check  paused  2026-01-01T09:00:00.000Z", "t1  On merge  active  on merge"]);

    clock.advance(10 * 3_600_000);
    expect((await run(["resume", "r1"])).code).toBe(0);
    expect(await store.getRoutine("r1")).toMatchObject({ paused: false, next_due_at: "2026-01-02T09:00:00.000Z" });

    // Run now: the next slot is now, read from the Clock.
    expect((await run(["run", "r1"])).lines[0]).toBe("routine r1 runs on the next tick");
    expect((await store.getRoutine("r1"))?.next_due_at).toBe(clock.now().toISOString());
    expect((await run(["list"])).lines).toEqual([`r1  Docs check  active  ${clock.now().toISOString()}`, "t1  On merge  active  on merge"]);
  });

  it("prints none for a scheduled routine with no next run", () => {
    const r = { id: "r9", name: "N", paused: false, trigger: null, next_due_at: null } as Parameters<typeof routineLine>[0];
    expect(routineLine(r)).toBe("r9  N  active  none");
  });

  it("delete removes the routine and its suggestions, as the API does", async () => {
    const { store, clock } = await owned();
    const run = cli(store, clock);
    await run(["add", "r1", ...DAILY]);
    await store.addRoutineSuggestions("r1", "run_1", [{ fingerprint: "f1", text: "Fix the link" }]);
    expect(await store.listRoutineSuggestions("r1")).toHaveLength(1);
    expect(await run(["delete", "r1"])).toEqual({ code: 0, lines: ["deleted routine r1"] });
    expect(await store.getRoutine("r1")).toBeNull();
    expect(await store.listRoutineSuggestions("r1")).toEqual([]);
  });

  it("a refusal of the core prints its reason, exits 1 and stores nothing", async () => {
    const { store, clock } = await owned();
    const run = cli(store, clock);
    expect(await run(["add", "r1", "--name", "Docs", "--instruction", "x"])).toEqual({ code: 1, lines: ["not changed: a routine needs a schedule or a trigger"] });
    expect(await store.listRoutines()).toEqual([]);
    expect(await run(["pause", "nope"])).toEqual({ code: 1, lines: ["not changed: no routine nope"] });
    await run(["add", "t1", "--name", "M", "--instruction", "x", "--trigger", "merge"]);
    const before = await store.getRoutine("t1");
    expect(await run(["run", "t1"])).toEqual({ code: 1, lines: [`not changed: ${NO_NEXT_SLOT}`] });
    expect(await run(["resume", "t1"])).toEqual({ code: 1, lines: ["not changed: not paused"] });
    expect(await store.getRoutine("t1")).toEqual(before);
  });
});

describe("routine command: the owner check", () => {
  const writes: string[][] = [["add", "r2", ...DAILY], ["edit", "r1", "--name", "X"], ["pause", "r1"], ["resume", "r1"], ["run", "r1"], ["delete", "r1"]];

  it("refuses every write from an identity that is not the store's owner, with the reason; nothing changes", async () => {
    const { store, clock } = await owned();
    await cli(store, clock)(["add", "r1", ...DAILY]);
    const before = await store.listRoutines();
    const other = cli(store, clock, { user: OTHER });
    for (const w of writes) expect(await other(w), w[0]).toEqual({ code: 1, lines: [`Only the owner manages routines; you are ${OTHER}.`] });
    expect(await store.listRoutines()).toEqual(before);
  });

  it("refuses with the owner check's reason (approve_spec) before any write; list needs no check", async () => {
    const { store, clock } = await owned();
    await cli(store, clock)(["add", "r1", ...DAILY]);
    const before = await store.listRoutines();
    const asked: string[] = [];
    const refused = cli(store, clock, { refusal: "not_owner", asked });
    for (const w of writes) expect(await refused(w), w[0]).toEqual({ code: 1, lines: ["Only the owner manages routines: not_owner."] });
    expect(asked).toEqual(writes.map((w) => w[0]));
    expect(await store.listRoutines()).toEqual(before);
    expect((await refused(["list"])).code).toBe(0);
    expect(asked).toEqual(writes.map((w) => w[0]));
  });

  it("refuses a write when the store has no owner yet", async () => {
    const { store, clock } = await newStore();
    expect(await cli(store, clock)(["add", "r1", ...DAILY])).toEqual({ code: 1, lines: [`Only the owner manages routines; you are ${ME}.`] });
    expect(await store.listRoutines()).toEqual([]);
  });
});
