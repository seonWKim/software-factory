// The one command table (issue #498; design 05-sources, "One command table"): every entry has a CLI form, a chat form
// and, for an item command, a dashboard command; SET_UP.md lists both forms as the table has them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, SENTENCE_FORM, type TableCommand, chatCliArgv, chatCommandListMarkdown, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import { THREAD_BARE_COMMANDS, chatHelpReply, commandState, parseComment, withSlash } from "../src/core/commands.js";
import { CLI_TOP_WORDS, parseLocalCliArgs, parseSentence } from "../src/core/local-cli.js";
import { SETTINGS_TOP_WORDS, parseModeArgs, parseSettingsArgs } from "../src/settings-cmd.js";
import { APP_COMMANDS } from "../src/ui/commands.js";
import RUN_NEXT from "../src/cli/handlers/run-next/run-next.command.js";

/** The flags a `schedule add` or `schedule edit` chat form's `<flags>` stands for. */
const SCHEDULE_FLAGS = "--title Feedback --cadence daily --spec 09:00 --zone Asia/Seoul --action build";

/** A form with each placeholder filled: `<id>` an ID, a choice (`a|b` or `<a|b>`) its first option, `[...]` dropped. */
function example(form: string): string {
  const flags = form.startsWith("schedule add") ? `--id sch_1 ${SCHEDULE_FLAGS}` : SCHEDULE_FLAGS;
  const fill: Record<string, string> = { "<id>": "wi_1", "<user_id>": "local:dev@example.com", "<key>": "max_loops", "<value>": "3", "<flags>": flags };
  return form
    .replace(/\[[^\]]*\]/g, "")
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => fill[w] ?? (w.includes("|") ? w.replace(/^<|>$/g, "").split("|")[0]! : w.startsWith("<") ? "words" : w))
    .join(" ");
}

/** What the CLI makes of the entry's usage, by the handler that owns its top word; the sentence form, of words typed in its place. */
function cliParse(c: TableCommand): { error: string } | object {
  if (c.group === "sentence") return parseSentence(["approve", "the", "spec"]);
  const [word, ...args] = example(cliUsageOf(c)).split(" ");
  if (c.group === "queue") return RUN_NEXT.names.includes(word!) && args.length === 1 ? {} : { error: `the run-next handler does not take ${word}` };
  if ((SETTINGS_TOP_WORDS as readonly string[]).includes(word!)) return word === "mode" ? parseModeArgs(args) : parseSettingsArgs(args);
  if ((CLI_TOP_WORDS as readonly string[]).includes(word!)) return parseLocalCliArgs(word!, args);
  return { error: `no CLI handler takes ${word}` };
}

describe("the command table", () => {
  it("every entry has a CLI form: a handler takes its top word and parses its usage", () => {
    for (const c of COMMAND_TABLE) expect({ name: c.name, r: cliParse(c) }).not.toMatchObject({ r: { error: expect.anything() } });
  });

  it("every entry but a no_chat one has a chat form the chat parser reads back as that entry; a request is never parsed; a comment form is the comment parser's", () => {
    for (const c of COMMAND_TABLE.filter((x) => x.chat_args !== "no_chat")) {
      expect(c.chat, c.name).not.toBe("");
      const parsed = parseChatCommand(example(c.chat));
      if (c.chat_args === "request") expect(parsed, c.name).toBeNull();
      else if (c.chat_args === "comment") {
        expect(parsed, c.name).toBeNull();
        expect(parseComment(example(c.chat)), c.name).toMatchObject({ kind: "command", name: c.name });
      } else expect(parsed?.kind === "command" ? parsed.entry.name : null, c.name).toBe(c.name);
    }
  });

  it("`run-next` is a CLI and item-page command with no chat access: no chat form, never parsed from chat, in no chat list", () => {
    const entry = COMMAND_TABLE.find((c) => c.name === "run-next");
    expect(entry).toMatchObject({ group: "queue", item: true, who: "approve_spec", chat: "", chat_args: "no_chat", edge: false });
    expect(APP_COMMANDS).toContain("run-next");
    for (const t of ["run-next wi_1", "/run-next wi_1", "/run-next", withSlash("run-next", THREAD_BARE_COMMANDS) ?? "run-next"]) expect(parseChatCommand(t), t).toBeNull();
    expect(chatCommandListMarkdown()).not.toContain("run-next");
    const thread = commandState({ stage: "READY", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
    for (const state of [null, thread]) expect(chatHelpReply(() => true, state)).not.toContain("run-next");
  });

  it("`verdict` is a table entry whose chat form stays on the comment path, also bare in an item's thread", () => {
    const entry = COMMAND_TABLE.find((c) => c.name === "verdict");
    expect(entry).toMatchObject({ group: "item", item: true, who: "approve_spec", chat_args: "comment" });
    const inThread = withSlash("verdict accept none fine", THREAD_BARE_COMMANDS)!;
    expect(parseChatCommand(inThread)).toBeNull();
    expect(parseComment(inThread)).toEqual({ kind: "command", name: "verdict", text: "accept none fine" });
  });

  it("a chat command stands for the CLI argv of the same command, the item ID coming from the thread", () => {
    for (const c of COMMAND_TABLE.filter((x) => !["request", "comment", "no_chat"].includes(x.chat_args) && !x.edge)) {
      const parsed = parseChatCommand(example(c.chat));
      if (parsed?.kind !== "command") throw new Error(c.name);
      const { word, args } = chatCliArgv(parsed, c.item ? "wi_1" : null);
      expect({ name: c.name, r: word === "settings" ? parseSettingsArgs(args) : parseLocalCliArgs(word, args) }).not.toMatchObject({ r: { error: expect.anything() } });
    }
  });

  it("the sentence form and `confirm` each have a CLI form and a chat form", () => {
    const sentence = COMMAND_TABLE.find((c) => c.name === SENTENCE_FORM)!;
    expect(sentence).toMatchObject({ group: "sentence", chat_args: "request", item: false, edge: false });
    expect(cliUsageOf(sentence)).toBe(SENTENCE_FORM);
    expect(parseChatCommand("confirm prop_ab12")).toMatchObject({ kind: "command", entry: { name: "confirm" }, args: ["prop_ab12"] });
    const confirm = parseChatCommand("confirm prop_ab12");
    if (confirm?.kind !== "command") throw new Error("confirm");
    expect(parseLocalCliArgs(...Object.values(chatCliArgv(confirm, null)) as [string, string[]])).toEqual({ action: "confirm", proposal: "prop_ab12" });
    // Words that only start like it are no confirm.
    expect(parseChatCommand("confirm the release date")).toBeNull();
  });


  it("every item command is a command the dashboard may send", () => {
    for (const c of COMMAND_TABLE.filter((x) => x.item)) expect(APP_COMMANDS, c.name).toContain(c.name);
  });

  it("SET_UP.md lists every chat form, exactly as the table has them", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(chatCommandListMarkdown());
    const listed = setup.split("\n").filter((l) => l.startsWith("- `@bot ")).map((l) => /^- `@bot ([^`]+)`/.exec(l)![1]);
    expect(listed).toEqual(COMMAND_TABLE.filter((c) => c.chat_args !== "no_chat").map((c) => c.chat.replace(/^\//, "")));
    expect(listed.filter((l) => l!.startsWith("/"))).toEqual([]);
  });
});
