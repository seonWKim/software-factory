// Replies under a notice (design 05-sources, "Replies under a notice"; docs/plugins/source-adapter.md, `slack`). A
// notice is one top-level message in the notices channel; its record (channel, ts and the work item IDs its lines
// name) is written when it posts. A reply in its thread, after a mention or with a slash, is read as in an item's own
// thread and acts on the items the record names: one item runs the command, several get a which-item question with
// one button per item (the reply's words stored until a press), none gets one reply saying so. Only the linked owner's
// replies run anything; no reply here creates a work item. A command's answer posts in the notice's thread: the reply's
// ID carries the notice's channel and ts (`noticeReplyId`), so the controller's answer, keyed on the stored command,
// is posted there too (`noticeThreadOf`).

import { type ChatCommand, parseChatCommand } from "../../core/command-table.js";
import { THREAD_BARE_COMMANDS, chatForm, commandState, commandsFor, parseLink, withSlash } from "../../core/commands.js";
import { LOCAL_SOURCE } from "../../core/local-merge.js";
import type { SourceRef, WorkItem, WorkItemId } from "../../core/types.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import { type ChatAnswer, type ChatStore, UNLINKED } from "./slack-commands.js";
import { type SlackRendered, button, escapeSlack } from "./slack-format.js";
import { type SlackThread, parseSlackSourceId, threadRef } from "./slack-thread.js";

/** A which-item button's action ID, `sf_notice_item:<n>`; its actions block's ID is `sf_notice_item:<question id>`. */
export const ACTION_NOTICE_ITEM = "sf_notice_item";
/** Slack's limits: buttons in one actions block, characters in a button's label. */
const MAX_BUTTONS = 25;
const LABEL_MAX = 75;

/** The fixed phrase (design 04-gate-commands): the whole reply after the mention, in any case, is `merge`. */
const GO_AHEAD = /^go ahead and merge[.!]?$/i;

/** A mention's words in an item's thread or under a notice: the fixed phrase is `merge`, a bare command word gets its `/`. */
export function threadWords(said: string): string {
  return GO_AHEAD.test(said.trim()) ? "merge" : (withSlash(said, THREAD_BARE_COMMANDS) ?? said);
}

/** The chat command a reply under a notice names, read as in an item's thread; null when it names none (`/link` too). */
export function noticeCommand(said: string): ChatCommand | null {
  const typed = threadWords(said);
  return parseLink(typed) === null ? parseChatCommand(typed) : null;
}

/** The ID a reply or press under the notice at (channel, ts) runs with: a stored command's key carries the notice. */
export function noticeReplyId(channel: string, ts: string, id: string): string {
  return `notice-${channel}-${ts}-${id}`;
}

/** The notice thread a marker's command was typed under (its key from `noticeReplyId`), in `source`'s team; else null. */
export function noticeThreadOf(marker: string, source: SourceRef): SourceRef | null {
  const m = /slack-notice-([A-Z0-9]+)-(\d+\.\d+)-/.exec(marker);
  const team = source.type === "slack_thread" ? parseSlackSourceId(source.id)?.team : undefined;
  return m && team ? threadRef({ team, channel: m[1]!, thread_ts: m[2]! }) : null;
}

/** The reply under a notice that names no item: a summary, or a notice with no record. */
export const NAMES_NO_ITEM =
  "This notice names no work item, so nothing was run and no item was made. Reply in an item's own thread, or under a notice line that names it.";

