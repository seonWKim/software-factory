// `factory schedule add`, `list` and `edit` (design 08-schedules), and their Check a page forms.

import { describe, expect, it } from "vitest";
import { ADD, DAILY_PAGE, FIRST, HOUR, MERGE_PAGE, OWNER, page, setup, stored } from "./helpers/schedule-cli.js";
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
