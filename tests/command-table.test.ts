// The one command table (issue #498; design 05-sources, "One command table"): every entry has a CLI form, a chat form
// and, for an item command, a dashboard command; SET_UP.md lists both forms as the table has them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, type TableCommand, chatCliArgv, chatCommandListMarkdown, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import { type CommandPhase, chatHelpReply, commandState } from "../src/core/commands.js";
import { CLI_TOP_WORDS, parseLocalCliArgs } from "../src/core/local-cli.js";
import { SETTINGS_TOP_WORDS, parseModeArgs, parseSettingsArgs } from "../src/settings-cmd.js";
import { APP_COMMANDS } from "../src/ui/commands.js";

/** A form with each placeholder filled: `<id>` an ID, a choice its first option, `[...]` dropped. */
function example(form: string): string {
  const fill: Record<string, string> = { "<id>": "wi_1", "<user_id>": "local:dev@example.com", "<key>": "max_loops", "<value>": "3" };
  return form
    .replace(/\[[^\]]*\]/g, "")
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => fill[w] ?? (w.includes("|") ? w.split("|")[0]! : w.startsWith("<") ? "words" : w))
    .join(" ");
}

/** What the CLI makes of the entry's usage, by the handler that owns its top word. */
function cliParse(c: TableCommand): { error: string } | object {
  const [word, ...args] = example(cliUsageOf(c)).split(" ");
  if ((SETTINGS_TOP_WORDS as readonly string[]).includes(word!)) return word === "mode" ? parseModeArgs(args) : parseSettingsArgs(args);
  if ((CLI_TOP_WORDS as readonly string[]).includes(word!)) return parseLocalCliArgs(word!, args);
  return { error: `no CLI handler takes ${word}` };
}

describe("the command table", () => {
  it("every entry has a CLI form: a handler takes its top word and parses its usage", () => {
    for (const c of COMMAND_TABLE) expect({ name: c.name, r: cliParse(c) }).not.toMatchObject({ r: { error: expect.anything() } });
  });

  it("every entry has a chat form the chat parser reads back as that entry; a request is never parsed", () => {
    for (const c of COMMAND_TABLE) {
      expect(c.chat, c.name).not.toBe("");
      const parsed = parseChatCommand(example(c.chat));
      if (c.chat_args === "request") expect(parsed, c.name).toBeNull();
      else expect(parsed?.kind === "command" ? parsed.entry.name : null, c.name).toBe(c.name);
    }
  });

  it("a chat command stands for the CLI argv of the same command, the item ID coming from the thread", () => {
    for (const c of COMMAND_TABLE.filter((x) => x.chat_args !== "request" && !x.edge)) {
      const parsed = parseChatCommand(example(c.chat));
      if (parsed?.kind !== "command") throw new Error(c.name);
      const { word, args } = chatCliArgv(parsed, c.item ? "wi_1" : null);
      expect({ name: c.name, r: word === "settings" ? parseSettingsArgs(args) : parseLocalCliArgs(word, args) }).not.toMatchObject({ r: { error: expect.anything() } });
    }
  });

  it("every item command is a command the dashboard may send", () => {
    for (const c of COMMAND_TABLE.filter((x) => x.item)) expect(APP_COMMANDS, c.name).toContain(c.name);
  });

  it("SET_UP.md lists every chat form, exactly as the table has them", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(chatCommandListMarkdown());
    const listed = setup.split("\n").filter((l) => l.startsWith("- `@bot ")).map((l) => /^- `@bot ([^`]+)`/.exec(l)![1]);
    expect(listed).toEqual(COMMAND_TABLE.map((c) => c.chat));
  });
});

describe("parseChatCommand", () => {
  it("reads a form's words in any case, with an optional `/` unless the form shows one", () => {
    expect(parseChatCommand("List")).toMatchObject({ kind: "command", entry: { name: "task list" } });
    expect(parseChatCommand("/list")).toMatchObject({ kind: "command", entry: { name: "task list" } });
    expect(parseChatCommand("show wi_9")).toMatchObject({ kind: "command", entry: { name: "task show" }, args: ["wi_9"] });
    expect(parseChatCommand("users list")).toMatchObject({ kind: "command", entry: { name: "users list" } });
    expect(parseChatCommand("help")).toEqual({ kind: "help" });
    expect(parseChatCommand("/help")).toEqual({ kind: "help" });
  });

  it("an item command needs its `/` and keeps its text, the lines below included", () => {
    expect(parseChatCommand("/approve ship it\nand the docs")).toMatchObject({ kind: "command", entry: { name: "approve" }, text: "ship it\nand the docs" });
    expect(parseChatCommand("approve ship it")).toBeNull();
  });

  it("plain words that only start like a command are a request", () => {
    for (const t of ["list the open bugs", "show me the queue", "merge the two docs", "help me with the parser", "I would like you to implement a gate"]) {
      expect(parseChatCommand(t), t).toBeNull();
    }
  });

  it("a write refused in chat is read with any words, so it gets its refusal", () => {
    expect(parseChatCommand("settings set models {\"cheap\": \"haiku\"}")).toMatchObject({ kind: "command", entry: { name: "settings set", edge: true } });
    expect(parseChatCommand("mode auto")).toMatchObject({ kind: "command", entry: { name: "mode", edge: true } });
  });
});

describe("chat help", () => {
  const all = () => true;
  const reader = (w: string) => w === "anyone" || w === "submit_work";
  const at = (phase: CommandPhase) => {
    const s = commandState({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", change_ref: null });
    return { ...s, phase };
  };

  it("outside an item's thread: the reads and the request, no item command and no write refused in chat", () => {
    const r = chatHelpReply(all, null);
    for (const f of ["`list`", "`show <id>`", "`users list`", "`settings list`", "`<request in plain words>`", "`help`"]) expect(r).toContain(f);
    for (const f of ["/approve", "`merge`", "settings set", "users add", "`mode"]) expect(r).not.toContain(f);
  });

  it("in an item's thread: the item commands that apply in its state, for a sender whose role allows them", () => {
    const r = chatHelpReply(all, at("spec_pending"));
    expect(r).toContain("`/approve [notes]`");
    expect(r).toContain("`/revise <feedback>`");
    expect(r).not.toContain("`merge`");
    expect(r).not.toContain("<request in plain words>");
    expect(chatHelpReply(all, at("merge_pending"))).toContain("`merge`");
    expect(chatHelpReply(reader, at("spec_pending"))).not.toContain("/approve");
    expect(chatHelpReply(reader, at("spec_pending"))).toContain("`list`");
  });
});
