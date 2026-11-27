// The schedule commands of the command table (split from command-table.test.ts, no test changed).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, chatCliArgv, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import { CLI_TOP_WORDS, parseLocalCliArgs } from "../src/core/local-cli.js";

describe("the command table", () => {
  it("the seven schedule commands are in the table, in order, the owner's, each with a chat form the CLI parses back", () => {
    const names = ["list", "add", "edit", "pause", "resume", "run", "runs"].map((v) => `schedule ${v}`);
    const at = names.map((n) => COMMAND_TABLE.findIndex((c) => c.name === n));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const n of names) expect(COMMAND_TABLE[at[names.indexOf(n)]!], n).toMatchObject({ who: "owner", group: "schedule", item: false, edge: false });
    expect(CLI_TOP_WORDS).toContain("schedule");
    expect(parseChatCommand("schedule list")).toMatchObject({ kind: "command", entry: { name: "schedule list" } });
    expect(parseChatCommand("schedule list now")).toBeNull();
    const pause = parseChatCommand("schedule pause sch_1");
    if (pause?.kind !== "command") throw new Error("schedule pause");
    expect(parseLocalCliArgs(...Object.values(chatCliArgv(pause, null)) as [string, string[]])).toEqual({ action: "schedule", command: { verb: "pause", id: "sch_1", fields: {} } });
    const edit = parseChatCommand("schedule edit sch_1 --title Nightly --missed skip");
    if (edit?.kind !== "command") throw new Error("schedule edit");
    expect(parseLocalCliArgs(...Object.values(chatCliArgv(edit, null)) as [string, string[]])).toEqual({
      action: "schedule", command: { verb: "edit", id: "sch_1", fields: { title: "Nightly", missed: "skip" } },
    });
    // The old flag is refused in the chat form too.
    const old = parseChatCommand("schedule edit sch_1 --skip-when-busy on");
    if (old?.kind !== "command") throw new Error("schedule edit --skip-when-busy");
    expect(parseLocalCliArgs(...Object.values(chatCliArgv(old, null)) as [string, string[]])).toMatchObject({ error: expect.stringContaining("unexpected \"--skip-when-busy\"") });
  });

  it("schedule usage shows --missed on add and edit, --run-now on add only, and no --skip-when-busy", () => {
    const usage = (verb: string): string => cliUsageOf(COMMAND_TABLE.find((c) => c.name === `schedule ${verb}`)!);
    expect(usage("add")).toContain("[--missed catch-up|skip] [--run-now on|off]");
    expect(usage("edit")).toContain("[--missed catch-up|skip]");
    expect(usage("edit")).not.toContain("--run-now");
    const schedules = COMMAND_TABLE.filter((c) => c.group === "schedule");
    for (const c of schedules) expect(`${cliUsageOf(c)} ${c.prints}`, c.name).not.toMatch(/skip-when-busy|skip when busy/);
    expect(COMMAND_TABLE.find((c) => c.name === "schedule list")!.prints).toContain("missed rule");
    const setUp = readFileSync("SET_UP.md", "utf8");
    expect(setUp).not.toContain("--skip-when-busy");
    for (const c of schedules.filter((s) => ["schedule add", "schedule edit"].includes(s.name))) expect(setUp).toContain(cliUsageOf(c));
  });

  it("schedule draft and improve follow delete, the owner's, with no chat form, and SET_UP.md's CLI list has both", () => {
    const names = ["delete", "draft", "improve"].map((v) => `schedule ${v}`);
    const at = names.map((n) => COMMAND_TABLE.findIndex((c) => c.name === n));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    for (const n of names.slice(1)) {
      const c = COMMAND_TABLE.find((x) => x.name === n)!;
      expect(c, n).toMatchObject({ who: "owner", group: "schedule", chat_args: "no_chat", chat: "", item: false, edge: false });
      expect(setup).toContain(`- \`factory ${n} ${c.args}\`: ${c.does}.`);
      expect(parseChatCommand(n)).toBeNull();
    }
  });
});