/** The reply to a mention with no command word under a notice: the commands each named item takes now. */
export function noticeCommandsReply(items: readonly WorkItem[]): string {
  const forItem = (it: WorkItem) => [
    ...commandsFor(commandState(it)).map((c) => chatForm(c.usage)),
    ...(it.source.type === LOCAL_SOURCE ? ["merge", "go ahead and merge"] : []),
  ];
  return [
    "That reply names no command, so nothing was run. Mention the bot here with a command for the item:",
    ...items.map((it) => `- ${it.title || it.id}: ${forItem(it).map((c) => `\`${c}\``).join(", ")}`),
  ].join("\n");
}

/** The which-item question: one button per item (its value the item ID), in an actions block keyed on the question. */
export function whichItemMessage(items: readonly WorkItem[], question: string): SlackRendered {
  const text = `This notice names ${items.length} items. Which one is your reply for? Nothing runs until you press one.`;
  const elements = items.slice(0, MAX_BUTTONS).map((it, i) => button((it.title || it.id).slice(0, LABEL_MAX), `${ACTION_NOTICE_ITEM}:${i}`, it.id));
  return {
    text: escapeSlack(text),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeSlack(text) } }, { type: "actions", block_id: `${ACTION_NOTICE_ITEM}:${question}`, elements }],
  };
}

/** What the source gives: its channels, the store's reads and writes, and its own ways to run and to answer. */
export interface NoticeDeps {
  channels: readonly string[];
  notify_channel?: string | undefined;
  store: ChatStore & Pick<FactoryStore, "getNoticeMessage" | "recordNoticeQuestion" | "getNoticeQuestion">;
}
export interface NoticeHooks {
  /** Runs a chat command as the linked user on `item`, answering in `source` (SlackSource.chat). */
  chat(cmd: ChatCommand, source: SourceRef, user: string, id: string, item: WorkItem | null): Promise<null>;
  /** Posts `answer` in `source`, once per `id`. */
  reply(source: SourceRef, answer: ChatAnswer, id: string): Promise<null>;
  /** Posts a rendered message in `source` under `marker`, once (scanned first). */
  post(source: SourceRef, render: () => SlackRendered, marker: string): Promise<unknown>;
}

/** One reply or press in a thread: where, by whom, and its ID (the event ID; a press's team, user and action_ts). */
type At = SlackThread & { user: string; id: string };

export class NoticeReplies {
  constructor(private readonly d: NoticeDeps, private readonly h: NoticeHooks) {}

  /** Whether events in `channel` are read: a listed channel, or the notices channel (there only replies under a notice). */
  reads(channel: string): boolean {
    return this.d.channels.includes(channel) || channel === this.d.notify_channel;
  }

  /**
   * A reply under a notice (`said`: its words after the mention), or undefined when the thread is no notice: then it
   * keeps today's reading. A thread with no record is a notice only in an unlisted notices channel.
   */
  async reply(at: At, said: string): Promise<null | undefined> {
    const record = await this.d.store.getNoticeMessage(at.channel, at.thread_ts);
    if (!record && this.d.channels.includes(at.channel)) return undefined;
    const source = threadRef(at);
    if ((await this.d.store.resolveLink("slack", at.user)) === null) return this.h.reply(source, { markdown: UNLINKED }, at.id);
    const items = await this.items(record?.work_item_ids ?? []);
    if (items.length === 0) return this.h.reply(source, { markdown: NAMES_NO_ITEM }, at.id);
    const cmd = noticeCommand(said);
    if (cmd === null) return this.h.reply(source, { markdown: noticeCommandsReply(items) }, at.id);
    if (items.length > 1 && cmd.kind === "command" && cmd.entry.item) {
      await this.d.store.recordNoticeQuestion({ id: at.id, channel: at.channel, notice_ts: at.thread_ts, text: said });
      await this.h.post(source, () => whichItemMessage(items, at.id), `<!-- factory:notice-which:${at.id} -->`);
      return null;
    }
    return this.h.chat(cmd, source, at.user, noticeReplyId(at.channel, at.thread_ts, at.id), items.length === 1 ? items[0]! : null);
  }

  /**
   * A which-item press: the stored reply's command on the chosen item, as the presser. The block ID names the question,
   * the value the item; both are untrusted, so the question must be under this notice and the item one it names.
   */
  async press(at: At, block: string | null, value: string | null): Promise<null> {
    const prefix = `${ACTION_NOTICE_ITEM}:`;
    if (!this.reads(at.channel) || value === null || !block?.startsWith(prefix)) return null;
    const q = await this.d.store.getNoticeQuestion(block.slice(prefix.length));
    if (!q || q.channel !== at.channel || q.notice_ts !== at.thread_ts) return null;
    if (!(await this.d.store.getNoticeMessage(at.channel, at.thread_ts))?.work_item_ids.includes(value)) return null;
    const [[item], cmd] = [await this.items([value]), noticeCommand(q.text)];
    return item && cmd ? this.h.chat(cmd, threadRef(at), at.user, noticeReplyId(at.channel, at.thread_ts, at.id), item) : null;
  }

  private async items(ids: readonly string[]): Promise<WorkItem[]> {
    return (await Promise.all(ids.map((id) => this.d.store.getWorkItem(id as WorkItemId)))).filter((it): it is WorkItem => it !== null);
  }
}
