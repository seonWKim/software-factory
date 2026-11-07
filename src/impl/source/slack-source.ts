import { COMMANDS, type CommandName, parseComment } from "../../core/commands.js";
import type { Logger } from "../../core/log.js";
import type { SourceRef } from "../../core/types.js";
import type { ExternalIdentity } from "../../interfaces/auth-provider.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { PushedEvent, SourceCloseReason, SourceEvent, StreamSource } from "../../interfaces/source-adapter.js";
import type { WorkStatus } from "../../core/status-label.js";
import { commentEvent } from "./local-source.js";
import type { SlackClient, SlackEnvelope } from "./slack-client.js";

/**
 * The `slack` stream source (issue #109): Socket Mode intake from the channels listed in the `slack` config
 * block, replies in the item's thread. A mention of the bot starts an item from its thread; replies in that
 * thread and button presses become the same command events a GitHub comment gives, so the controller's command
 * table and its AuthProvider check decide every one. Events carry Slack IDs only, never a display name.
 */

/** The commands that get a button: those that take no text (decision 2). Reject, revise and verdict stay typed. */
export const BUTTON_COMMANDS: readonly CommandName[] = ["approve", "retry", "resolve", "budget", "help"];

const LABELS: Partial<Record<CommandName, string>> = {
  approve: "Approve", retry: "Retry", resolve: "Resolve", budget: "Continue (budget)", help: "Help",
};

/** The heading of the "commands that apply now" list every waiting comment ends with (commandFooter). */
const FOOTER_HEADING = "Commands you can reply with now:";
const COMMAND_ACTION = "factory:cmd:";
export const CONFIRM_ACTION = "factory:confirm";
export const CANCEL_ACTION = "factory:cancel";
/** The marker prefix of a plain-language suggestion reply (the controller's handlePlainComment). */
const SUGGEST_MARKER = "<!-- factory:suggest:";

/** What the thread gets instead of a message the egress scan blocked. Fixed text: nothing of the message. */
export const WITHHELD_NOTICE =
  "A factory message for this thread was withheld: the leak scanner blocked it, so it was not posted and will not be posted again. The factory log names the rule that matched.";

/** Section blocks hold at most 3000 characters; a message at most 50 blocks. */
const SECTION_CHARS = 2900;
const MAX_SECTIONS = 45;
/** A button's value holds at most 2000 characters. */
const VALUE_CHARS = 2000;
const TITLE_CHARS = 80;

