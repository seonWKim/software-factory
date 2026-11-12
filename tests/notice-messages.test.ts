// Replies under a notice (design 05-sources, "Replies under a notice"): the reading and routing of
// src/impl/source/slack-notice-replies.ts on a fake store and fake hooks. No Slack, model or GitHub call.

import { describe, expect, it } from "vitest";
import type { ChatCommand } from "../src/core/command-table.js";
import { chatForm, commandState, commandsFor } from "../src/core/commands.js";
import type { SourceRef, WorkItem } from "../src/core/types.js";
import type { NoticeMessage, NoticeQuestion } from "../src/interfaces/factory-store.js";
import { type ChatAnswer, UNLINKED } from "../src/impl/source/slack-commands.js";
import {
  ACTION_NOTICE_ITEM, NAMES_NO_ITEM, type NoticeDeps, NoticeReplies, noticeCommand, noticeCommandsReply, noticeReplyId, noticeThreadOf, threadWords,
  whichItemMessage,
} from "../src/impl/source/slack-notice-replies.js";
import { slackSourceId } from "../src/impl/source/slack-source.js";

const LISTED = "C0LISTED";
const NOTICES = "C0NOTICES";
const item = (id: string, over: Partial<WorkItem> = {}) =>
  ({ id, title: `Title ${id}`, source: { type: "local", id: `local-${id}`, link: `local:${id}` }, stage: "NEW", blocked_on: "human", blocked_reason: "spec_pending", change_ref: null, ...over }) as unknown as WorkItem;

function fake(opts: { notices?: NoticeMessage[]; linked?: boolean; items?: WorkItem[]; notify_channel?: string } = {}) {
  const questions: Omit<NoticeQuestion, "created_at">[] = [];
  const calls: { kind: "chat" | "reply" | "post"; source: string; id?: string; item?: string | null; cmd?: ChatCommand; answer?: ChatAnswer; marker?: string; text?: string }[] = [];
  const items = new Map<string, WorkItem>((opts.items ?? []).map((i) => [i.id, i]));
  const store = {
    getNoticeMessage: async (channel: string, ts: string) => opts.notices?.find((n) => n.channel === channel && n.ts === ts) ?? null,
    recordNoticeQuestion: async (q: Omit<NoticeQuestion, "created_at">) => (questions.push(q), true),
    getNoticeQuestion: async (id: string) => {
      const q = questions.find((x) => x.id === id);
      return q ? { ...q, created_at: "2026-11-12T00:00:00.000Z" } : null;
    },
    resolveLink: async () => (opts.linked === false ? null : "github:1"),
    getWorkItem: async (id: string) => items.get(id) ?? null,
  } as unknown as NoticeDeps["store"];
  const r = new NoticeReplies({ channels: [LISTED], store, ...(opts.notify_channel ? { notify_channel: opts.notify_channel } : {}) }, {
    chat: async (cmd, source, _user, id, it) => (calls.push({ kind: "chat", source: source.id, id, item: it?.id ?? null, cmd }), null),
    reply: async (source, answer, id) => (calls.push({ kind: "reply", source: source.id, id, answer }), null),
    post: async (source, render, marker) => calls.push({ kind: "post", source: source.id, marker, text: render().text }),
  });
  return { r, calls, questions };
}

const notice = (ids: string[], channel = LISTED, ts = "1800000000.000100"): NoticeMessage => ({ channel, ts, work_item_ids: ids, created_at: "2026-11-12T00:00:00.000Z" as NoticeMessage["created_at"] });
const at = (over: Partial<{ channel: string; thread_ts: string; user: string; id: string }> = {}) =>
  ({ team: "T0TEAM", channel: LISTED, thread_ts: "1800000000.000100", user: "U0ALICE", id: "Ev01", ...over });
const thread = (channel = LISTED, ts = "1800000000.000100") => slackSourceId({ team: "T0TEAM", channel, thread_ts: ts });

