import { createHash } from "node:crypto";
import { type ChatCommand, parseChatCommand } from "../../core/command-table.js";
import { type CommandName, THREAD_BARE_COMMANDS, commandFooter, commandState, parseComment, parseLink, withSlash } from "../../core/commands.js";
import type { Logger } from "../../core/log.js";
import { inReactionWindow, reactionEvent, verdictReaction } from "../../core/reaction-verdict.js";
import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef, UserId, WorkItem } from "../../core/types.js";
import { type VerdictButton, VERDICT_BUTTON_LABELS, buttonVerdict, buttonVerdictKey, verdictButtonOf, verdictRefusal } from "../../core/verdict.js";
import { utcMinute } from "../../core/spec-comment.js";
import type { AuthProvider, ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { PushedEvent, SourceCloseReason, SourceEvent, StreamSource } from "../../interfaces/source-adapter.js";
import type { RepoRef } from "../github/github-client.js";
import { SlackApiError, type SlackApi, type SlackMessage } from "./slack-api.js";
import { commentEvent } from "../../core/comment-event.js";
import {
  ACTION_CANCEL, ACTION_COMMAND, ACTION_CONFIRM, ACTION_MAKE_TASK, BUTTON_COMMANDS, FEEDBACK_CALLBACK, FEEDBACK_INPUT, buttonApplies, doneLine, escapeSlack,
  feedbackModal, footerCommands, prUrl, renderComment, renderLines, resultMarker, unescapeSlack, verdictAction, type SlackRendered, type VerdictShown,
} from "./slack-format.js";
import { type ChatAnswer, type ChatDeps, type ChatStore, type ProposalPress, proposalPress, runChatCommand, runProposalPress } from "./slack-commands.js";
import type { SocketConnector } from "./slack-socket.js";

/** Metadata event types on the factory's own messages: a comment (by marker hash) and the one status message. */
export const META_MESSAGE = "factory_message";
export const META_STATUS = "factory_status";
/** The store record (outbound_deliveries) of a thread's status message: its ts as the comment ID. */
const STATUS_MARKER = "slack:status";
/** The record of the status message posted after message `ts` was deleted. */
const replacedStatusMarker = (ts: string) => `slack:status:after:${ts}`;
/** Whether a stored marker is the status message's (the first or a replacement of a deleted one). */
const isStatusMarker = (marker: string) => marker === STATUS_MARKER || marker.startsWith(replacedStatusMarker(""));
/** The record of the chat.update that left message `ts` with the buttons `keep` (issue #586): one update each. */
const doneMarker = (ts: string, keep: readonly CommandName[]) => `slack:done:${ts}:${keep.join(",")}`;
/** The record of the chat.update that showed message `ts`'s verdict as of its state change: one update each. */
const verdictMarker = (ts: string, state_change_id: string) => `slack:verdict:${ts}:${state_change_id}`;
/** Version conflicts a one-tap verdict retries before it gives up (another write to the item won each time). */
const VERDICT_TRIES = 5;

const TITLE_MAX = 120;
/** A Slack message timestamp, the comment id of a typed command. */
const MESSAGE_TS = /^\d+\.\d+$/;

/** One envelope's event and its dedupe key. */
type Mapped = { event: SourceEvent; key: string };

/** A factory result message (resultMarker) with its thread, item, thread entry and its one-tap verdict's key. */
interface ResultMessage {
  source: SourceRef;
  item: WorkItem;
  ts: string;
  entry: { marker: string; body: string };
  key: string;
}

export interface SlackSourceDeps {
  api: SlackApi;
  connect: SocketConnector;
  /** The channel IDs from the `slack` config block. Events from any other channel start nothing. */
  channels: readonly string[];
  /** G5: every message is scanned before it is posted. */
  scanner: EgressScanner;
  /**
   * Whether a thread is already a work item, and its PR for the status line; a person's reply in an item's thread,
   * stored as a thread entry (`recordItemMessage`, issue #480); for chat commands (slack-commands.ts), the account
   * links, the local users, the reads `list` and `show` print, and the command rows they store; the records of the
   * messages it posted (`getPostedComment`, `recordPostedComment`), so a repeat reads no thread; the item's thread
   * entries and state changes, for the earlier messages a state change updates and the reply to a stale button; a
   * stored proposal's rows, for its Cancel button (issue #584); the records of a reacted message's ts, to find the
   * item a 👍 or 👎 is about (issue #524); a result message's one-tap verdict, stored and read by its key.
   */
  store: ChatStore & Pick<
    FactoryStore,
    "getWorkItemBySource" | "recordItemMessage" | "getPostedComment" | "recordPostedComment" | "listStateChanges" | "listPostedCommentsById"
    | "recordVerdict" | "listVerdicts"
  >;
  /**
   * The `record_verdict` check of a Good, Bad or Feedback tap, through the Slack account's linked factory user (the
   * plugin passes the local auth plugin's check, as Slack chat commands are judged by default).
   */
  auth: Pick<AuthProvider, "resolve" | "authorize">;
  /** `settings list` and `settings history` from Slack; absent: they answer that settings are not readable here. */
  settings?: ChatDeps["settings"];
  /** Where PR links point. */
  repo: RepoRef;
  log: Logger;
}

/** The parts of a Slack source id `slack:<team>:<channel>:<thread ts>`. */
export interface SlackThread {
  team: string;
  channel: string;
  thread_ts: string;
}

export function slackSourceId(t: SlackThread): string {
  return `slack:${t.team}:${t.channel}:${t.thread_ts}`;
}

export function parseSlackSourceId(id: string): SlackThread | null {
  const m = /^slack:([A-Z0-9]+):([A-Z0-9]+):(\d+\.\d+)$/.exec(id);
  return m ? { team: m[1]!, channel: m[2]!, thread_ts: m[3]! } : null;
}

/** A link to a message (or a thread root) that Slack redirects into the workspace. */
export function slackLink(channel: string, ts: string, thread_ts?: string): string {
  const base = `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  return thread_ts && thread_ts !== ts ? `${base}?thread_ts=${thread_ts}&cid=${channel}` : base;
}

function threadRef(t: SlackThread): SourceRef {
  return { type: "slack_thread", id: slackSourceId(t), link: slackLink(t.channel, t.thread_ts) };
}

/** A request's title: its first line, at most TITLE_MAX characters. */
const titleOf = (text: string): string => (text.split(/\r?\n/)[0] ?? "").trim().slice(0, TITLE_MAX) || "Slack request";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** A marker as it is stored in Slack metadata: a hash, so no marker text is posted. */
function markerHash(marker: string): string {
  return createHash("sha256").update(marker).digest("hex").slice(0, 32);
}

const STATUS_WORDS: Record<WorkStatus, string> = {
  triaging: "triaging",
  needs_approval: "needs approval",
  implementing: "implementing",
  in_review: "in review",
  ready_to_merge: "ready to merge",
  needs_human: "needs a human",
  done: "done",
  rejected: "rejected",
};

/**
 * The `slack` stream source (issue #109): Slack Socket Mode in, thread replies out.
 *
 * In: one Socket Mode connection per `subscribe`, opened only by the replica holding the listener lease
 * (src/core/listener.ts). Each envelope that means something becomes one PushedEvent; its ack goes back on the
 * socket only once the listener stored it. Anything else is acked at once and dropped. Only events in the
 * configured channels count, never the bot's own messages, edits, joins or other subtypes. A mention of the bot
 * starts a work item from its thread (`slack:<team>:<channel>:<thread ts>`); a top-level one is marked `classify`, so
 * the controller first reads whether it is a request or chat (a chat answer, or an offer whose "Make this a task"
 * press is the same item request, as the presser, keyed on the message's source id); a mention followed by a command, a
 * reply in an item's thread and a button press are the same events a GitHub comment gives; a reply in any other
 * thread is not stored. After a mention in an item's thread, a command word with no slash is that command (`revise x`
 * is `/revise x`, issue #541); outside one, the same words are a request. A person's reply in an
 * item's thread, a command too, is also kept on the item's thread, as the GitHub source keeps a comment, before its event is returned. A factory command from the command table (`list`, `show <id>`, `/approve` in an item's
 * thread, ...) is run here as the linked factory user (slack-commands.ts): what it stores is stored before any Slack
 * call, then its reply is posted; a failed post leaves the envelope unacked, so Slack sends it again and the keyed row
 * and the reply's marker make the second run change nothing. People are Slack user
 * IDs (provider `slack`); no display name is read or kept. Dedupe keys: Slack's `event_id`, or for a button press
 * the team, user and `action_ts`. A mention arrives twice (a `message` and an `app_mention` event, two event ids):
 * only the `app_mention` counts, and intake is idempotent on the source id anyway.
 *
 * Out: every message is egress-scanned first. A blocked message is never posted in any form; the thread gets one
 * notice without its content, under the same marker, so it is not tried again. Each message carries its marker's
 * hash in Slack metadata and is recorded in the store (ts and link); postComment checks that record first and
 * reads the thread only when there is none, so a marker is posted at most once. The item's status is one message
 * per thread, its ts recorded, edited in place with no thread read, with a link to the PR once there is one. On each
 * status write, an earlier message whose buttons no longer apply is edited once to drop them and say what was done;
 * a press of a button that no longer applies gets a reply saying what already happened, with the current buttons.
 *
 * The only in-process state is the bot's identity (auth.test), which any replica reads for itself.
 */
export class SlackSource implements StreamSource {
  readonly intake = "stream";
  readonly type = "slack_thread";
  private me: Promise<{ team_id: string; user_id: string }> | null = null;

  constructor(private readonly d: SlackSourceDeps) {}

  async *subscribe(signal: AbortSignal): AsyncGenerator<PushedEvent> {
    const me = await this.identity();
    const url = await this.d.api.openSocketUrl();
    if (signal.aborted) return;
    const conn = await this.d.connect(url, signal);
    try {
      for await (const raw of conn.messages) {
        if (signal.aborted) return;
        let env: Record<string, unknown>;
        try {
          env = obj(JSON.parse(raw));
        } catch {
          continue;
        }
        // Slack asks for a new connection (refresh, a deploy on its side): end this one, the listener reconnects.
        if (env.type === "disconnect") return;
        const envelope_id = str(env.envelope_id);
        if (envelope_id === null) continue;
        let acked = false;
        const ack = async () => {
          if (acked) return;
          acked = true;
          conn.send(JSON.stringify({ envelope_id }));
        };
        const pushed = await this.toEvent(env, me);
        if (pushed === null) {
          await ack();
          continue;
        }
        yield { event: pushed.event, dedupe_key: pushed.key, ack };
      }
    } finally {
      conn.close();
    }
  }

  /** The event one envelope means, with its dedupe key, or null when it means nothing to the factory. */
  async toEvent(env: Record<string, unknown>, me: { team_id: string; user_id: string }): Promise<Mapped | null> {
    if (env.type === "events_api") return this.fromEventsApi(obj(env.payload), me);
    if (env.type === "interactive") return this.fromInteraction(obj(env.payload), me);
    return null;
  }

  private async fromEventsApi(p: Record<string, unknown>, me: { team_id: string; user_id: string }): Promise<Mapped | null> {
    const event_id = str(p.event_id);
    const team = str(p.team_id) ?? me.team_id;
    const ev = obj(p.event);
    const type = ev.type;
    if (event_id !== null && type === "reaction_added") return this.fromReaction(ev, event_id, me);
    if (event_id === null || (type !== "app_mention" && type !== "message")) return null;
    const channel = str(ev.channel);
    const user = str(ev.user);
    const ts = str(ev.ts);
    if (channel === null || user === null || ts === null || !this.d.channels.includes(channel)) return null;
    // The bot itself, other bots and integrations, and edits, joins, deletes: never input.
    if (user === me.user_id || ev.bot_id !== undefined || ev.subtype !== undefined) return null;
    const text = unescapeSlack(typeof ev.text === "string" ? ev.text : "");
    const mentioned = text.includes(`<@${me.user_id}>`) || text.includes(`<@${me.user_id}|`);
    const said = text.replace(new RegExp(`<@${me.user_id}(?:\\|[^>]*)?>`, "g"), " ").replace(/[ \t]+/g, " ").trim();
    const thread_ts = str(ev.thread_ts) ?? ts;
    const inThread = thread_ts !== ts;
    const source = threadRef({ team, channel, thread_ts });
    const who: ExternalIdentity = { provider: "slack", subject: user };
    const key = `event:${event_id}`;
    if (type === "message") {
      // A mention comes again as `app_mention`; a top-level message without one is not for the factory.
      if (mentioned || !inThread) return null;
      // A reply in a thread that is not a work item is other people's conversation: not stored at all.
      const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
      if (!item) return null;
      await this.keep(item, ts, user, said);
      // Without a mention, a chat command needs its `/`, as an item command does.
      const chat = said.startsWith("/") && parseLink(said) === null ? parseChatCommand(said) : null;
      if (chat) return this.chat(chat, source, user, event_id, item);
      const e = commentEvent(source, ts, who, said);
      return e ? { event: e, key } : null;
    }
    // app_mention: a chat command (the command table's forms, src/core/command-table.ts) runs as the linked user;
    // `/link` or another command after the mention is that command; else a request from the thread. In an item's
    // thread the reply is kept first, whatever it is; the mention that starts an item (the thread root) is not.
    // There a command word with no slash is that command (THREAD_BARE_COMMANDS, issues #528 and #541), read as if
    // typed with it; outside one it is a request in plain words.
    const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
    if (item && inThread) await this.keep(item, ts, user, said);
    const typed = (item && inThread ? withSlash(said, THREAD_BARE_COMMANDS) : null) ?? said;
    const chat = parseLink(typed) === null ? parseChatCommand(typed) : null;
    if (chat) return this.chat(chat, source, user, event_id, item);
    if (parseLink(typed) !== null || parseComment(typed) !== null) {
      const e = commentEvent(source, ts, who, typed);
      return e ? { event: e, key } : null;
    }
    if (inThread && item) {
      return { event: { kind: "plain_comment", source, comment_id: ts, author: who, body: said }, key };
    }
    // A top-level mention is read by the controller before intake (classify): it may be chat, not a request.
    return { event: { kind: "item_requested", source, requester: who, title: titleOf(said), body: said, ...(inThread ? {} : { classify: true as const }) }, key };
  }

  /**
   * `reaction_added` (issue #524): a 👍 or 👎 by a person, in a configured channel, on a message the factory posted
   * in a work item's thread, within 7 days of the message (Slack timestamps: the message ts and the event_ts). The
   * message is found by its ts in the store's posted records, which name its thread; the status message, a message
   * with no record and a thread that is no work item mean nothing. The event targets the item, keyed on the channel,
   * message, person and emoji, so a remove and re-add stores nothing more. Needs `reactions:read`: without it no
   * such event arrives and nothing else changes.
   */
  private async fromReaction(ev: Record<string, unknown>, event_id: string, me: { user_id: string }): Promise<Mapped | null> {
    const user = str(ev.user);
    const msg = obj(ev.item);
    const channel = str(msg.channel);
    const ts = str(msg.ts);
    const reaction = verdictReaction(str(ev.reaction) ?? "");
    if (user === null || channel === null || ts === null || reaction === null || msg.type !== "message") return null;
    if (!this.d.channels.includes(channel) || user === me.user_id) return null;
    const reacted = Number(str(ev.event_ts)) * 1000;
    if (!Number.isFinite(reacted) || !inReactionWindow(Number(ts) * 1000, reacted)) return null;
    const records = await this.d.store.listPostedCommentsById(ts);
    if (records.some((r) => isStatusMarker(r.marker))) return null;
    const thread = records.map((r) => parseSlackSourceId(r.source_id)).find((t) => t?.channel === channel);
    if (!thread) return null;
    const source = threadRef(thread);
    if (!(await this.d.store.getWorkItemBySource("slack_thread", source.id))) return null;
    const event = reactionEvent({ kind: "issue", source }, `slack:${channel}:${ts}:${user}:${reaction}`, { provider: "slack", subject: user }, reaction);
    return { event, key: `event:${event_id}` };
  }

  /**
   * A person's reply in an item's thread, kept on the item's thread (issue #480) before its event is returned: marker
   * `slack:<ts>`, actor the Slack user ID, no delivery (it is already in Slack). A repeat marker stores nothing, so a
   * redelivery adds no entry; a failed write throws, so the envelope is not acked and Slack sends it again.
   */
  private async keep(item: WorkItem, ts: string, user: string, said: string): Promise<void> {
    if (said === "") return;
    await this.d.store.recordItemMessage({ work_item_id: item.id, marker: `slack:${ts}`, body: said, actor: `slack:${user}` });
  }

  /**
   * A button press on one of the factory's messages: the command it names, as the presser typing it. A stored
   * proposal's button (issue #584) goes to slack-commands.ts as the linked user: its value names only the proposal
   * and index, and the controller reads the command and its args from the store.
   */
  private async fromInteraction(p: Record<string, unknown>, me: { team_id: string; user_id: string }): Promise<Mapped | null> {
    if (p.type === "view_submission") return this.fromFeedback(p, me);
    if (p.type !== "block_actions") return null;
    const user = str(obj(p.user).id);
    const team = str(obj(p.team).id) ?? str(obj(p.user).team_id) ?? me.team_id;
    const channel = str(obj(p.channel).id) ?? str(obj(p.container).channel_id);
    const message = obj(p.message);
    const thread_ts = str(message.thread_ts) ?? str(obj(p.container).thread_ts) ?? str(message.ts);
    const action = obj(Array.isArray(p.actions) ? p.actions[0] : undefined);
    const action_id = str(action.action_id);
    const action_ts = str(action.action_ts);
    if (user === null || channel === null || thread_ts === null || action_id === null || action_ts === null) return null;
    if (!this.d.channels.includes(channel) || user === me.user_id) return null;
    const tap = verdictAction(action_id);
    if (tap) return this.verdictTap(tap, channel, str(message.ts), user, str(p.trigger_id));
    // "Make this a task" under an unsure answer: the message (the button's value) taken in as the presser, keyed on
    // the message's source id (the thread root), so a second press changes nothing.
    if (action_id === ACTION_MAKE_TASK) {
      const text = str(action.value)?.trim();
      if (!text) return null;
      const source = threadRef({ team, channel, thread_ts });
      const requester: ExternalIdentity = { provider: "slack", subject: user };
      return { event: { kind: "item_requested", source, requester, title: titleOf(text), body: text }, key: `action:${team}:${user}:${action_ts}` };
    }
    const proposal = proposalPress(action_id, str(action.value));
    if (proposal) {
      const source = threadRef({ team, channel, thread_ts });
      return this.chat({ press: proposal }, source, user, `${team}-${user}-${action_ts}`, await this.d.store.getWorkItemBySource("slack_thread", source.id));
    }
    let body: string | null = null;
    let button: CommandName | null = null;
    if (action_id === ACTION_CONFIRM) body = str(action.value);
    else if (action_id.startsWith(`${ACTION_COMMAND}:`)) {
      const name = action_id.slice(ACTION_COMMAND.length + 1);
      button = (BUTTON_COMMANDS as readonly string[]).includes(name) ? (name as CommandName) : null;
      body = button ? `/${button}` : null;
    }
    // Cancel, and anything else: nothing runs and nothing is stored.
    if (action_id === ACTION_CANCEL || body === null) return null;
    const source = threadRef({ team, channel, thread_ts });
    const id = `${team}-${user}-${action_ts}`;
    const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
    if (button && item && !buttonApplies(button, item)) return this.stale(source, item, id);
    const chat = parseChatCommand(body);
    if (chat) return this.chat(chat, source, user, id, item);
    const parsed = parseComment(body);
    if (parsed === null || parsed.kind !== "command") return null;
    const e = commentEvent(source, `action:${action_ts}`, { provider: "slack", subject: user }, body);
    return e ? { event: e, key: `action:${team}:${user}:${action_ts}` } : null;
  }

  /**
   * A Good, Bad or Feedback press on a result message (design 04-gate-commands, one-tap verdicts). The message is
   * found by its ts in the store's posted records (a result marker in this channel, in a work item's thread); a press
   * by an account whose linked user lacks `record_verdict` (or none) stores nothing and gets no reply. Good and Bad
   * store the message's one verdict, then edit the message to show it; Feedback opens the modal (views.open) and
   * stores nothing until its submit. Nothing goes to the inbox; the envelope is acked after the store write.
   */
  private async verdictTap(tap: VerdictButton, channel: string, ts: string | null, user: string, trigger_id: string | null): Promise<null> {
    const msg = ts === null ? null : await this.resultMessage(channel, ts);
    const who = msg && (await this.verdictUser(user, msg.item));
    if (!msg || !who) return null;
    if (tap !== "feedback") return this.storeVerdict(msg, who, tap);
    if (trigger_id === null) return null;
    try {
      await this.d.api.openView(trigger_id, feedbackModal({ channel, ts: msg.ts }));
    } catch (err) {
      // A redelivered press's trigger has expired (3 seconds): the person presses again.
      if (!(err instanceof SlackApiError)) throw err;
      this.d.log.warn("slack feedback modal not opened", { work_item_id: msg.item.id, code: err.code });
    }
    return null;
  }

  /**
   * The Feedback modal's submit: the same checks as the press (the message is read again from the store, never from
   * the modal's metadata alone), then G5 on the text. A finding stores nothing and posts one notice in the thread
   * (keyed on the modal's view ID), without the text. Else the text is the reason of the message's one verdict, as
   * `changes`/`none`. Returns null: the ack (which closes the modal) is sent after the store write.
   */
  private async fromFeedback(p: Record<string, unknown>, me: { user_id: string }): Promise<null> {
    const view = obj(p.view);
    if (view.callback_id !== FEEDBACK_CALLBACK) return null;
    const user = str(obj(p.user).id);
    const view_id = str(view.id);
    let meta: Record<string, unknown> = {};
    try {
      meta = obj(JSON.parse(str(view.private_metadata) ?? "{}"));
    } catch {
      return null;
    }
    const channel = str(meta.channel);
    const ts = str(meta.ts);
    const text = str(obj(obj(obj(obj(view.state).values)[FEEDBACK_INPUT])[FEEDBACK_INPUT]).value)?.trim() ?? "";
    if (user === null || view_id === null || channel === null || ts === null || text === "") return null;
    if (!this.d.channels.includes(channel) || user === me.user_id) return null;
    const msg = await this.resultMessage(channel, ts);
    const who = msg && (await this.verdictUser(user, msg.item));
    if (!msg || !who) return null;
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
      this.d.log.warn("slack feedback blocked by the egress scan; not stored", { work_item_id: msg.item.id, rules });
      const notice = `Your feedback was not stored: the leak scanner found something in it (${escapeSlack(rules)}). Send it again without that.`;
      await this.post(msg.source, () => ({ text: notice, blocks: [{ type: "section", text: { type: "mrkdwn", text: notice } }] }), `<!-- factory:feedback-withheld:${view_id} -->`);
      return null;
    }
    return this.storeVerdict(msg, who, "feedback", text);
  }

  /** The result message `ts` in `channel`: its posted record with a result marker, in a work item's thread; else null. */
  private async resultMessage(channel: string, ts: string): Promise<ResultMessage | null> {
    for (const r of await this.d.store.listPostedCommentsById(ts)) {
      const result = resultMarker(r.marker);
      const thread = parseSlackSourceId(r.source_id);
      if (!result || thread?.channel !== channel) continue;
      const source = threadRef(thread);
      const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
      const entry = item && (await this.d.store.listItemMessages(item.id)).find((m) => m.marker === r.marker);
      if (!item || !entry) return null;
      return { source, item, ts, entry, key: buttonVerdictKey(channel, ts, result.run) };
    }
    return null;
  }

  /** The linked factory user of Slack account `user` when it may record a verdict on `item`, else null (logged only). */
  private async verdictUser(user: string, item: WorkItem): Promise<UserId | null> {
    const principal = await this.d.auth.resolve({ provider: "slack", subject: user });
    const decision = principal && (await this.d.auth.authorize(principal, "record_verdict", { kind: "work_item", id: item.id }));
    if (principal && decision?.allow) return principal.user_id;
    this.d.log.info("slack verdict button ignored", { work_item_id: item.id, reason: decision && !decision.allow ? decision.reason : "not_linked" });
    return null;
  }

  /**
   * Stores the message's one verdict under its key, as `user` (recordVerdict with `replace`: a second tap updates the
   * row, the same tap again changes nothing), retrying on version conflicts; then edits the message to show it. An
   * item closed without a merge takes none (verdictRefusal). A failed write throws: the envelope stays unacked.
   */
  private async storeVerdict(msg: ResultMessage, user: UserId, tap: VerdictButton, text?: string): Promise<null> {
    const v = buttonVerdict(tap, text);
    for (let i = 0; i < VERDICT_TRIES; i++) {
      const it = await this.d.store.getWorkItem(msg.item.id);
      if (!it) return null;
      const closed = verdictRefusal(it);
      if (closed !== null) {
        this.d.log.info("slack verdict button not stored", { work_item_id: it.id, reason: closed });
        return null;
      }
      const r = await this.d.store.recordVerdict({
        id: it.id, expected_version: it.version, actor: { kind: "user", id: user }, ...v, comment_id: msg.key, target: "issue",
        implicit: false, pr_head: it.change_ref === null ? null : it.last_head_sha, replace: true,
      });
      if (r.ok || r.reason === "duplicate") {
        await this.showVerdict({ ...msg, item: r.ok ? r.item : it });
        return null;
      }
      if (r.reason !== "version_conflict") return null;
    }
    this.d.log.warn("slack verdict button gave up after conflicts", { work_item_id: msg.item.id });
    return null;
  }

  /**
   * Edits a result message to show its stored verdict, keeping what a state change left of it (`settle`). Recorded
   * under the message and the verdict's state change, so the same verdict shown again makes no Slack call.
   */
  private async showVerdict(msg: ResultMessage): Promise<void> {
    const v = (await this.d.store.listVerdicts(msg.item.id)).find((x) => x.comment_id === msg.key);
    if (!v) return;
    const marker = verdictMarker(msg.ts, v.state_change_id);
    if ((await this.d.store.getPostedComment(msg.source.id, marker, ""))?.comment_id) return;
    const had = footerCommands(msg.entry.body);
    const keep = had.filter((c) => buttonApplies(c, msg.item));
    const done = keep.length < had.length ? { line: await this.done(msg.item), keep } : undefined;
    const rendered = renderComment(msg.entry.body, this.d.repo, (await this.identity()).user_id, done, await this.verdictShown(msg.item, msg.key));
    await this.update(msg.source, msg.ts, rendered, marker, msg.entry.marker);
  }

  /** A result message's verdict as it shows: the stored verdict under `key` (its button, actor ID and time), or none. */
  private async verdictShown(item: WorkItem, key: string): Promise<VerdictShown> {
    const v = (await this.d.store.listVerdicts(item.id)).find((x) => x.comment_id === key);
    if (!v) return { chosen: null };
    const actor = (await this.d.store.listStateChanges(item.id)).find((c) => c.id === v.state_change_id)?.actor.id ?? "unknown";
    const b = verdictButtonOf(v);
    return { chosen: b, line: `Verdict: ${b ? VERDICT_BUTTON_LABELS[b] : v.verdict} by ${actor} at ${utcMinute(v.at)}.` };
  }

  /**
   * A chat command (issue #498) or a proposal press (issue #584): run through slack-commands.ts, which stores what it
   * stores with no Slack call; then its answer, if any, is posted in the thread under a marker keyed on `id`, so a
   * redelivery posts nothing more. Nothing goes to the inbox: the stored command row is what the controller applies.
   */
  private async chat(cmd: ChatCommand | { press: ProposalPress }, source: SourceRef, user: string, id: string, item: WorkItem | null): Promise<null> {
    const deps = { store: this.d.store, ...(this.d.settings ? { settings: this.d.settings } : {}) };
    const ctx = { user, item, id: `slack-${id}`, origin: this.type };
    const answer = "press" in cmd ? await runProposalPress(deps, cmd.press, ctx) : await runChatCommand(deps, cmd, ctx);
    if (answer !== null) await this.post(source, (bot) => this.rendered(answer, bot), `<!-- factory:chat:${id} -->`);
    return null;
  }

  /**
   * A press of a button whose command no longer applies (issue #586; only a press: a typed command keeps the shared
   * refusal): one reply in the thread saying what already happened and when, with the buttons that apply now, and no
   * error wording. Nothing is stored and nothing goes to the inbox; the reply's marker keeps it to one per press.
   */
  private async stale(source: SourceRef, item: WorkItem, id: string): Promise<null> {
    const text = ["That button is from an earlier step, so it did nothing now.", await this.done(item), "", commandFooter(commandState(item))].join("\n");
    await this.post(source, (bot) => renderComment(text, this.d.repo, bot), `<!-- factory:stale:${id} -->`);
    return null;
  }

  /** The Done line of `item`: its last state change that is not a verdict (a verdict moves nothing on). */
  private async done(item: WorkItem): Promise<string> {
    const moved = (await this.d.store.listStateChanges(item.id)).filter((c) => c.reason !== "human_verdict" && c.reason !== "implicit_verdict");
    return doneLine(moved.at(-1) ?? null, item);
  }

  private rendered(a: NonNullable<ChatAnswer>, bot: string): SlackRendered {
    return "markdown" in a ? renderComment(a.markdown, this.d.repo, bot) : renderLines(a.lines, a.whole, a.link);
  }

  /** A result message (resultMarker) also gets the Good, Bad and Feedback buttons. */
  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const verdict = resultMarker(marker) ? { chosen: null } : undefined;
    return this.post(source, (bot) => renderComment(body, this.d.repo, bot, undefined, verdict), marker, body);
  }

  /**
   * Posts one message in the thread under `marker`, once. The store's record of the marker is checked first: a
   * recorded marker returns its link with no Slack call. With no record, the thread is read once (a message posted
   * before the records, or a withheld notice); else G5 scans the message and it is posted, and recorded with its
   * ts, link and `body` (the rendered text when absent). A withheld notice is never recorded.
   */
  private async post(source: SourceRef, render: (bot: string) => SlackRendered, marker: string, body?: string): Promise<{ url: string | null }> {
    const stored = await this.d.store.getPostedComment(source.id, marker, body ?? "");
    if (stored?.comment_id) return { url: stored.url };
    const t = this.thread(source);
    const me = await this.identity();
    const hash = markerHash(marker);
    const replies = await this.d.api.threadReplies(t.channel, t.thread_ts);
    const prior = replies.find((m) => this.ours(m, me.user_id) && m.metadata?.event_type === META_MESSAGE && m.metadata.event_payload.marker === hash);
    if (prior) {
      const url = slackLink(t.channel, prior.ts, t.thread_ts);
      if (prior.metadata?.event_payload.withheld === undefined) await this.record(source, marker, prior.ts, url, prior.text ?? "");
      return { url };
    }
    const { msg, withheld } = await this.scanned(render(me.user_id), source, marker);
    const { ts } = await this.d.api.postMessage({
      channel: t.channel,
      thread_ts: t.thread_ts,
      text: msg.text,
      blocks: msg.blocks,
      metadata: { event_type: META_MESSAGE, event_payload: withheld ? { marker: hash, withheld: "1" } : { marker: hash } },
    });
    const url = slackLink(t.channel, ts, t.thread_ts);
    if (!withheld) await this.record(source, marker, ts, url, body ?? msg.text);
    return { url };
  }

  private record(source: SourceRef, marker: string, ts: string, url: string, body: string): Promise<void> {
    return this.d.store.recordPostedComment({ source_id: source.id, marker, comment_id: ts, url, body });
  }

  /**
   * 👀 (`eyes`) on the command's message, once: Slack's `already_reacted` is success, so a redelivery adds none.
   * No message timestamp (an item request, a button press's `action:` key): nothing to react to. A failure
   * throws; outbound treats a 👀 as best effort and only warns.
   */
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    if (commentId === null || !MESSAGE_TS.test(commentId)) return;
    await this.d.api.react(this.thread(source).channel, commentId, "eyes");
  }

  /**
   * One status message per thread, edited in place; it links the PR once the item has one, built from its
   * `change_ref` (the PR number as text). A PR's own status (non-null `change_ref`) lives on GitHub: nothing to do
   * here. The message's ts is kept in the store under STATUS_MARKER, so a change is one chat.update and no thread
   * read; the thread is read only when there is no record (a status posted before the records), and what it finds
   * is recorded. A status message someone deleted (`message_not_found`) is replaced by a new one, recorded under
   * the deleted message's replacement marker, since a stored record keeps its first ts. Then the earlier messages
   * whose buttons no longer apply are updated (`settle`): outbound delivers one status write per state change.
   */
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    if (change_ref !== null) return;
    const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
    await this.writeStatus(source, status, item);
    if (item) await this.settle(source, item);
  }

  /**
   * After a state change (issue #586): each earlier message of the item's thread whose buttons no longer all apply is
   * edited once with chat.update, keeping only the buttons that still apply and ending with the Done line; a result
   * message keeps its verdict buttons and stored verdict. Store reads only: the thread entries' bodies give the buttons
   * each message had, their posted records its ts. An update is recorded under its message's ts and the buttons kept,
   * so running this again makes no second call. A message posted before the records, or deleted since, is left as it is.
   */
  private async settle(source: SourceRef, item: WorkItem): Promise<void> {
    const t = this.thread(source);
    let line: string | null = null;
    for (const m of await this.d.store.listItemMessages(item.id)) {
      if (m.actor) continue;
      const had = footerCommands(m.body);
      const keep = had.filter((c) => buttonApplies(c, item));
      if (keep.length === had.length) continue;
      const ts = (await this.d.store.getPostedComment(source.id, m.marker, m.body))?.comment_id;
      if (!ts) continue;
      const marker = doneMarker(ts, keep);
      if ((await this.d.store.getPostedComment(source.id, marker, ""))?.comment_id) continue;
      line ??= await this.done(item);
      const result = resultMarker(m.marker);
      const verdict = result ? await this.verdictShown(item, buttonVerdictKey(t.channel, ts, result.run)) : undefined;
      const msg = renderComment(m.body, this.d.repo, (await this.identity()).user_id, { line, keep }, verdict);
      await this.update(source, ts, msg, marker, m.marker, line);
    }
  }

  /**
   * One chat.update of message `ts` in `source`'s thread, G5 on all of it first (a finding leaves it as it is), then
   * recorded under `marker`. A message deleted since is left as it is, and recorded too.
   */
  private async update(source: SourceRef, ts: string, msg: SlackRendered, marker: string, of: string, body = msg.text): Promise<void> {
    const t = this.thread(source);
    const scan = await this.d.scanner.scan("comment", `${msg.text}\n${JSON.stringify(msg.blocks)}`);
    if (!scan.clean) {
      this.d.log.warn("slack message update blocked by the egress scan; not edited", { source_id: source.id, marker_hash: markerHash(of) });
      return;
    }
    try {
      await this.d.api.updateMessage({ channel: t.channel, ts, text: msg.text, blocks: msg.blocks });
    } catch (err) {
      if (!(err instanceof SlackApiError && err.code === "message_not_found")) throw err;
    }
    await this.record(source, marker, ts, slackLink(t.channel, ts, t.thread_ts), body);
  }

  /** The status message's text, written in place (or posted once); see setStatus. */
  private async writeStatus(source: SourceRef, status: WorkStatus, item: WorkItem | null): Promise<void> {
    const t = this.thread(source);
    const pr = item?.change_ref ? ` · <${prUrl(this.d.repo, item.change_ref)}|PR #${item.change_ref}>` : "";
    const text = `Status: *${escapeSlack(STATUS_WORDS[status] ?? status)}*${pr}`;
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      this.d.log.warn("slack status blocked by the egress scan; not posted", { source_id: source.id, rules: scan.findings.map((f) => f.rule).join(",") });
      return;
    }
    const metadata = { event_type: META_STATUS, event_payload: { status } };
    const postNew = async (marker: string) => {
      const { ts } = await this.d.api.postMessage({ channel: t.channel, thread_ts: t.thread_ts, text, metadata });
      await this.record(source, marker, ts, slackLink(t.channel, ts, t.thread_ts), text);
    };
    const ts = (await this.statusTs(source)) ?? (await this.legacyStatusTs(source, t));
    if (ts === null) return postNew(STATUS_MARKER);
    try {
      await this.d.api.updateMessage({ channel: t.channel, ts, text, metadata });
    } catch (err) {
      if (!(err instanceof SlackApiError && err.code === "message_not_found")) throw err;
      await postNew(replacedStatusMarker(ts));
    }
  }

  /** The recorded status message's ts: the first record, then each replacement of a deleted one, all store reads. */
  private async statusTs(source: SourceRef): Promise<string | null> {
    let ts = (await this.d.store.getPostedComment(source.id, STATUS_MARKER, ""))?.comment_id ?? null;
    for (let next = ts; next !== null; ) {
      ts = next;
      next = (await this.d.store.getPostedComment(source.id, replacedStatusMarker(ts), ""))?.comment_id ?? null;
    }
    return ts;
  }

  /** A status message posted before the records: found by one thread read, then recorded. */
  private async legacyStatusTs(source: SourceRef, t: SlackThread): Promise<string | null> {
    const me = await this.identity();
    const replies = await this.d.api.threadReplies(t.channel, t.thread_ts);
    const prior = replies.find((m) => this.ours(m, me.user_id) && m.metadata?.event_type === META_STATUS);
    if (!prior) return null;
    await this.record(source, STATUS_MARKER, prior.ts, slackLink(t.channel, prior.ts, t.thread_ts), prior.text ?? "");
    return prior.ts;
  }

  /** A Slack thread cannot be closed; the controller's reject or close comment says it in the thread. */
  async closeIssue(_source: SourceRef, _reason?: SourceCloseReason): Promise<void> {}

  /**
   * G5 on the whole message, buttons included. A finding withholds all of it: the notice names the rules only,
   * and nothing reworded, split or re-encoded from it is posted.
   */
  private async scanned(msg: SlackRendered, source: SourceRef, marker: string): Promise<{ msg: SlackRendered; withheld: boolean }> {
    const scan = await this.d.scanner.scan("comment", `${msg.text}\n${JSON.stringify(msg.blocks)}`);
    if (scan.clean) return { msg, withheld: false };
    const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
    this.d.log.warn("slack message blocked by the egress scan; withheld", { source_id: source.id, marker_hash: markerHash(marker), rules });
    const text = `A factory message for this thread was withheld by the leak scanner (${escapeSlack(rules)}). It is not posted in any form.`;
    return { msg: { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }, withheld: true };
  }

  /** A message the bot posted (by its user ID; other bots cannot pass for it). */
  private ours(m: SlackMessage, botUserId: string): boolean {
    return m.user === botUserId;
  }

  private thread(source: SourceRef): SlackThread {
    const t = source.type === "slack_thread" ? parseSlackSourceId(source.id) : null;
    if (!t) throw new Error(`slack source: not a Slack thread source id: ${JSON.stringify(source.id)}`);
    return t;
  }

  /** auth.test once per process; a failure is not cached, so the next call asks again. */
  private identity(): Promise<{ team_id: string; user_id: string }> {
    if (!this.me) {
      this.me = this.d.api.identity();
      this.me.catch(() => (this.me = null));
    }
    return this.me;
  }
}
