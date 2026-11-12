// A fake Slack for the `slack` source tests (issue #109): the Web API calls the source makes, and a Socket Mode
// connection a test pushes envelopes into. Every value here is an obvious fake: no token-shaped strings.

import { SlackApiError, type SlackApi, type SlackMessage, type SlackPost } from "../../src/impl/source/slack-api.js";
import type { SocketConnection, SocketConnector } from "../../src/impl/source/slack-socket.js";

export const TEAM = "T0TEAM";
export const BOT = "U0BOT";
export const CHANNEL = "C0LISTED";
export const OTHER_CHANNEL = "C0UNLISTED";

/** One message the fake Slack holds, in a thread. */
export interface FakeMessage extends SlackMessage {
  channel: string;
  thread_ts: string;
  blocks?: readonly unknown[];
}

export class FakeSlackApi implements SlackApi {
  messages: FakeMessage[] = [];
  /** Every write call in order, for "nothing else was posted" checks. */
  calls: { method: "postMessage" | "updateMessage"; text: string; blocks?: readonly unknown[] }[] = [];
  identityCalls = 0;
  /** conversations.replies calls (thread reads). */
  threadReplyCalls = 0;
  /** Reactions on messages, each at most once, as Slack keeps them; `reactCalls` counts every call. */
  reactions: { channel: string; ts: string; name: string }[] = [];
  reactCalls = 0;
  /** A Slack error code every react call fails with, e.g. `missing_scope`; null: reacting works. */
  failReact: string | null = null;
  /** Every views.open call that worked, in order. */
  views: { trigger_id: string; view: unknown }[] = [];
  /** A Slack error code every views.open call fails with, e.g. `expired_trigger_id`; null: opening works. */
  failViews: string | null = null;
  /** Called on each views.open before it answers (a test reads what was acked by then). */
  onOpenView: (() => void) | null = null;
  private next = 5000;

  async identity(): Promise<{ team_id: string; user_id: string }> {
    this.identityCalls++;
    return { team_id: TEAM, user_id: BOT };
  }
  async openSocketUrl(): Promise<string> {
    return "wss://socket.fake.test/link";
  }
  async postMessage(m: SlackPost): Promise<{ ts: string }> {
    const ts = `1800000000.${String(this.next++).padStart(6, "0")}`;
    this.calls.push({ method: "postMessage", text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}) });
    this.messages.push({
      ts, user: BOT, bot_id: "B0BOT", channel: m.channel, thread_ts: m.thread_ts, text: m.text,
      ...(m.blocks ? { blocks: m.blocks } : {}), ...(m.metadata ? { metadata: m.metadata } : {}),
    });
    return { ts };
  }
  async updateMessage(m: Omit<SlackPost, "thread_ts"> & { ts: string }): Promise<void> {
    this.calls.push({ method: "updateMessage", text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}) });
    const msg = this.messages.find((x) => x.channel === m.channel && x.ts === m.ts);
    if (!msg) throw new SlackApiError("chat.update", "message_not_found");
    msg.text = m.text;
    if (m.blocks) msg.blocks = m.blocks;
    if (m.metadata) msg.metadata = m.metadata;
  }
  async threadReplies(channel: string, thread_ts: string): Promise<SlackMessage[]> {
    this.threadReplyCalls++;
    return this.messages.filter((m) => m.channel === channel && m.thread_ts === thread_ts);
  }
  /** Like HttpSlackApi: a reaction already there is success, not a second one. */
  async react(channel: string, ts: string, name: string): Promise<void> {
    this.reactCalls++;
    if (this.failReact !== null) throw new SlackApiError("reactions.add", this.failReact);
    if (!this.reactions.some((r) => r.channel === channel && r.ts === ts && r.name === name)) this.reactions.push({ channel, ts, name });
  }

  async openView(trigger_id: string, view: unknown): Promise<void> {
    this.onOpenView?.();
    if (this.failViews !== null) throw new SlackApiError("views.open", this.failViews);
    this.views.push({ trigger_id, view });
  }
  /** Every views.update call, in order. */
  updatedViews: { view_id: string; view: unknown }[] = [];
  async updateView(view_id: string, view: unknown): Promise<void> {
    this.updatedViews.push({ view_id, view });
  }
  /** Every views.push call, in order. */
  pushedViews: { trigger_id: string; view: unknown }[] = [];
  async pushView(trigger_id: string, view: unknown): Promise<void> {
    this.pushedViews.push({ trigger_id, view });
  }

  /** The factory's messages in one thread. */
  thread(thread_ts: string, channel = CHANNEL): FakeMessage[] {
    return this.messages.filter((m) => m.channel === channel && m.thread_ts === thread_ts);
  }
  /** The action IDs of a message's buttons. */
  static buttons(m: FakeMessage): string[] {
    const actions = (m.blocks ?? []).find((b) => (b as { type: string }).type === "actions") as { elements: { action_id: string }[] } | undefined;
    return actions?.elements.map((e) => e.action_id) ?? [];
  }
}

/**
 * Socket Mode as the source sees it: every connection gets each envelope not acked yet (Slack redelivers
 * unacked envelopes on a new connection). `acks` are envelope IDs in the order the source sent them.
 */