describe("notice replies: reading the words", () => {
  it('"go ahead and merge" is `merge` as the whole reply, in any case, with an optional end mark', () => {
    for (const s of ["go ahead and merge", "Go Ahead And Merge", " GO AHEAD AND MERGE. ", "go ahead and merge!"]) expect(threadWords(s), s).toBe("merge");
    for (const s of ["go ahead and merge it", "please go ahead and merge", "go ahead"]) expect(threadWords(s), s).not.toBe("merge");
  });

  it("a bare command word gets its slash, as in an item's thread; other words stay as typed", () => {
    expect(threadWords("revise narrower scope")).toBe("/revise narrower scope");
    expect(threadWords("approve")).toBe("/approve");
    expect(threadWords("please build it")).toBe("please build it");
  });

  it("noticeCommand reads each command form as the item thread reads it; words with no command and /link are none", () => {
    const name = (s: string) => {
      const c = noticeCommand(s);
      return c?.kind === "command" ? [c.entry.name, c.text] : c?.kind ?? null;
    };
    expect(name("merge")).toEqual(["merge", ""]);
    expect(name("go ahead and merge")).toEqual(["merge", ""]);
    expect(name("approve")).toEqual(["approve", ""]);
    expect(name("retry")).toEqual(["retry", ""]);
    expect(name("revise narrower scope")).toEqual(["revise", "narrower scope"]);
    expect(name("/revise narrower scope")).toEqual(["revise", "narrower scope"]);
    expect(name("reject duplicate")).toEqual(["reject", "duplicate"]);
    expect(name("resolve")).toEqual(["resolve", ""]);
    expect(name("help")).toBe("help");
    expect(name("please build a dashboard")).toBeNull();
    expect(name("/link abc123")).toBeNull();
  });
});

describe("notice replies: the answer's thread", () => {
  it("a reply's ID carries the notice, so a marker keyed on its stored command names the notice's thread", () => {
    const id = noticeReplyId("C0NOTICES", "1800000000.000100", "Ev01");
    const item = { type: "slack_thread", id: thread(LISTED, "1800000009.000100"), link: "x" } as SourceRef;
    expect(noticeThreadOf(`<!-- factory:refused:cli:slack-${id} -->`, item)?.id).toBe(thread("C0NOTICES"));
    expect(noticeThreadOf("<!-- factory:refused:cli:slack-Ev01 -->", item)).toBeNull();
    expect(noticeThreadOf(`<!-- factory:refused:cli:slack-${id} -->`, { type: "local", id: "local-1", link: "local:1" })).toBeNull();
  });
});

describe("notice replies: messages", () => {
  it("the which-item question has one button per item, its value the item ID, its block the question", () => {
    const m = whichItemMessage([item("wi_a"), item("wi_b", { title: "x".repeat(200) })], "Ev01");
    const actions = m.blocks[1] as { type: string; block_id: string; elements: { action_id: string; value: string; text: { text: string } }[] };
    expect(actions.block_id).toBe(`${ACTION_NOTICE_ITEM}:Ev01`);
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([[`${ACTION_NOTICE_ITEM}:0`, "wi_a"], [`${ACTION_NOTICE_ITEM}:1`, "wi_b"]]);
    expect(actions.elements[1]!.text.text).toHaveLength(75);
    expect(m.text).toContain("Nothing runs until you press one");
  });

  it("the no-command reply names the commands each item takes now, and merge for a local item", () => {
    const text = noticeCommandsReply([item("wi_a"), item("wi_b", { source: { type: "slack_thread", id: "s", link: "l" } })]);
    const [head, a, b] = text.split("\n");
    expect(head).toContain("names no command");
    const now = commandsFor(commandState(item("wi_a"))).map((c) => `\`${chatForm(c.usage)}\``).join(", ");
    expect(a).toBe(`- Title wi_a: ${now}, \`merge\`, \`go ahead and merge\``);
    expect(a).toContain("`go ahead and merge`");
    expect(b).not.toContain("merge");
  });
});

