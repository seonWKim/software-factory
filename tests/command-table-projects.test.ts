// The task project commands of the command table (split from command-table.test.ts, no test changed).

import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, chatCliArgv, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import { CLI_TOP_WORDS, parseLocalCliArgs } from "../src/core/local-cli.js";

describe("the command table", () => {
  it("the task project commands are in the table, in order, each for anyone who may submit work, and `task list --project` takes a project slug", () => {
    const usages = ["project create <name>", "project list [--archived]", "project rename <slug> <name>", "project archive <slug>", "project restore <slug>", "project delete <slug>"];
    const named = COMMAND_TABLE.map(cliUsageOf);
    const at = usages.map((u) => named.indexOf(u));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const u of [...usages, "task project <task_id> [-<from>] +<slug>|-<slug>"]) {
      expect(COMMAND_TABLE.find((c) => cliUsageOf(c) === u), u).toMatchObject({ who: "submit_work", item: false, edge: false });
    }
    expect(CLI_TOP_WORDS).toContain("project");
    expect(cliUsageOf(COMMAND_TABLE.find((c) => c.name === "task list")!)).toBe("task list [--project <project_slug>]");
    expect(parseChatCommand("project archive home")).toMatchObject({ kind: "command", entry: { name: "project archive" }, args: ["home"] });
    expect(parseChatCommand("task project tk_1 -home")).toMatchObject({ kind: "command", entry: { name: "task project" }, args: ["tk_1", "-home"] });
    const move = parseChatCommand("task project tk_1 -home +work");
    expect(move).toMatchObject({ kind: "command", entry: { name: "task project", who: "submit_work" }, args: ["tk_1", "-home", "+work"] });
    if (move?.kind !== "command") throw new Error("task project");
    expect(parseLocalCliArgs(...Object.values(chatCliArgv(move, null)) as [string, string[]])).toEqual({ action: "task_move", id: "tk_1", from: "home", to: "work" });
  });
});
