import { type SecretStore, secretName } from "../../interfaces/secret-store.js";

// The Slack calls the slack source makes, behind one interface so tests use a fake client. The real client
// below speaks Socket Mode over Node's built-in WebSocket and the Web API over fetch: no Slack SDK. It is the
// only code that reads the Slack tokens, and only at the point of use; a token never reaches an error, a log
// line, an event or a message.

export const SLACK_APP_TOKEN = secretName("SLACK_APP_TOKEN");
export const SLACK_BOT_TOKEN = secretName("SLACK_BOT_TOKEN");

/** One Socket Mode envelope: `events_api`, `interactive`, `hello`, `disconnect`, ... `payload` is untrusted. */
export interface SlackEnvelope {
  type: string;
  /** Absent on `hello` and `disconnect`, which take no ack. */
  envelope_id?: string;
  payload?: unknown;
}

/** One open Socket Mode connection: its envelopes until it ends, and the ack Slack waits for. */
export interface SlackConnection extends AsyncIterable<SlackEnvelope> {
  /** Tells Slack the envelope is handled; an envelope never acked is delivered again. */
  ack(envelope_id: string): Promise<void>;
  close(): void;
}

/** A message in a thread, as `conversations.replies` gives it; only the fields the source reads. */
export interface SlackMessage {
  ts: string;
  /** The factory's marker, from the message metadata the source attaches to every post. */
  marker: string | null;
}

export interface SlackPost {
  channel: string;
  thread_ts: string;
  text: string;
  blocks: readonly unknown[];
  /** Stored as message metadata (`factory_comment`), so a later post with it can be found and skipped. */
  marker: string;
}

export interface SlackClient {
  /** The bot's own user id and workspace (`auth.test`). */
  whoami(): Promise<{ team_id: string; user_id: string }>;
  /** Opens one Socket Mode connection (`apps.connections.open`). */
  connect(signal: AbortSignal): Promise<SlackConnection>;
  /** The thread's messages with their markers (`conversations.replies`, metadata included). */
  replies(channel: string, thread_ts: string): Promise<SlackMessage[]>;
  /** Posts one message in the thread (`chat.postMessage`); returns its ts. */
  post(p: SlackPost): Promise<{ ts: string }>;
}

/** The metadata event type that carries a factory marker. */
export const MARKER_EVENT = "factory_comment";

const API = "https://slack.com/api/";
/** Replies read per thread when looking for a marker: one page. */
const REPLIES_LIMIT = 200;

/**
 * The real client. Tokens come from the SecretStore on each call (G1: only this tool code sees them) and go
 * only into the Authorization header. Errors carry the Slack method and Slack's short error code, nothing else.
 */
export class SlackWebClient implements SlackClient {
  constructor(private readonly secrets: SecretStore, private readonly fetchFn: typeof fetch = fetch) {}

  async whoami(): Promise<{ team_id: string; user_id: string }> {
    const r = await this.call("auth.test", SLACK_BOT_TOKEN, {});
    return { team_id: String(r.team_id ?? ""), user_id: String(r.user_id ?? "") };
  }

  async connect(signal: AbortSignal): Promise<SlackConnection> {
    const r = await this.call("apps.connections.open", SLACK_APP_TOKEN, {});
    if (typeof r.url !== "string") throw new Error("slack apps.connections.open failed: no url");
    return openSocket(r.url, signal);
  }

  async replies(channel: string, thread_ts: string): Promise<SlackMessage[]> {
    const r = await this.call("conversations.replies", SLACK_BOT_TOKEN, {
      channel, ts: thread_ts, include_all_metadata: true, limit: REPLIES_LIMIT,
    });
    const messages = Array.isArray(r.messages) ? (r.messages as Record<string, unknown>[]) : [];
    return messages.map((m) => {
      const meta = m.metadata as { event_type?: unknown; event_payload?: { marker?: unknown } } | undefined;
      const marker = meta?.event_type === MARKER_EVENT && typeof meta.event_payload?.marker === "string" ? meta.event_payload.marker : null;
      return { ts: String(m.ts ?? ""), marker };
    });
  }

  async post(p: SlackPost): Promise<{ ts: string }> {
    const r = await this.call("chat.postMessage", SLACK_BOT_TOKEN, {
      channel: p.channel,
      thread_ts: p.thread_ts,
      text: p.text,
      blocks: p.blocks,
      unfurl_links: false,
      metadata: { event_type: MARKER_EVENT, event_payload: { marker: p.marker } },
    });
    return { ts: String(r.ts ?? "") };
  }

  private async call(method: string, token: typeof SLACK_APP_TOKEN, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const secret = await this.secrets.get(token);
    if (!secret) throw new Error(`slack ${method} failed: ${token} is not set (run: npm run setup)`);
    const res = await this.fetchFn(API + method, {
      method: "POST",
      headers: { authorization: `Bearer ${secret.reveal()}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.ok !== true) {
      const code = typeof json.error === "string" && /^[a-z_]{1,60}$/.test(json.error) ? json.error : `http_${res.status}`;
      throw new Error(`slack ${method} failed: ${code}`);
    }
    return json;
  }
}

/** One WebSocket as a SlackConnection. The URL is a one-time ticket: never logged. */
function openSocket(url: string, signal: AbortSignal): SlackConnection {
  const ws = new WebSocket(url);
  const queue: SlackEnvelope[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const end = (err: Error | null) => {
    if (ended) return;
    ended = true;
    failure = err;
    notify();
  };
  ws.addEventListener("message", (m) => {
    try {
      const env = JSON.parse(String(m.data)) as SlackEnvelope;
      if (env && typeof env.type === "string") queue.push(env);
    } catch {
      // Not JSON: not an envelope; Slack sends none such.
    }
    notify();
  });
  ws.addEventListener("close", () => end(null));
  ws.addEventListener("error", () => end(new Error("slack socket failed")));
  const onAbort = () => {
    end(null);
    ws.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const opened = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) resolve();
    else ws.addEventListener("open", () => resolve(), { once: true });
  });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const env = queue.shift();
          if (env) {
            yield env;
            continue;
          }
          if (ended) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    async ack(envelope_id: string) {
      await opened;
      ws.send(JSON.stringify({ envelope_id }));
    },
    close() {
      signal.removeEventListener("abort", onAbort);
      ws.close();
    },
  };
}
