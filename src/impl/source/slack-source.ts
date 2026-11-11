import { createHash } from "node:crypto";
import { type ChatCommand, parseChatCommand } from "../../core/command-table.js";
import { THREAD_BARE_COMMANDS, parseComment, parseLink, withSlash } from "../../core/commands.js";
import type { Logger } from "../../core/log.js";
import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef, WorkItem } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { PushedEvent, SourceCloseReason, SourceEvent, StreamSource } from "../../interfaces/source-adapter.js";
import type { RepoRef } from "../github/github-client.js";
import { SlackApiError, type SlackApi, type SlackMessage } from "./slack-api.js";
import { commentEvent } from "../../core/comment-event.js";
import {
  ACTION_CANCEL, ACTION_COMMAND, ACTION_CONFIRM, BUTTON_COMMANDS, escapeSlack, prUrl, renderComment, renderLines, unescapeSlack, type SlackRendered,
} from "./slack-format.js";
import { type ChatAnswer, type ChatDeps, type ChatStore, runChatCommand } from "./slack-commands.js";
import type { SocketConnector } from "./slack-socket.js";

/** Metadata event types on the factory's own messages: a comment (by marker hash) and the one status message. */
export const META_MESSAGE = "factory_message";
export const META_STATUS = "factory_status";
/** The store record (outbound_deliveries) of a thread's status message: its ts as the comment ID. */
const STATUS_MARKER = "slack:status";
/** The record of the status message posted after message `ts` was deleted. */
const replacedStatusMarker = (ts: string) => `slack:status:after:${ts}`;

const TITLE_MAX = 120;
/** A Slack message timestamp, the comment id of a typed command. */
const MESSAGE_TS = /^\d+\.\d+$/;

/** One envelope's event and its dedupe key. */
type Mapped = { event: SourceEvent; key: string };

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
   * messages it posted (`getPostedComment`, `recordPostedComment`), so a repeat reads no thread.
   */
  store: ChatStore & Pick<FactoryStore, "getWorkItemBySource" | "recordItemMessage" | "getPostedComment" | "recordPostedComment">;
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
 * starts a work item from its thread (`slack:<team>:<channel>:<thread ts>`); a mention followed by a command, a
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
 * per thread, its ts recorded, edited in place with no thread read, with a link to the PR once there is one.
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
    const title = (said.split(/\r?\n/)[0] ?? "").trim().slice(0, TITLE_MAX) || "Slack request";
    return { event: { kind: "item_requested", source, requester: who, title, body: said }, key };
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

  /** A button press on one of the factory's messages: the command it names, as the presser typing it. */
  private async fromInteraction(p: Record<string, unknown>, me: { team_id: string; user_id: string }): Promise<Mapped | null> {
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
    let body: string | null = null;
    if (action_id === ACTION_CONFIRM) body = str(action.value);
    else if (action_id.startsWith(`${ACTION_COMMAND}:`)) {
      const name = action_id.slice(ACTION_COMMAND.length + 1);
      body = (BUTTON_COMMANDS as readonly string[]).includes(name) ? `/${name}` : null;
    }
    // Cancel, and anything else: nothing runs and nothing is stored.
    if (action_id === ACTION_CANCEL || body === null) return null;
    const source = threadRef({ team, channel, thread_ts });
    const chat = parseChatCommand(body);
    if (chat) return this.chat(chat, source, user, `${team}-${user}-${action_ts}`, await this.d.store.getWorkItemBySource("slack_thread", source.id));
    const parsed = parseComment(body);
    if (parsed === null || parsed.kind !== "command") return null;
    const e = commentEvent(source, `action:${action_ts}`, { provider: "slack", subject: user }, body);
    return e ? { event: e, key: `action:${team}:${user}:${action_ts}` } : null;
  }

  /**
   * A chat command (issue #498): run through slack-commands.ts, which stores what it stores with no Slack call; then
   * its answer, if any, is posted in the thread under a marker keyed on `id`, so a redelivery posts nothing more.
   * Nothing goes to the inbox: the stored command row is what the controller applies.
   */
  private async chat(cmd: ChatCommand, source: SourceRef, user: string, id: string, item: WorkItem | null): Promise<null> {
    const answer = await runChatCommand({ store: this.d.store, ...(this.d.settings ? { settings: this.d.settings } : {}) }, cmd, {
      user, item, id: `slack-${id}`, origin: this.type,
    });
    if (answer !== null) await this.post(source, (bot) => this.rendered(answer, bot), `<!-- factory:chat:${id} -->`);
    return null;
  }

  private rendered(a: NonNullable<ChatAnswer>, bot: string): SlackRendered {
    return "markdown" in a ? renderComment(a.markdown, this.d.repo, bot) : renderLines(a.lines, a.whole, a.link);
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    return this.post(source, (bot) => renderComment(body, this.d.repo, bot), marker, body);
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
   * the deleted message's replacement marker, since a stored record keeps its first ts.
   */
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    if (change_ref !== null) return;
    const t = this.thread(source);
    const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
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
