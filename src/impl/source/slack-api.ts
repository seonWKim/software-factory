import { secretName, type SecretName, type SecretStore } from "../../interfaces/secret-store.js";
import { retryAfterResetAt } from "../../shared/retry-after.js";

// The Slack Web API calls the `slack` source makes (issue #109), behind a small interface so tests use a fake.
// The two tokens are read from the SecretStore here, at the point of use, and go nowhere but the Authorization
// header of a request to slack.com: never into an event, a log line, the store, an error or a posted message.

/** The bot token (`xoxb-`): reads threads and posts in them, as the bot user. */
export const SLACK_BOT_TOKEN: SecretName = secretName("SLACK_BOT_TOKEN");
/** The app-level token (`xapp-`, scope `connections:write`): opens the Socket Mode connection, nothing else. */
export const SLACK_APP_TOKEN: SecretName = secretName("SLACK_APP_TOKEN");

/** What the factory attaches to its own messages, so it can find them again (Slack message metadata). */
export interface SlackMetadata {
  event_type: string;
  event_payload: Record<string, string>;
}

/** One message of a thread, as conversations.replies gives it; only the fields the source reads. */
export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  metadata?: SlackMetadata;
}

export interface SlackPost {
  channel: string;
  thread_ts: string;
  /** mrkdwn; the notification text when `blocks` are given. */
  text: string;
  blocks?: readonly unknown[];
  metadata?: SlackMetadata;
}

export interface SlackApi {
  /** auth.test with the bot token: the workspace ID and the bot's own user ID. */
  identity(): Promise<{ team_id: string; user_id: string }>;
  /** apps.connections.open with the app token: a one-time WebSocket URL for one Socket Mode connection. */
  openSocketUrl(): Promise<string>;
  /** chat.postMessage into a thread. */
  postMessage(m: SlackPost): Promise<{ ts: string }>;
  /** chat.update of a message the bot posted. */
  updateMessage(m: Omit<SlackPost, "thread_ts"> & { ts: string }): Promise<void>;
  /** conversations.replies with metadata: every message of the thread, the root first. */
  threadReplies(channel: string, thread_ts: string): Promise<SlackMessage[]>;
  /** reactions.add as the bot (scope `reactions:write`); a reaction already there counts as added. */
  react(channel: string, ts: string, name: string): Promise<void>;
}

/**
 * A failed Slack call. The message names the method and Slack's error code only. `status`: the HTTP status, or the
 * one a permanent refusal Slack sends as `ok: false` stands for (PERMANENT); `wait_until`: when a rate limit's
 * Retry-After ends. Outbound reads both (refusedForGood, the retry delay).
 */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status?: number,
    readonly wait_until?: string,
  ) {
    super(`slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

/** Slack error codes are short snake_case words; anything else is not echoed. */
function safeCode(v: unknown): string {
  return typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v) ? v : "unknown_error";
}

/**
 * The `ok: false` codes that are a permanent refusal, as the HTTP status a forge would send: the channel is gone or
 * the bot is not in it. Every other code (a token error among them) has no status and is retried.
 */
const PERMANENT: ReadonlyMap<string, number> = new Map([["channel_not_found", 404], ["not_in_channel", 403]]);

/** At most this many pages of thread replies are read (200 each). */
const MAX_REPLY_PAGES = 20;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** The Web API over HTTPS, with the tokens from the SecretStore. */
export class HttpSlackApi implements SlackApi {
  constructor(
    private readonly secrets: Pick<SecretStore, "get">,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
    private readonly baseUrl = "https://slack.com/api",
    /** Milliseconds since the epoch, for Retry-After in seconds. */
    private readonly now: () => number = Date.now,
  ) {}

  async identity(): Promise<{ team_id: string; user_id: string }> {
    const r = await this.call(SLACK_BOT_TOKEN, "auth.test", {}, "form");
    if (typeof r.team_id !== "string" || typeof r.user_id !== "string") throw new SlackApiError("auth.test", "no_identity");
    return { team_id: r.team_id, user_id: r.user_id };
  }

  async openSocketUrl(): Promise<string> {
    const r = await this.call(SLACK_APP_TOKEN, "apps.connections.open", {}, "form");
    if (typeof r.url !== "string" || !r.url.startsWith("wss://")) throw new SlackApiError("apps.connections.open", "no_url");
    return r.url;
  }

  async postMessage(m: SlackPost): Promise<{ ts: string }> {
    const r = await this.call(SLACK_BOT_TOKEN, "chat.postMessage", { ...m, unfurl_links: false, unfurl_media: false }, "json");
    if (typeof r.ts !== "string") throw new SlackApiError("chat.postMessage", "no_ts");
    return { ts: r.ts };
  }

  async updateMessage(m: Omit<SlackPost, "thread_ts"> & { ts: string }): Promise<void> {
    await this.call(SLACK_BOT_TOKEN, "chat.update", m, "json");
  }

  async threadReplies(channel: string, thread_ts: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_REPLY_PAGES; page++) {
      const args: Record<string, unknown> = { channel, ts: thread_ts, limit: 200, include_all_metadata: true };
      if (cursor) args.cursor = cursor;
      const r = await this.call(SLACK_BOT_TOKEN, "conversations.replies", args, "form");
      if (Array.isArray(r.messages)) out.push(...(r.messages as SlackMessage[]));
      const next = (r.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
    return out;
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call(SLACK_BOT_TOKEN, "reactions.add", { channel, timestamp: ts, name }, "json");
    } catch (err) {
      // A redelivered event reacts again: the reaction is there, which is what was asked.
      if (!(err instanceof SlackApiError && err.code === "already_reacted")) throw err;
    }
  }

  /** One call; throws SlackApiError on an HTTP error, a rate limit or `ok: false`. */
  private async call(token: SecretName, method: string, args: Record<string, unknown>, as: "json" | "form"): Promise<Record<string, unknown>> {
    const secret = await this.secrets.get(token);
    if (!secret) throw new SlackApiError(method, `missing_secret_${token.toLowerCase()}`);
    const body = as === "json"
      ? JSON.stringify(args)
      : new URLSearchParams(Object.entries(args).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const res = await this.fetchFn(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret.reveal()}`,
        "content-type": as === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
      },
      body,
    });
    if (res.status === 429) throw new SlackApiError(method, "rate_limited", 429, retryAfterResetAt(res.headers.get("retry-after"), this.now()));
    if (res.status >= 400) throw new SlackApiError(method, `http_${res.status}`);
    const r = (await res.json()) as Record<string, unknown>;
    if (r?.ok !== true) {
      const code = safeCode(r?.error);
      throw new SlackApiError(method, code, PERMANENT.get(code));
    }
    return r;
  }
}
