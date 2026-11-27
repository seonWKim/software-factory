// The one command table (issue #498; design 05-sources, "One command table"): every entry has a CLI form, a chat form
// and, for an item command, a dashboard command; SET_UP.md lists both forms as the table has them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, SENTENCE_FORM, type TableCommand, chatCliArgv, chatCommandListMarkdown, cliUsageOf, parseChatCommand } from "../src/core/command-table.js";
import { type CommandPhase, THREAD_BARE_COMMANDS, chatForm, chatHelpReply, commandState, parseComment, parseLink, withSlash } from "../src/core/commands.js";
import { CLI_TOP_WORDS, parseLocalCliArgs, parseSentence } from "../src/core/local-cli.js";
import { SETTINGS_TOP_WORDS, parseModeArgs, parseSettingsArgs } from "../src/settings-cmd.js";
import { APP_COMMANDS } from "../src/ui/commands.js";
import RUN_NEXT from "../src/cli/handlers/run-next/run-next.command.js";
import { REGISTRY } from "../src/api/index.js";

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

  it("every entry declares reversible as true or false, and the reversible ones are exactly the twelve that can be undone (design 08-permissions)", () => {
    for (const c of COMMAND_TABLE) expect(typeof c.reversible, c.name).toBe("boolean");
    expect(COMMAND_TABLE.filter((c) => c.reversible).map((c) => c.name).sort()).toEqual([
      "mode", "project archive", "project rename", "project restore", "run-next", "schedule pause", "schedule resume",
      "settings reset", "settings set", "task done", "task project", "task reopen",
    ]);
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

/** The capability an entry maps to: `<noun> <verb>` is `<noun>s.<verb>` (`schedule list` is `schedules.list`). */
const capabilityOf = (name: string): string | null => {
  const [noun, ...verb] = name.split(" ");
  return verb.length === 0 ? null : `${noun}s.${verb.join("-")}`;
};

/** The command-table entries with no capability yet (design 09-api-registry): each moves off this list when declared. */
const NO_CAPABILITY: readonly string[] = [
  "task create", "task add", "task done", "task reopen", "task edit", "task delete", "task sub", "task build", "task list", "task project",
  "project create", "project list", "project rename", "project archive", "project restore", "project delete", "task show",
  "approve", "retry", "revise", "reject", "resolve", "task paths", "task note", "hold", "verdict", "merge", "run-next", SENTENCE_FORM, "confirm",
  "settings list", "settings set", "settings reset", "settings history", "mode",
];

describe("the command table and the API registry", () => {
  const ids = new Set(REGISTRY.capabilities.map((c) => c.id));
  const declared = (name: string) => { const id = capabilityOf(name); return id !== null && ids.has(id); };

  it("every entry has a capability (`schedule <verb>` is `schedules.<verb>`) or is on the exceptions list", () => {
    for (const c of COMMAND_TABLE) expect({ name: c.name, ok: declared(c.name) || NO_CAPABILITY.includes(c.name) }).toEqual({ name: c.name, ok: true });
    for (const c of COMMAND_TABLE.filter((x) => x.group === "schedule")) expect(declared(c.name), c.name).toBe(true);
  });

  it("the exceptions list names only table entries with no capability", () => {
    const names = COMMAND_TABLE.map((c) => c.name);
    for (const n of NO_CAPABILITY) expect({ n, entry: names.includes(n), capability: declared(n) }).toEqual({ n, entry: true, capability: false });
  });
});

describe("parseChatCommand", () => {
  it("reads a form's words in any case, with an optional `/` unless the form shows one", () => {
    expect(parseChatCommand("List")).toMatchObject({ kind: "command", entry: { name: "task list" } });
    expect(parseChatCommand("/list")).toMatchObject({ kind: "command", entry: { name: "task list" } });
    expect(parseChatCommand("show wi_9")).toMatchObject({ kind: "command", entry: { name: "task show" }, args: ["wi_9"] });
    expect(parseChatCommand("users list")).toBeNull();
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
    // The commands the table lacks, and its comment forms (`verdict`), are read by the comment parser, and `link` by its own, the same way.
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
    for (const f of ["`list`", "`show <id>`", "`settings list`", "`<request in plain words>`", "`help`"]) expect(r).toContain(f);
    for (const f of ["approve", "`merge`", "settings set", "users", "`mode"]) expect(r).not.toContain(f);
    expect(r).toContain("e.g. `@software-factory help`");
  });

  it("leaves the schedule commands out, as the reply's first Slack section is full; SET_UP.md lists their chat forms", () => {
    expect(chatHelpReply(all, null)).not.toContain("schedule");
    expect(chatHelpReply(all, at("spec_pending"))).not.toContain("schedule");
  });

  it("in an item's thread: the item commands that apply in its state, for the owner", () => {
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

describe("/revise adds context on a New or in-triage item (design 02-attachments)", () => {
  it("its table row says so, and SET_UP.md's CLI list has the row as the table has it", () => {
    const revise = COMMAND_TABLE.find((c) => c.name === "revise")!;
    expect(revise.does).toMatch(/^Store `\/revise` for the item; on a New or in-triage item it adds context, queued for one re-triage/);
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(`- \`factory revise <id> <feedback>\`: ${revise.does}.`);
  });
});