describe("notice replies: routing", () => {
  it("a thread in a listed channel with no record is no notice: today's reading (undefined)", async () => {
    const f = fake();
    expect(await f.r.reply(at(), "go ahead and merge")).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it("one item: the command runs on it, with the notice in its ID, answered in the notice's thread", async () => {
    const f = fake({ notices: [notice(["wi_a"])], items: [item("wi_a")] });
    expect(await f.r.reply(at(), "go ahead and merge")).toBeNull();
    expect(f.calls).toMatchObject([{ kind: "chat", source: thread(), item: "wi_a", id: noticeReplyId(LISTED, "1800000000.000100", "Ev01") }]);
  });

  it("several items: the reply's words are stored and one which-item question is posted; nothing runs", async () => {
    const f = fake({ notices: [notice(["wi_a", "wi_b"])], items: [item("wi_a"), item("wi_b")] });
    await f.r.reply(at(), "approve");
    expect(f.questions).toEqual([{ id: "Ev01", channel: LISTED, notice_ts: "1800000000.000100", text: "approve" }]);
    expect(f.calls).toMatchObject([{ kind: "post", source: thread(), marker: "<!-- factory:notice-which:Ev01 -->" }]);
  });

  it("a press runs the stored words on the chosen item; a press for another notice, an item not named or an unknown question runs nothing", async () => {
    const f = fake({ notices: [notice(["wi_a", "wi_b"]), notice(["wi_a"], LISTED, "1800000000.000900")], items: [item("wi_a"), item("wi_b")] });
    await f.r.reply(at(), "revise narrower scope");
    const block = `${ACTION_NOTICE_ITEM}:Ev01`;
    await f.r.press(at({ id: "P1", thread_ts: "1800000000.000900" }), block, "wi_a");
    await f.r.press(at({ id: "P2" }), block, "wi_c");
    await f.r.press(at({ id: "P3" }), `${ACTION_NOTICE_ITEM}:Ev99`, "wi_a");
    await f.r.press(at({ id: "P4" }), null, "wi_a");
    expect(f.calls.filter((c) => c.kind === "chat")).toEqual([]);
    await f.r.press(at({ id: "P5", user: "U0BOB" }), block, "wi_b");
    const [run] = f.calls.filter((c) => c.kind === "chat");
    expect(run).toMatchObject({ source: thread(), item: "wi_b", id: noticeReplyId(LISTED, "1800000000.000100", "P5") });
    expect(run!.cmd).toMatchObject({ kind: "command", text: "narrower scope" });
  });

  it("an unlinked account gets the usual refusal and nothing is stored", async () => {
    const f = fake({ notices: [notice(["wi_a", "wi_b"])], items: [item("wi_a"), item("wi_b")], linked: false });
    await f.r.reply(at(), "approve");
    expect(f.calls).toEqual([{ kind: "reply", source: thread(), id: "Ev01", answer: { markdown: UNLINKED } }]);
    expect(f.questions).toEqual([]);
  });

  it("a notice that names no item (a summary, or items gone) gets one reply saying so", async () => {
    const f = fake({ notices: [notice([]), notice(["wi_gone"], LISTED, "1800000000.000200")] });
    await f.r.reply(at(), "approve");
    await f.r.reply(at({ thread_ts: "1800000000.000200", id: "Ev02" }), "approve");
    expect(f.calls.map((c) => c.answer)).toEqual([{ markdown: NAMES_NO_ITEM }, { markdown: NAMES_NO_ITEM }]);
  });

  it("no command word: one reply naming the commands, nothing stored", async () => {
    const f = fake({ notices: [notice(["wi_a"])], items: [item("wi_a")] });
    await f.r.reply(at(), "what is this about?");
    expect(f.calls).toEqual([{ kind: "reply", source: thread(), id: "Ev01", answer: { markdown: noticeCommandsReply([item("wi_a")]) } }]);
    expect(f.questions).toEqual([]);
  });

  it("the notices channel outside slack.channels is read for notice replies only; a thread there with no record names no item", async () => {
    const f = fake({ notify_channel: NOTICES, notices: [notice(["wi_a"], NOTICES)], items: [item("wi_a")] });
    expect([f.r.reads(LISTED), f.r.reads(NOTICES), f.r.reads("C0ELSE")]).toEqual([true, true, false]);
    await f.r.reply(at({ channel: NOTICES }), "merge");
    await f.r.reply(at({ channel: NOTICES, thread_ts: "1700000000.000100", id: "Ev02" }), "merge");
    expect(f.calls.map((c) => [c.kind, c.source])).toEqual([["chat", thread(NOTICES)], ["reply", thread(NOTICES, "1700000000.000100")]]);
    expect(f.calls[1]!.answer).toEqual({ markdown: NAMES_NO_ITEM });
    expect(await f.r.press(at({ channel: "C0ELSE" }), `${ACTION_NOTICE_ITEM}:Ev01`, "wi_a")).toBeNull();
  });
});
