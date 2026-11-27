// `factory schedule …` argument parsing (design 08-schedules), including the Check a page flags.

import { describe, expect, it } from "vitest";
import { parseLocalCliArgs } from "../src/core/local-cli.js";
import { ADD, DAILY_PAGE, MERGE_PAGE } from "./helpers/schedule-cli.js";
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