export class FakeSocket {
  pending: { id: string; raw: string }[] = [];
  acks: string[] = [];
  connections = 0;
  open = 0;
  urls: string[] = [];
  /** While true, acks are lost on the way (the connection is dying): Slack keeps the envelope and redelivers it. */
  loseAcks = false;
  private wake: (() => void)[] = [];
  private current: { ended: boolean } | null = null;

  push(envelope: Record<string, unknown>): void {
    this.pending.push({ id: String(envelope.envelope_id), raw: JSON.stringify(envelope) });
    this.notify();
  }
  /** Ends the open connection, like a network drop. */
  drop(): void {
    if (this.current) this.current.ended = true;
    this.notify();
  }

  readonly connect: SocketConnector = async (url, signal) => {
    this.connections++;
    this.urls.push(url);
    const conn = { ended: false };
    this.current = conn;
    this.open++;
    const sent = new Set<string>();
    const self = this;
    async function* frames(): AsyncGenerator<string> {
      try {
        while (!signal.aborted && !conn.ended) {
          const d = self.pending.find((p) => !sent.has(p.id + p.raw) && !self.acks.includes(p.id));
          if (!d) {
            await new Promise<void>((r) => {
              self.wake.push(r);
              signal.addEventListener("abort", () => r(), { once: true });
            });
            continue;
          }
          sent.add(d.id + d.raw);
          yield d.raw;
        }
      } finally {
        self.open--;
      }
    }
    const c: SocketConnection = {
      messages: frames(),
      send: (data) => {
        if (conn.ended || this.loseAcks) return; // an ack on a dead connection is lost, as on Slack
        const id = (JSON.parse(data) as { envelope_id: string }).envelope_id;
        this.acks.push(id);
        this.pending = this.pending.filter((p) => p.id !== id);
      },
      close: () => {
        conn.ended = true;
        this.notify();
      },
    };
    return c;
  };

  private notify(): void {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }
}

let seq = 0;
const nextId = (p: string) => `${p}${(++seq).toString(36).toUpperCase().padStart(6, "0")}`;

/** An Events API envelope. */
export function eventEnvelope(event: Record<string, unknown>, event_id = nextId("Ev0"), envelope_id = nextId("env-")): Record<string, unknown> {
  return { type: "events_api", envelope_id, payload: { team_id: TEAM, event_id, event: { channel: CHANNEL, ...event } } };
}

/** A mention of the bot: `app_mention`, as Slack sends it. */
export function mention(ts: string, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "app_mention", user: "U0ALICE", ts, text: `<@${BOT}> ${text}`, ...over };
}

/** A plain channel message (`message.channels`). */
export function message(ts: string, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message", user: "U0ALICE", ts, text, ...over };
}

/** A button press (`block_actions`) on a message in thread `thread_ts`, with its `trigger_id`. */
export function press(thread_ts: string, action_id: string, value: string, user = "U0ALICE", action_ts = `${1800000100 + ++seq}.000001`): Record<string, unknown> {
  return {
    type: "interactive",
    envelope_id: nextId("env-"),
    payload: {
      type: "block_actions",
      trigger_id: `trigger-${action_ts}`,
      user: { id: user, name: "display-name-never-read", team_id: TEAM },
      team: { id: TEAM, domain: "fake-workspace" },
      channel: { id: CHANNEL, name: "channel-name-never-read" },
      container: { type: "message", channel_id: CHANNEL, thread_ts },
      message: { ts: "1800000000.999999", thread_ts },
      actions: [{ action_id, value, action_ts, type: "button" }],
    },
  };
}

/**
 * A button press (`block_actions`) inside an open modal `view` (its ID, callback ID and private_metadata), as Slack
 * sends it: no channel and no message, the view and its trigger_id instead.
 */
export function modalPress(view: { id: string; callback_id: string; private_metadata: string }, action_id: string, value: string, user = "U0ALICE", action_ts = `${1800000100 + ++seq}.000001`): Record<string, unknown> {
  return {
    type: "interactive",
    envelope_id: nextId("env-"),
    payload: {
      type: "block_actions",
      trigger_id: `trigger-${action_ts}`,
      user: { id: user, name: "display-name-never-read", team_id: TEAM },
      team: { id: TEAM, domain: "fake-workspace" },
      container: { type: "view", view_id: view.id },
      view: { ...view, type: "modal", root_view_id: view.id },
      actions: [{ action_id, value, action_ts, type: "button" }],
    },
  };
}

/**
 * A modal submit (`view_submission`): `values` maps each input block ID to its text, as Slack nests it under the
 * block and its one element's action ID.
 */
export function submission(view: { id: string; callback_id: string; private_metadata: string; root_view_id?: string }, values: Record<string, string>, user = "U0ALICE"): Record<string, unknown> {
  const state = Object.fromEntries(Object.entries(values).map(([block, value]) => [block, { answer: { type: "plain_text_input", value } }]));
  return {
    type: "interactive",
    envelope_id: nextId("env-"),
    payload: {
      type: "view_submission",
      user: { id: user, name: "display-name-never-read", team_id: TEAM },
      team: { id: TEAM, domain: "fake-workspace" },
      view: { ...view, type: "modal", state: { values: state } },
    },
  };
}
