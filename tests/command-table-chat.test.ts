// The chat parser, chat help and /revise checks (split from command-table.test.ts, no test changed).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, parseChatCommand } from "../src/core/command-table.js";
import { type CommandPhase, THREAD_BARE_COMMANDS, chatForm, chatHelpReply, commandState, parseComment, parseLink, withSlash } from "../src/core/commands.js";

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
