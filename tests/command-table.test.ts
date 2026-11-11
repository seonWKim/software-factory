// The one command table (issue #498; design 05-sources, "One command table"): every entry has a CLI form, a chat form
// and, for an item command, a dashboard command; SET_UP.md lists both forms as the table has them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, type TableCommand, chatCliArgv, chatCommandListMarkdown, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import {
  type CommandPhase, THREAD_BARE_COMMANDS, chatForm, chatHelpReply, commandSpec, commandState, parseComment, parseLink, withSlash,
} from "../src/core/commands.js";
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
    .map((w) => fill[w] ?? (w.includes("|") ? w.split("|")[0]!.replace(/^</, "") : w.startsWith("<") ? "words" : w))
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

  it("every entry has a chat form the chat parser reads back as that entry; a request is never parsed; a comment command is the comment's", () => {
    for (const c of COMMAND_TABLE) {
      expect(c.chat, c.name).not.toBe("");
      const parsed = parseChatCommand(example(c.chat));
      if (c.chat_args === "request") expect(parsed, c.name).toBeNull();
      else if (c.chat_args === "comment") {
        // Passed on as the comment command (its event, keyed on it), never stored as a CLI row from chat.
        expect(parsed, c.name).toBeNull();
        expect(parseComment(example(c.chat)), c.name).toMatchObject({ kind: "command", name: c.name });
      } else expect(parsed?.kind === "command" ? parsed.entry.name : null, c.name).toBe(c.name);
    }
  });

  it("verdict: a CLI item command for record_verdict, its chat form `/verdict`, the comment command's usage", () => {
    const verdict = COMMAND_TABLE.find((c) => c.name === "verdict");
    expect(verdict).toMatchObject({
      args: "<id> accept|changes|reject <none|minor|major|critical> <reason>", who: "record_verdict", group: "item", item: true, edge: false,
      chat: commandSpec("verdict").usage, chat_args: "comment",
    });
    // In the table after the other comment item commands, before the local merge.
    const names = COMMAND_TABLE.map((c) => c.name);
    expect(names.indexOf("verdict")).toBeGreaterThan(names.indexOf("resolve"));
    expect(names.indexOf("verdict")).toBeLessThan(names.indexOf("merge"));
    expect(CLI_TOP_WORDS).toContain("verdict");
  });

  it("a chat command stands for the CLI argv of the same command, the item ID coming from the thread", () => {
    for (const c of COMMAND_TABLE.filter((x) => x.chat_args !== "request" && x.chat_args !== "comment" && !x.edge)) {
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
    expect(listed).toEqual(COMMAND_TABLE.map((c) => c.chat.replace(/^\//, "")));
    expect(listed.filter((l) => l!.startsWith("/"))).toEqual([]);
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

  it("an item command keeps its text, the lines below included; in an item's thread its bare word is read with its `/`", () => {
    expect(parseChatCommand("/approve ship it\nand the docs")).toMatchObject({ kind: "command", entry: { name: "approve" }, text: "ship it\nand the docs" });
    // In an item's thread (the Slack source adds the `/`): the same command, with the same text, as the slash form.
    const inThread = (t: string) => withSlash(t, THREAD_BARE_COMMANDS) ?? t;
    for (const t of ["approve ship it", "Approve, but fix the tests", "retry", "revise narrower\nscope", "reject duplicate emails", "resolve keep ours", "merge"]) {
      expect(parseChatCommand(inThread(t)), t).toEqual(parseChatCommand(`/${t}`));
      expect(parseChatCommand(inThread(t)), t).toMatchObject({ kind: "command" });
    }
    // The commands the table lacks are read by the comment parser, and `link` by its own, the same way.
    for (const t of ["budget 50000", "verdict accept none fine", "standing accept spec-t1"]) {
      expect(parseComment(inThread(t)), t).toEqual(parseComment(`/${t}`));
      expect(parseComment(inThread(t)), t).toMatchObject({ kind: "command" });
    }
    expect(parseLink(inThread("link abc123"))).toBe("abc123");
    // `help` is read bare anywhere, never given a slash; other words are not commands.
    for (const t of ["help me with the parser", "approved it", "please approve", "/approve"]) expect(withSlash(t, THREAD_BARE_COMMANDS), t).toBeNull();
    // Outside an item's thread nothing adds the slash: a bare item command is a request in plain words.
    expect(parseChatCommand("approve ship it")).toBeNull();
    expect(parseChatCommand("reject duplicate emails")).toBeNull();
  });

  it("chatForm shows every command without its `/`, and leaves other text alone", () => {
    expect(chatForm("- `/approve +paths <path>...` and `/verdict accept` alone; a `/revise` or `/reject`")).toBe(
      "- `approve +paths <path>...` and `verdict accept` alone; a `revise` or `reject`",
    );
    expect(chatForm("/help")).toBe("help");
    expect(chatForm("src/approve.ts and `factory link-code <user_id>` and /unknown")).toBe("src/approve.ts and `factory link-code <user_id>` and /unknown");
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
    for (const f of ["approve", "`merge`", "settings set", "users add", "`mode"]) expect(r).not.toContain(f);
    expect(r).toContain("e.g. `@software-factory help`");
  });

  it("in an item's thread: the item commands that apply in its state, for a sender whose role allows them", () => {
    const r = chatHelpReply(all, at("spec_pending"));
    expect(r).toContain("`approve [notes]`");
    expect(r).toContain("`revise <feedback>`");
    // No slash form anywhere in the reply: the usages, the descriptions and the example.
    expect(r).not.toMatch(/(^|[\s`(])\/[a-z]/);
    expect(r).not.toContain("`merge`");
    expect(r).not.toContain("<request in plain words>");
    expect(chatHelpReply(all, at("merge_pending"))).toContain("`merge`");
    expect(chatHelpReply(reader, at("spec_pending"))).not.toContain("approve");
    expect(chatHelpReply(reader, at("spec_pending"))).toContain("`list`");
  });
});
