import { createHash } from "node:crypto";
import { parseComment, parseLink } from "../../core/commands.js";
import type { Logger } from "../../core/log.js";
import type { WorkStatus } from "../../core/status-label.js";
import type { SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { PushedEvent, SourceCloseReason, SourceEvent, StreamSource } from "../../interfaces/source-adapter.js";
import type { RepoRef } from "../github/github-client.js";
import type { SlackApi, SlackMessage } from "./slack-api.js";
import { commentEvent } from "./comment-event.js";
import {
  ACTION_CANCEL, ACTION_COMMAND, ACTION_CONFIRM, BUTTON_COMMANDS, escapeSlack, prUrl, renderComment, unescapeSlack, type SlackRendered,
} from "./slack-format.js";
import type { SocketConnector } from "./slack-socket.js";

/** Metadata event types on the factory's own messages: a comment (by marker hash) and the one status message. */
export const META_MESSAGE = "factory_message";
export const META_STATUS = "factory_status";

const TITLE_MAX = 120;

/** One envelope's event and its dedupe key. */
type Mapped = { event: SourceEvent; key: string };

export interface SlackSourceDeps {
  api: SlackApi;
  connect: SocketConnector;
  /** The channel IDs from the `slack` config block. Events from any other channel start nothing. */
  channels: readonly string[];
  /** G5: every message is scanned before it is posted. */
  scanner: EgressScanner;
  /** Read-only: whether a thread is already a work item, and its PR for the status line. */
  store: Pick<FactoryStore, "getWorkItemBySource">;
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
 * reply in an item's thread and a button press are the same events a GitHub comment gives. People are Slack user
 * IDs (provider `slack`); no display name is read or kept. Dedupe keys: Slack's `event_id`, or for a button press
 * the team, user and `action_ts`. A mention arrives twice (a `message` and an `app_mention` event, two event ids):
 * only the `app_mention` counts, and intake is idempotent on the source id anyway.
 *
 * Out: every message is egress-scanned first. A blocked message is never posted in any form; the thread gets one
 * notice without its content, under the same marker, so it is not tried again. Each message carries its marker's
 * hash in Slack metadata, and postComment looks in the thread first, so a marker is posted at most once. The
 * item's status is one message per thread, edited in place, with a link to the PR once there is one.
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
      const e = commentEvent(source, ts, who, said);
      return e ? { event: e, key } : null;
    }
    // app_mention: a command or `/link` after the mention is that command; else a request from the thread.
    if (parseLink(said) !== null || parseComment(said) !== null) {
      const e = commentEvent(source, ts, who, said);
      return e ? { event: e, key } : null;
    }
    if (inThread && (await this.d.store.getWorkItemBySource("slack_thread", source.id))) {
      return { event: { kind: "plain_comment", source, comment_id: ts, author: who, body: said }, key };
    }
    const title = (said.split(/\r?\n/)[0] ?? "").trim().slice(0, TITLE_MAX) || "Slack request";
    return { event: { kind: "item_requested", source, requester: who, title, body: said }, key };
  }

  /** A button press on one of the factory's messages: the command it names, as the presser typing it. */
  private fromInteraction(p: Record<string, unknown>, me: { team_id: string; user_id: string }): Mapped | null {
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
    const parsed = parseComment(body);
    if (parsed === null || parsed.kind !== "command") return null;
    const source = threadRef({ team, channel, thread_ts });
    const e = commentEvent(source, `action:${action_ts}`, { provider: "slack", subject: user }, body);
    return e ? { event: e, key: `action:${team}:${user}:${action_ts}` } : null;
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const t = this.thread(source);
    const me = await this.identity();
    const hash = markerHash(marker);
    const replies = await this.d.api.threadReplies(t.channel, t.thread_ts);
    const prior = replies.find((m) => this.ours(m, me.user_id) && m.metadata?.event_type === META_MESSAGE && m.metadata.event_payload.marker === hash);
    if (prior) return { url: slackLink(t.channel, prior.ts, t.thread_ts) };
    const msg = await this.scanned(renderComment(body, this.d.repo, me.user_id), source, marker);
    const { ts } = await this.d.api.postMessage({
      channel: t.channel,
      thread_ts: t.thread_ts,
      text: msg.text,
      blocks: msg.blocks,
      metadata: { event_type: META_MESSAGE, event_payload: { marker: hash } },
    });
    return { url: slackLink(t.channel, ts, t.thread_ts) };
  }

  /** Slack threads have no reaction scope here: the status message and the replies are the acknowledgement. */
  async markSeen(_source: SourceRef, _commentId: string | null): Promise<void> {}

  /**
   * One status message per thread, edited in place; it links the PR once the item has one. A PR's own status
   * (non-null `pr_number`) lives on GitHub: nothing to do here. Idempotent: the same status twice changes nothing.
   */
  async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    if (pr_number !== null) return;
    const t = this.thread(source);
    const me = await this.identity();
    const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
    const pr = item?.pr_number ? ` · <${prUrl(this.d.repo, item.pr_number)}|PR #${item.pr_number}>` : "";
    const text = `Status: *${escapeSlack(STATUS_WORDS[status] ?? status)}*${pr}`;
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      this.d.log.warn("slack status blocked by the egress scan; not posted", { source_id: source.id, rules: scan.findings.map((f) => f.rule).join(",") });
      return;
    }
    const replies = await this.d.api.threadReplies(t.channel, t.thread_ts);
    const prior = replies.find((m) => this.ours(m, me.user_id) && m.metadata?.event_type === META_STATUS);
    const metadata = { event_type: META_STATUS, event_payload: { status } };
    if (!prior) {
      await this.d.api.postMessage({ channel: t.channel, thread_ts: t.thread_ts, text, metadata });
      return;
    }
    if (prior.text === text) return;
    await this.d.api.updateMessage({ channel: t.channel, ts: prior.ts, text, metadata });
  }

  /** A Slack thread cannot be closed; the controller's reject or close comment says it in the thread. */
  async closeIssue(_source: SourceRef, _reason?: SourceCloseReason): Promise<void> {}

  /**
   * G5 on the whole message, buttons included. A finding withholds all of it: the notice names the rules only,
   * and nothing reworded, split or re-encoded from it is posted.
   */
  private async scanned(msg: SlackRendered, source: SourceRef, marker: string): Promise<SlackRendered> {
    const scan = await this.d.scanner.scan("comment", `${msg.text}\n${JSON.stringify(msg.blocks)}`);
    if (scan.clean) return msg;
    const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
    this.d.log.warn("slack message blocked by the egress scan; withheld", { source_id: source.id, marker_hash: markerHash(marker), rules });
    const text = `A factory message for this thread was withheld by the leak scanner (${escapeSlack(rules)}). It is not posted in any form.`;
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
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
