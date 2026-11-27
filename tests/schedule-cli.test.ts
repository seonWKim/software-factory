// `factory schedule …` (design 08-schedules): list, add, edit, pause, resume, run and runs from the CLI, each storing its
// change or refusing it with the reason and storing nothing. Pause clears the next due time, so no slot fires; resume
// sets the first slot after now; run sets now, so the next tick fires once. Writes are the owner's only.

import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { machineZone } from "../src/core/schedule-draft.js";
import { SCHEDULE_LOST, type ScheduleStore, pauseSchedule, runDueSchedules } from "../src/core/schedule.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { answers } from "./helpers/local-cli.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const HOUR = 3_600_000;
const START = "2026-11-22T12:00:00.000Z"; // 21:00 Seoul: a daily 09:00 Seoul schedule is first due 2026-11-23 00:00Z
const FIRST = "2026-11-23T00:00:00.000Z" as Timestamp;
const ADD = ["add", "--id", "sch_fb", "--title", "Feedback", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "build"];

async function setup(extra: Partial<LocalCliDeps> = {}) {
  const clock = new FakeClock(START);
  const { store } = await newStore(clock);
  const d = (user: UserId): LocalCliDeps => ({ store, identity: { user, from: "cli_user" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "id", answers, ...extra });
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
    expect(parseLocalCliArgs("schedule", [...ADD, "--body", "Look again", "--missed", "skip", "--run-now", "on", "--token-cap", "5000"])).toEqual({
      action: "schedule",
      command: {
        verb: "add", id: "sch_fb",
        fields: { title: "Feedback", cadence: "daily", spec: "09:00", zone: "Asia/Seoul", action: "build", body: "Look again", missed: "skip", run_now: true, token_cap: 5000 },
      },
    });
    expect(parseLocalCliArgs("schedule", [...ADD, "--missed", "catch-up", "--run-now", "off"])).toMatchObject({
      command: { verb: "add", fields: { missed: "catch_up", run_now: false } },
    });
    expect(parseLocalCliArgs("schedule", ["edit", "sch_fb", "--zone", "UTC", "--missed", "catch-up"])).toEqual({
      action: "schedule", command: { verb: "edit", id: "sch_fb", fields: { zone: "UTC", missed: "catch_up" } },
    });
    // No flag is a command too: the core refuses it with its reason.
    expect(parseLocalCliArgs("schedule", ["edit", "sch_fb"])).toEqual({ action: "schedule", command: { verb: "edit", id: "sch_fb", fields: {} } });
  });

  it("refuses anything incomplete or unknown with the usage", () => {
    for (const args of [
      [], ["list", "x"], ["pause"], ["delete"], ["delete", "a", "b"], ["run", "a", "b"], ["show", "sch_fb"], ["add", "--title", "T"], ["edit"], ["edit", "--title", "T"],
      ["edit", "sch_fb", "--id", "other"], ["edit", "sch_fb", "--title"], ["edit", "sch_fb", "--label", "x"], ["edit", "sch_fb", "--title", "a", "--title", "b"],
      ["edit", "sch_fb", "--missed", "yes"], ["edit", "sch_fb", "--missed", "catch_up"], ["edit", "sch_fb", "--missed", "constructor"], ["edit", "sch_fb", "--token-cap", "lots"],
      [...ADD, "--id", "again"], [...ADD, "--run-now", "yes"], ["edit", "sch_fb", "--run-now", "on"],
      // The old flag is unexpected in add and edit.
      [...ADD, "--skip-when-busy", "on"], ["edit", "sch_fb", "--skip-when-busy", "off"],
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
    expect(r.lines[0]).toMatch(/^added sch_fb\tFeedback\t2026-11-23T00:00:00.000Z\tidle\tbuild\tmissed catch-up\ttoken cap 200000$/);
    expect(await stored(store)).toMatchObject({
      created_by: OWNER, next_due_at: FIRST, cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", action: { kind: "build", settings: { body: "Check the docs" } }, token_cap: null,
    });
    expect((await cli(["list"])).lines).toEqual([`sch_fb\tFeedback\t${FIRST}\tidle\tbuild\tmissed catch-up\ttoken cap 200000`]);
  });

  it("--run-now on makes the first due time now; off keeps the next slot", async () => {
    const { clock, store, cli } = await setup();
    expect((await cli([...ADD, "--run-now", "on"])).code).toBe(0);
    expect(await stored(store)).toMatchObject({ next_due_at: clock.now().toISOString(), missed_rule: "catch_up" });
    const other = ADD.map((w) => (w === "sch_fb" ? "sch_2" : w));
    expect((await cli([...other, "--run-now", "off"])).code).toBe(0);
    expect((await store.listSchedules()).find((s) => s.id === "sch_2")).toMatchObject({ next_due_at: FIRST });
  });

  it("an agent or feedback action's body is its prompt; feedback's max_tasks is left to the action", async () => {
    const { store, cli } = await setup();
    await cli(["add", "--id", "a1", "--title", "Ask", "--cadence", "interval", "--spec", "90", "--zone", "UTC", "--action", "agent", "--body", "Summarise", "--token-cap", "9000"]);
    await cli(["add", "--id", "f1", "--title", "Fb", "--cadence", "weekly", "--spec", "mon 09:00", "--zone", "UTC", "--action", "feedback", "--body", "Find gaps", "--missed", "skip"]);
    const all = await store.listSchedules();
    expect(all.find((s) => s.id === "a1")).toMatchObject({ action: { kind: "agent", settings: { prompt: "Summarise" } }, token_cap: 9000 });
    expect(all.find((s) => s.id === "f1")).toMatchObject({ action: { kind: "feedback", settings: { prompt: "Find gaps" } }, missed_rule: "skip" });
    expect((await cli(["list"])).lines.find((l) => l.startsWith("f1\t"))).toContain("\tmissed skip\t");
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
    await cli(["edit", "sch_fb", "--action", "agent", "--body", "Read it", "--token-cap", "100", "--missed", "skip"]);
    expect(await stored(store)).toMatchObject({ action: { kind: "agent", settings: { prompt: "Read it" } }, token_cap: 100, missed_rule: "skip", title: "Nightly" });
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

// `factory schedule draft` and `improve` (src/core/schedule-draft.ts): a fake model, never a live one.
const WORDS = "review the design of software-factory every day at 9am";
const DRAFTED = { title: "Design review", cadence: "daily", spec: "09:00", zone: "", action: "feedback", text: "Read design-system/ and file a task per gap." };
const REVISED = "Read design-system/components.md and file a task for each page that departs from it.";

/** A fake model that answers every call with `answer` and counts the calls. */
function fakeModel(answer: Record<string, unknown>): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    async complete(req): Promise<LLMResponse> {
      calls.push(req);
      return { text: JSON.stringify(answer), parsed: answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

/** A y/N ask that answers `yes` and records each question, and the lines printed before it. */
function askSays(yes: boolean) {
  const asked: string[] = [], shownFirst: string[][] = [];
  return { asked, shownFirst, ask: async (shown: readonly string[], q: string) => (shownFirst.push([...shown]), asked.push(q), yes) };
}

async function drafting(answer: Record<string, unknown>, ask?: (shown: readonly string[], q: string) => Promise<boolean>) {
  const llm = fakeModel(answer);
  const s = await setup({ llm, scanner: new PatternEgressScanner(async () => []), ...(ask ? { ask } : {}) });
  return { ...s, llm };
}

describe("parsing `factory schedule draft` and `improve`", () => {
  it("reads the words or the ID, and --yes only as the last word", () => {
    expect(parseLocalCliArgs("schedule", ["draft", ...WORDS.split(" ")])).toEqual({ action: "schedule", command: { verb: "draft", words: WORDS, yes: false } });
    expect(parseLocalCliArgs("schedule", ["draft", "every", "day", "--yes"])).toEqual({ action: "schedule", command: { verb: "draft", words: "every day", yes: true } });
    expect(parseLocalCliArgs("schedule", ["improve", "sch_fb"])).toEqual({ action: "schedule", command: { verb: "improve", id: "sch_fb", yes: false } });
    expect(parseLocalCliArgs("schedule", ["improve", "sch_fb", "--yes"])).toEqual({ action: "schedule", command: { verb: "improve", id: "sch_fb", yes: true } });
    for (const args of [["draft"], ["draft", "--yes"], ["improve"], ["improve", "a", "b"], ["improve", "--yes"]]) {
      expect({ args, r: parseLocalCliArgs("schedule", args) }).toMatchObject({ r: { error: expect.any(String) } });
    }
  });
});

describe("factory schedule draft", () => {
  it("prints the proposal before it asks y/N; y adds it", async () => {
    const { asked, shownFirst, ask } = askSays(true);
    const { store, cli } = await drafting(DRAFTED, ask);
    const r = await cli(["draft", ...WORDS.split(" ")]);
    expect(r.code).toBe(0);
    expect(shownFirst).toEqual([expect.arrayContaining(["proposed sch_id", "  cadence: daily 09:00", `  zone: ${machineZone()}`, "  action: feedback", `  text: ${DRAFTED.text}`])]);
    expect(r.lines).not.toContain("proposed sch_id"); // printed once, before the question
    expect(r.lines.at(-1)).toMatch(/^added sch_id\tDesign review\t/);
    expect(asked).toEqual(["Add schedule sch_id?"]);
    expect(await store.listSchedules()).toEqual([
      expect.objectContaining({ id: "sch_id", created_by: OWNER, cadence: { kind: "daily", spec: "09:00" }, zone: machineZone(), action: expect.objectContaining({ kind: "feedback", settings: expect.objectContaining({ prompt: DRAFTED.text }) }) }),
    ]);
  });

  it("n, or no terminal without --yes, stores nothing", async () => {
    const n = askSays(false), no = await drafting(DRAFTED, n.ask);
    expect(await no.cli(["draft", ...WORDS.split(" ")])).toMatchObject({ code: 0, lines: ["nothing was stored"] });
    expect(n.shownFirst).toEqual([expect.arrayContaining(["proposed sch_id"])]);
    expect(await no.store.listSchedules()).toEqual([]);
    const tty = await drafting(DRAFTED);
    const r = await tty.cli(["draft", ...WORDS.split(" ")]);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toContain("no terminal to ask y/N");
    expect(await tty.store.listSchedules()).toEqual([]);
  });

  it("--yes adds it without asking", async () => {
    const { asked, ask } = askSays(false);
    const { store, cli } = await drafting(DRAFTED, ask);
    expect((await cli(["draft", ...WORDS.split(" "), "--yes"])).code).toBe(0);
    expect(asked).toEqual([]);
    expect((await store.listSchedules()).map((s) => s.id)).toEqual(["sch_id"]);
  });

  it("with no model configured, refuses and stores nothing", async () => {
    const { store, cli } = await setup({ llm: null, scanner: new PatternEgressScanner(async () => []), ask: askSays(true).ask });
    const r = await cli(["draft", "every", "day", "--yes"]);
    expect(r).toMatchObject({ code: 1, lines: [expect.stringContaining("no model is configured")] });
    expect(await store.listSchedules()).toEqual([]);
  });
});

describe("factory schedule improve", () => {
  async function improving(yes?: boolean) {
    const a = yes === undefined ? undefined : askSays(yes);
    const s = await drafting({ text: REVISED }, a?.ask);
    await s.cli([...ADD.map((w) => (w === "build" ? "feedback" : w)), "--body", "look at the design"]);
    return { ...s, asked: a?.asked ?? [], shownFirst: a?.shownFirst ?? [] };
  }
  const prompt = async (store: ScheduleStore) => (await stored(store))!.action!.settings.prompt;

  it("prints the old and new text before it asks y/N, and edits only on y", async () => {
    const yes = await improving(true);
    const r = await yes.cli(["improve", "sch_fb"]);
    expect(r.code).toBe(0);
    expect(yes.shownFirst).toEqual([["old:", "  look at the design", "new:", `  ${REVISED}`]]);
    expect(r.lines.at(-1)).toMatch(/^edited sch_fb\t/);
    expect(yes.asked).toEqual(["Write the new text to sch_fb?"]);
    expect(await prompt(yes.store)).toBe(REVISED);

    const no = await improving(false);
    expect(await no.cli(["improve", "sch_fb"])).toMatchObject({ code: 0, lines: ["nothing was stored"] });
    expect(no.shownFirst).toEqual([expect.arrayContaining(["old:", "new:"])]);
    expect(await prompt(no.store)).toBe("look at the design");

    const tty = await improving();
    expect((await tty.cli(["improve", "sch_fb"])).code).toBe(1);
    expect(await prompt(tty.store)).toBe("look at the design");
  });

  it("--yes edits without asking", async () => {
    const s = await improving(false);
    expect((await s.cli(["improve", "sch_fb", "--yes"])).code).toBe(0);
    expect(s.asked).toEqual([]);
    expect(await prompt(s.store)).toBe(REVISED);
  });
});

describe("schedule draft and improve are the owner's only", () => {
  it("anyone but the owner is refused before any model call, and nothing is stored", async () => {
    const { store, cli, llm } = await drafting(DRAFTED, askSays(true).ask);
    await cli(ADD);
    const before = await store.listSchedules();
    const other = "local:guest@example.com" as UserId;
    for (const args of [["draft", "every", "day", "--yes"], ["improve", "sch_fb", "--yes"]]) {
      expect({ args, r: await cli(args, other) }).toMatchObject({ r: { code: 1, lines: [expect.stringContaining("only the owner manages schedules")] } });
    }
    expect(llm.calls).toEqual([]);
    expect(await store.listSchedules()).toEqual(before);
  });
});

// Check a page schedules (design 08-schedules): the routine's fields through `schedule add` and `edit`, the on-merge
// cadence, and delete removing the schedule's suggestions too.
const PAGE = ["add", "--id", "cp_1", "--title", "Docs page", "--action", "check-page", "--url", "https://example.com/docs", "--instruction", "Find broken links"];
const DAILY_PAGE = [...PAGE, "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul"];
const MERGE_PAGE = [...PAGE, "--cadence", "on-merge"];
const page = async (store: ScheduleStore, id = "cp_1") => (await store.listCheckPages()).find((s) => s.id === id);

describe("parsing the Check a page flags", () => {
  it("reads --url, --instruction, --run-cap and --daily-cap (none clears a cap), and refuses a cap that is no number", () => {
    expect(parseLocalCliArgs("schedule", [...DAILY_PAGE, "--run-cap", "0.5", "--daily-cap", "2"])).toEqual({
      action: "schedule",
      command: {
        verb: "add", id: "cp_1",
        fields: {
          title: "Docs page", action: "check-page", url: "https://example.com/docs", instruction: "Find broken links", cadence: "daily", spec: "09:00", zone: "Asia/Seoul",
          run_cap_usd: 0.5, daily_cap_usd: 2,
        },
      },
    });
    expect(parseLocalCliArgs("schedule", ["edit", "cp_1", "--run-cap", "none"])).toMatchObject({ command: { verb: "edit", fields: { run_cap_usd: null } } });
    for (const args of [[...MERGE_PAGE, "--run-cap", "lots"], [...MERGE_PAGE, "--daily-cap", ""], ["edit", "cp_1", "--daily-cap", "1e"], [...MERGE_PAGE, "--url", "https://again"]]) {
      expect({ args, r: parseLocalCliArgs("schedule", args) }).toMatchObject({ r: { error: expect.stringContaining("usage:") } });
    }
  });
});

describe("factory schedule add --action check-page", () => {
  it("stores a Check a page schedule with its page, instruction and USD caps; the Schedules list leaves it out, schedule list prints it", async () => {
    const { store, cli } = await setup();
    const r = await cli([...DAILY_PAGE, "--run-cap", "0.5", "--daily-cap", "2", "--token-cap", "9000"]);
    expect(r).toMatchObject({ code: 0, lines: [expect.stringMatching(/^added cp_1\tDocs page\t2026-11-23T00:00:00.000Z\tidle\tcheck_page\t/)] });
    expect(await page(store)).toMatchObject({
      title: "Docs page", cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", trigger: null, next_due_at: FIRST, created_by: OWNER, paused: false,
      action: { kind: "check_page", settings: { instruction: "Find broken links", url: "https://example.com/docs" } }, run_cap_usd: 0.5, daily_cap_usd: 2, token_cap: 9000,
    });
    expect(await store.listSchedules()).toEqual([]);
    expect((await cli(["list"])).lines).toEqual([expect.stringMatching(/^cp_1\tDocs page\t2026-11-23T00:00:00.000Z\tidle\tcheck_page\t/)]);
    // The routine store reads the same row.
    expect(await store.getRoutine("cp_1")).toMatchObject({ name: "Docs page", instruction: "Find broken links", url: "https://example.com/docs", run_cap_usd: 0.5 });
  });

  it("--body fills the same instruction", async () => {
    const { store, cli } = await setup();
    const withBody = DAILY_PAGE.map((w) => (w === "--instruction" ? "--body" : w));
    expect((await cli(withBody)).code).toBe(0);
    expect((await page(store))!.action).toEqual({ kind: "check_page", settings: { instruction: "Find broken links", url: "https://example.com/docs" } });
  });

  it("--cadence on-merge needs no --spec or --zone (UTC); schedule list prints its next run as on each merge", async () => {
    const { store, cli } = await setup();
    expect((await cli(MERGE_PAGE)).code).toBe(0);
    expect(await page(store)).toMatchObject({ cadence: null, trigger: "merge", zone: "UTC", next_due_at: null, token_period: "lifetime" });
    expect((await cli(["list"])).lines).toEqual([expect.stringMatching(/^cp_1\tDocs page\ton each merge\tidle\tcheck_page\t/)]);
    expect(await store.getRoutine("cp_1")).toMatchObject({ trigger: "merge", schedule: null });
  });

  it("refuses a bad page, instruction or cap, on-merge with another action, and --spec with on-merge, with the reason, storing nothing", async () => {
    const { store, cli } = await setup();
    const set = (args: string[], flag: string, v: string) => args.map((w, i) => (args[i - 1] === flag ? v : w));
    const drop = (args: string[], flag: string) => args.filter((w, i) => w !== flag && args[i - 1] !== flag);
    for (const [args, why] of [
      [set(MERGE_PAGE, "--url", "ftp://example.com"), "an http or https URL"],
      [set(MERGE_PAGE, "--url", "example.com"), "an http or https URL"],
      [drop(MERGE_PAGE, "--url"), "needs --url"],
      [drop(MERGE_PAGE, "--instruction"), "needs an instruction"],
      [[...MERGE_PAGE, "--body", "Other"], "--instruction or --body, not both"],
      [[...MERGE_PAGE, "--run-cap", "0"], "a cap is a positive dollar amount"],
      [[...MERGE_PAGE, "--daily-cap", "-1"], "a cap is a positive dollar amount"],
      [[...MERGE_PAGE, "--spec", "09:00"], "on-merge takes no --spec"],
      [[...MERGE_PAGE, "--run-now", "on"], "runs on each merge"],
      [["add", "--id", "x", "--title", "T", "--cadence", "on-merge", "--action", "build"], "on-merge goes only with --action check-page"],
      [[...ADD, "--url", "https://example.com"], "only a check-page schedule takes"],
      [[...ADD, "--run-cap", "1"], "only a check-page schedule takes"],
      [drop(DAILY_PAGE, "--spec"), "missing spec"],
    ] as [string[], string][]) {
      const r = await cli(args);
      expect({ args, code: r.code, line: r.lines[0] }).toEqual({ args, code: 1, line: expect.stringContaining(why) });
    }
    expect(await store.listCheckPages()).toEqual([]);
    expect(await store.listSchedules()).toEqual([]);
  });
});

describe("factory schedule edit on a Check a page schedule", () => {
  it("changes its title, page, instruction and caps (none clears one)", async () => {
    const { store, cli } = await setup();
    await cli([...MERGE_PAGE, "--run-cap", "1"]);
    const r = await cli(["edit", "cp_1", "--title", "Docs", "--url", "https://example.com/new", "--body", "Check spelling", "--daily-cap", "3", "--run-cap", "none"]);
    expect(r).toMatchObject({ code: 0, lines: [expect.stringMatching(/^edited cp_1\tDocs\ton each merge\t/)] });
    expect(await page(store)).toMatchObject({
      title: "Docs", action: { kind: "check_page", settings: { instruction: "Check spelling", url: "https://example.com/new" } }, run_cap_usd: null, daily_cap_usd: 3, trigger: "merge",
    });
  });

  it("refuses its cadence or zone, another action, a bad page or cap, and Check a page flags on another schedule, storing nothing", async () => {
    const { store, cli } = await setup();
    await cli(MERGE_PAGE);
    await cli(ADD);
    const before = [await store.listSchedules(), await store.listCheckPages()];
    for (const [args, why] of [
      [["edit", "cp_1", "--cadence", "daily", "--spec", "09:00"], "cadence or trigger does not change"],
      [["edit", "cp_1", "--zone", "UTC"], "cadence or trigger does not change"],
      [["edit", "cp_1", "--action", "build"], "to or from check-page"],
      [["edit", "cp_1", "--url", "file:///etc"], "an http or https URL"],
      [["edit", "cp_1", "--run-cap", "0"], "a cap is a positive dollar amount"],
      [["edit", "sch_fb", "--action", "check-page", "--url", "https://example.com"], "to or from check-page"],
      [["edit", "sch_fb", "--instruction", "x"], "only a check-page schedule takes"],
      [["edit", "sch_fb", "--cadence", "on-merge"], "on-merge goes only with --action check-page"],
    ] as [string[], string][]) {
      const r = await cli(args);
      expect({ args, code: r.code, line: r.lines[0] }).toEqual({ args, code: 1, line: expect.stringContaining(why) });
    }
    expect([await store.listSchedules(), await store.listCheckPages()]).toEqual(before);
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

describe("feedback schedule grants", () => {
  const FEEDBACK = [...ADD.slice(0, -1), "feedback", "--body", "Review the pages"];

  it("add stores each --grant, makes the notes folder, and list shows each grant in plain words", async () => {
    const repo = await mkdtemp(join(tmpdir(), "grants-"));
    const { store, cli } = await setup({ makeNotesFolder: async (folder) => void (await mkdir(join(repo, folder), { recursive: true })) });
    const add = await cli([...FEEDBACK, "--grant", "browser=http://localhost:5173/", "--grant", "notes", "--grant", "repo=/src/other#dev", "--grant", "shell=/data/app.db"]);
    expect(add.code).toBe(0);
    expect((await stat(join(repo, ".factory", "notes", "sch_fb"))).isDirectory()).toBe(true);
    expect((await stored(store))!.action!.settings.grants).toEqual([
      { kind: "browser", url: "http://localhost:5173/" }, { kind: "notes" }, { kind: "repo", path: "/src/other", base_ref: "dev" },
      { kind: "shell", command: "sqlite3 -readonly", db: "/data/app.db" },
    ]);
    const line = (await cli(["list"])).lines.find((l) => l.startsWith("sch_fb\t"))!;
    expect(line).toContain("browser: Browse may read only http://localhost:5173/");
    expect(line).toContain("notes: may write only in .factory/notes/sch_fb/");
    expect(line).toContain("repo: its agent runs in /src/other (dev) and no other");
    expect(line).toContain("shell: only sqlite3 -readonly /data/app.db");
    await rm(repo, { recursive: true, force: true });
  });

  it("edit replaces the grants, --grant none clears them, and the prompt stays", async () => {
    const { store, cli } = await setup();
    expect((await cli([...FEEDBACK, "--grant", "notes"])).code).toBe(0);
    expect((await cli(["edit", "sch_fb", "--grant", "browser=http://127.0.0.1:8080/"])).code).toBe(0);
    expect((await stored(store))!.action!.settings).toEqual({ prompt: "Review the pages", grants: [{ kind: "browser", url: "http://127.0.0.1:8080/" }] });
    expect((await cli(["edit", "sch_fb", "--grant", "none"])).code).toBe(0);
    expect((await stored(store))!.action!.settings).toEqual({ prompt: "Review the pages", grants: [] });
    expect((await cli(["list"])).lines.find((l) => l.startsWith("sch_fb\t"))).not.toContain("grants:");
  });

  it("refuses add --id ../.. with a notes grant and makes no folder; a plain ID still gets .factory/notes/<id>/", async () => {
    const repo = await mkdtemp(join(tmpdir(), "grants-"));
    const { store, cli } = await setup({ makeNotesFolder: async (folder) => void (await mkdir(join(repo, folder), { recursive: true })) });
    const bad = ["add", "--id", "../..", "--title", "Feedback", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "feedback", "--body", "x", "--grant", "notes"];
    const tryCli = async (args: string[]) => { try { return await cli(args); } catch (e) { return { code: 1, lines: [(e as Error).message] }; } };
    const refused = await tryCli(bad);
    expect(refused.code).not.toBe(0);
    expect(refused.lines.join("\n")).toContain("schedule ID");
    for (const id of ["a/b", "a.b", "a b"]) expect((await tryCli(bad.map((w) => (w === "../.." ? id : w)))).code).not.toBe(0);
    expect(await store.listSchedules()).toEqual([]);
    expect(await readdir(repo)).toEqual([]);
    expect((await cli(bad.map((w) => (w === "../.." ? "daily-review" : w)))).code).toBe(0);
    expect((await stat(join(repo, ".factory", "notes", "daily-review"))).isDirectory()).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });

  it("refuses a grant on any other action, a URL off the sandbox and a repo in the state folder, storing nothing", async () => {
    const { store, cli } = await setup();
    expect((await cli([...ADD, "--grant", "notes"])).lines[0]).toContain("only a feedback schedule takes --grant");
    expect((await cli([...FEEDBACK, "--grant", "browser=https://example.com/"])).lines[0]).toContain("sandbox URL");
    expect((await cli([...FEEDBACK, "--grant", "repo=/home/me/app/.factory/x"])).lines[0]).toContain("state folder");
    expect(await stored(store)).toBeUndefined();
  });
});