const TEAM_ID = /^T[A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const USER_ID = /^[UW][A-Z0-9]+$/;
const TS = /^\d+\.\d+$/;

/** The work item source id of a thread: `slack:<team id>:<channel id>:<thread ts>`. */
export function slackSourceId(team: string, channel: string, thread_ts: string): string {
  return `slack:${team}:${channel}:${thread_ts}`;
}

export function parseSlackSourceId(id: string): { team: string; channel: string; thread_ts: string } | null {
  const m = /^slack:(T[A-Z0-9]+):([CG][A-Z0-9]+):(\d+\.\d+)$/.exec(id);
  return m ? { team: m[1]!, channel: m[2]!, thread_ts: m[3]! } : null;
}

export function slackThreadRef(team: string, channel: string, thread_ts: string): SourceRef {
  return {
    type: "slack_thread",
    id: slackSourceId(team, channel, thread_ts),
    link: `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${thread_ts}`,
  };
}

/** The commands with a button that the body's "apply now" list names, in command table order. */
export function buttonCommands(body: string): CommandName[] {
  const at = body.lastIndexOf(FOOTER_HEADING);
  if (at < 0) return [];
  const footer = body.slice(at);
  return COMMANDS.filter((c) => BUTTON_COMMANDS.includes(c.name) && footer.includes(`\`${c.usage}\``)).map((c) => c.name);
}

/** The command a suggestion reply offers, as typed, or null for any other message. */
export function suggestedCommand(body: string, marker: string): string | null {
  if (!marker.startsWith(SUGGEST_MARKER)) return null;
  const m = /^(`{3,})\n([\s\S]*?)\n\1$/m.exec(body);
  const typed = m?.[2]?.trim() ?? "";
  return typed !== "" && typed.length <= VALUE_CHARS && parseComment(typed)?.kind === "command" ? typed : null;
}

/** GitHub-flavoured markdown as Slack mrkdwn: escapes `&`, `<`, `>`; links, bold and headings. */
export function toMrkdwn(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

/** Slack's escapes in message text, undone, so a typed command reads as the person wrote it. */
function unescape(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const button = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id,
  value,
  ...(style ? { style } : {}),
});

/** The message for `body`: its text, sections and, when it offers any, one row of buttons. */
export function messageFor(body: string, marker: string): { text: string; blocks: unknown[]; values: string[] } {
  const text = toMrkdwn(body.replace(/<!-- factory:[^>]*-->/g, "").trim());
  const sections: unknown[] = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    const next = chunk === "" ? line : `${chunk}\n${line}`;
    if (next.length <= SECTION_CHARS) {
      chunk = next;
      continue;
    }
    if (chunk !== "") sections.push(chunk);
    chunk = line.slice(0, SECTION_CHARS);
  }
  if (chunk !== "") sections.push(chunk);
  const blocks: unknown[] = sections.slice(0, MAX_SECTIONS).map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
  const typed = suggestedCommand(body, marker);
  const buttons = typed !== null
    ? [button("Confirm", CONFIRM_ACTION, typed, "primary"), button("Cancel", CANCEL_ACTION, "cancel")]
    : buttonCommands(body).map((n) => button(LABELS[n] ?? n, `${COMMAND_ACTION}${n}`, n, n === "approve" ? "primary" : undefined));
  if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  return { text, blocks, values: buttons.map((b) => b.value) };
}

/** What a connection knows about the workspace: the listed channels and the bot's own ids. */
export interface SlackContext {
  channels: ReadonlySet<string>;
  team_id: string;
  bot_user_id: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A person by Slack user id only: no name, no handle (`login` stays unset). */
const person = (user: string): ExternalIdentity => ({ provider: "slack", subject: user });

/**
 * The event one envelope gives, with its dedupe key, or null for one that starts nothing: a channel not on
 * the list, a bot's or the factory's own message, an edit, a top-level message that does not mention the bot,
 * a Cancel press, anything malformed. The dedupe key is Slack's event id (an action: its action ts), the same
 * on every redelivery.
 */
export function envelopeEvent(env: SlackEnvelope, ctx: SlackContext): { event: SourceEvent; dedupe_key: string } | null {
  const p = obj(env.payload);
  if (env.type === "events_api") return messageEvent(p, ctx);
  if (env.type === "interactive" && p.type === "block_actions") return actionEvent(p, ctx);
  return null;
}

function messageEvent(p: Obj, ctx: SlackContext): { event: SourceEvent; dedupe_key: string } | null {
  const event_id = str(p.event_id);
  const team = str(p.team_id) || ctx.team_id;
  const ev = obj(p.event);
  const channel = str(ev.channel);
  const user = str(ev.user);
  const ts = str(ev.ts);
  if (!event_id || !TEAM_ID.test(team) || !ctx.channels.has(channel) || !USER_ID.test(user) || !TS.test(ts)) return null;
  if (ev.bot_id !== undefined || user === ctx.bot_user_id) return null;
  const thread = str(ev.thread_ts) || ts;
  if (!TS.test(thread)) return null;
  const mention = `<@${ctx.bot_user_id}>`;
  const text = unescape(str(ev.text));
  const source = slackThreadRef(team, channel, thread);
  if (ev.type === "app_mention") {
    const body = text.split(mention).join("").trim();
    const first = (body.split("\n")[0] ?? "").trim();
    const title = first === "" ? "Slack request" : first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1)}…` : first;
    return { event: { kind: "item_requested", source, requester: person(user), title, body }, dedupe_key: event_id };
  }
  // A reply in a thread; a mention is intake (its app_mention event), never also a command.
  if (ev.type !== "message" || ev.subtype !== undefined || thread === ts || text.includes(mention)) return null;
  const event = commentEvent(text, source, `msg-${ts}`, person(user));
  return event ? { event, dedupe_key: event_id } : null;
}

function actionEvent(p: Obj, ctx: SlackContext): { event: SourceEvent; dedupe_key: string } | null {
  const team = str(obj(p.team).id) || ctx.team_id;
  const user = str(obj(p.user).id);
  const channel = str(obj(p.channel).id) || str(obj(p.container).channel_id);
  const message = obj(p.message);
  const thread = str(message.thread_ts) || str(message.ts);
  const action = obj(Array.isArray(p.actions) ? p.actions[0] : undefined);
  const action_ts = str(action.action_ts);
  const action_id = str(action.action_id);
  if (!TEAM_ID.test(team) || !USER_ID.test(user) || !ctx.channels.has(channel) || !TS.test(thread) || !TS.test(action_ts)) return null;
  const source = slackThreadRef(team, channel, thread);
  let typed: string | null = null;
  if (action_id.startsWith(COMMAND_ACTION)) {
    const name = action_id.slice(COMMAND_ACTION.length) as CommandName;
    typed = BUTTON_COMMANDS.includes(name) ? `/${name}` : null;
  } else if (action_id === CONFIRM_ACTION) {
    const value = str(action.value);
    typed = parseComment(value)?.kind === "command" ? value : null;
  }
  // Cancel, and any button the factory did not post, start nothing.
  if (typed === null) return null;
  const event = commentEvent(typed, source, `action-${action_ts}`, person(user));
  return event ? { event, dedupe_key: `action:${action_ts}` } : null;
}

export interface SlackSourceDeps {
  client: SlackClient;
  /** The checked `slack.channels`. */
  channels: readonly string[];
  /** G5: every message is scanned before it is posted. */
  scanner: EgressScanner;
  log: Logger;
}

export class SlackSource implements StreamSource {
  readonly type = "slack_thread" as const;
  readonly intake = "stream" as const;
  private readonly channels: ReadonlySet<string>;

  constructor(private readonly d: SlackSourceDeps) {
    this.channels = new Set(d.channels);
  }

  /**
   * One Socket Mode connection. An envelope that starts nothing is acked at once; any other is yielded and
   * acked only by the listener, once its inbox write committed. A `disconnect` envelope ends the connection.
   */
  async *subscribe(signal: AbortSignal): AsyncGenerator<PushedEvent> {
    const me = await this.d.client.whoami();
    const ctx: SlackContext = { channels: this.channels, team_id: me.team_id, bot_user_id: me.user_id };
    const conn = await this.d.client.connect(signal);
    try {
      for await (const env of conn) {
        if (signal.aborted || env.type === "disconnect") return;
        const id = env.envelope_id;
        if (!id) continue;
        const mapped = envelopeEvent(env, ctx);
        if (!mapped) {
          await conn.ack(id);
          continue;
        }
        yield { ...mapped, ack: () => conn.ack(id) };
      }
    } finally {
      conn.close();
    }
  }

  /**
   * Posts in the item's thread at most once per marker: the thread's replies are read first, and a message
   * with the marker in its metadata means it is there. The message, its buttons included, passes the egress
   * scan first. A blocked message is never posted, and never retried in any other form: the thread gets one
   * fixed withheld notice that carries the same marker, so a later call finds it and posts nothing.
   */
  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    const t = parseSlackSourceId(source.id);
    if (!t) throw new Error(`slack source: not a Slack thread source id: ${JSON.stringify(source.id.slice(0, 80))}`);
    const existing = await this.d.client.replies(t.channel, t.thread_ts);
    if (existing.some((m) => m.marker === marker)) return { url: source.link };
    const msg = messageFor(body, marker);
    const scan = await this.d.scanner.scan("comment", [body, msg.text, ...msg.values].join("\n"));
    if (!scan.clean) {
      const rules = scan.findings.map((f) => f.rule).join(",");
      this.d.log.warn("slack message withheld by the egress scan; not posted, not retried", { source_id: source.id, rules });
      const notice = messageFor(WITHHELD_NOTICE, "");
      if ((await this.d.scanner.scan("comment", notice.text)).clean) {
        await this.d.client.post({ channel: t.channel, thread_ts: t.thread_ts, text: notice.text, blocks: notice.blocks, marker });
      }
      return { url: null };
    }
    await this.d.client.post({ channel: t.channel, thread_ts: t.thread_ts, text: msg.text, blocks: msg.blocks, marker });
    return { url: source.link };
  }

  /** No reaction: the app has no `reactions:write` scope. A command's effect, or its refusal, is the reply. */
  async markSeen(_source: SourceRef, _commentId: string | null): Promise<void> {}

  /** Slack threads have no labels; the thread's replies say where the item is. */
  async setStatus(_source: SourceRef, _status: WorkStatus, _pr_number: number | null): Promise<void> {}

  /** A thread does not close; the reject reply says the item is closed. */
  async closeIssue(_source: SourceRef, _reason?: SourceCloseReason): Promise<void> {}
}
