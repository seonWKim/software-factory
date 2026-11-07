// The `slack` stream source (issue #109), on a fake Slack client: intake from listed channels, thread replies with
// command buttons, typed commands, the permission check on every action, and the egress rule for every post.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfigKeys } from "../src/config-keys.js";
import { commandState, commandsFor } from "../src/core/commands.js";
import { slackConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { Listener } from "../src/core/listener.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { AuthAction, AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMResponse } from "../src/interfaces/llm-provider.js";
import { type Secret, type SecretName, type SecretStore } from "../src/interfaces/secret-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import {
  type SlackClient, type SlackConnection, type SlackEnvelope, type SlackMessage, type SlackPost, SlackWebClient,
} from "../src/impl/source/slack-client.js";
import { BUTTON_COMMANDS, CANCEL_ACTION, CONFIRM_ACTION, SlackSource, WITHHELD_NOTICE } from "../src/impl/source/slack-source.js";
import slackPlugin from "../src/impl/source/slack.plugin.js";
import { REGISTRY } from "../src/plugins.js";
import { FakeSource, cleanScanner, config, recordingLog, triageSpec, waitFor } from "./helpers/fakes.js";
import { newStore, w1 } from "./helpers/store.js";

const TEAM = "T0TEAM";
const BOT = "U0BOT";
const CHANNEL = "C0LISTED";
const OTHER = "C0OTHER";
/** Known and allowed; known and denied; not known to the factory at all. */
const ALLOWED = "U0ALLOW";
const DENIED = "U0DENY";
const STRANGER = "U0WHO";
// Built at runtime, so this file itself holds no token-shaped literal for the repository's own scan.
const GH_TOKEN = ["ghp", "PLANTEDgithubTOKEN0123456789abcdef"].join("_");
const APP_TOKEN = ["xapp", "1", "PLANTEDappTOKEN0123456789"].join("-");
const BOT_TOKEN = ["xoxb", "PLANTEDbotTOKEN0123456789"].join("-");
/** Names a Slack payload may carry; none may reach the store, events or logs. */
const NAMES = ["Alice Display", "alice.real", "alice_username"];

/** Socket Mode as Slack runs it: each connection delivers every envelope not acked yet. */
class FakeSlackClient implements SlackClient {
  pending: SlackEnvelope[] = [];
  acks: string[] = [];
  posts: SlackPost[] = [];
  connects = 0;
  private wake: (() => void)[] = [];
  private live: { ended: boolean } | null = null;
  private n = 0;

  async whoami() {
    return { team_id: TEAM, user_id: BOT };
  }
  push(env: SlackEnvelope): void {
    this.pending.push(env);
    this.notify();
  }
  disconnect(): void {
    if (this.live) this.live.ended = true;
    this.notify();
  }
  async connect(signal: AbortSignal): Promise<SlackConnection> {
    this.connects++;
    const conn = { ended: false };
    this.live = conn;
    const sent = new Set<SlackEnvelope>();
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted && !conn.ended) {
          const env = self.pending.find((e) => !sent.has(e));
          if (!env) {
            await new Promise<void>((r) => {
              self.wake.push(r);
              signal.addEventListener("abort", () => r(), { once: true });
            });
            continue;
          }
          sent.add(env);
          yield env;
        }
      },
      async ack(id: string) {
        self.acks.push(id);
        self.pending = self.pending.filter((e) => e.envelope_id !== id);
      },
      close() {},
    };
  }
  async replies(channel: string, thread_ts: string): Promise<SlackMessage[]> {
    return this.posts.filter((p) => p.channel === channel && p.thread_ts === thread_ts).map((p, i) => ({ ts: `${i}.1`, marker: p.marker }));
  }
  async post(p: SlackPost): Promise<{ ts: string }> {
    this.posts.push(p);
    return { ts: `${++this.n}.000` };
  }
  private notify(): void {
    for (const w of this.wake.splice(0)) w();
  }
}

/** Slack users U0ALLOW and U0DENY are factory users (only the first may act); anyone else is unknown. Records every call. */
class RecordingAuth implements AuthProvider {
  authorized: { user_id: string; action: AuthAction }[] = [];
  async resolve(id: ExternalIdentity): Promise<Principal | null> {
    if (id.provider === "slack" && (id.subject === ALLOWED || id.subject === DENIED)) return { user_id: `u:${id.subject}` as UserId, attributes: {} };
    if (id.provider === "github") return { user_id: `github:${id.subject}` as UserId, attributes: {} };
    return null;
  }
  async authorize(p: Principal, action: AuthAction): Promise<AuthDecision> {
    this.authorized.push({ user_id: p.user_id, action });
    return p.user_id === `u:${DENIED}` ? { allow: false, reason: "denied_by_test" } : { allow: true };
  }
}

class ApproveLLM implements LLMProvider {
  async complete(): Promise<LLMResponse> {
    const parsed = { command: "approve", args: "", confidence: 0.95 };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

let seq = 0;
const nextTs = () => `17000000${String(++seq).padStart(2, "0")}.000100`;

function mention(channel = CHANNEL, ts = nextTs(), event_id = `Ev${ts.replace(".", "")}`): SlackEnvelope {
  return {
    type: "events_api",
    envelope_id: `env-${event_id}-${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      team_id: TEAM, event_id,
      event: {
        type: "app_mention", channel, user: ALLOWED, ts, text: `<@${BOT}> Add a CI scope gate\nplease`,
        user_profile: { display_name: NAMES[0], real_name: NAMES[1], name: NAMES[2] },
      },
    },
  };
}

function reply(thread: string, text: string, user = ALLOWED): SlackEnvelope {
  const ts = nextTs();
  return {
    type: "events_api",
    envelope_id: `env-r${ts}`,
    payload: { team_id: TEAM, event_id: `Evr${ts.replace(".", "")}`, event: { type: "message", channel: CHANNEL, user, ts, thread_ts: thread, text, user_profile: { display_name: NAMES[0] } } },
  };
}

function press(thread: string, action_id: string, value: string, user = ALLOWED): SlackEnvelope {
  const action_ts = nextTs();
  return {
    type: "interactive",
    envelope_id: `env-a${action_ts}`,
    payload: {
      type: "block_actions", team: { id: TEAM }, user: { id: user, username: NAMES[2], name: NAMES[2] }, channel: { id: CHANNEL },
      message: { ts: nextTs(), thread_ts: thread }, actions: [{ action_id, value, action_ts }],
    },
  };
}

const running: AbortController[] = [];
afterEach(() => {
  for (const ac of running.splice(0)) ac.abort();
});

async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function setup(opts: { scanner?: EgressScanner; store?: (s: FactoryStore) => FactoryStore } = {}) {
  const clock = new FakeClock();
  const { store: real } = await newStore(clock);
  const store = opts.store ? opts.store(real) : real;
  const log = recordingLog();
  const client = new FakeSlackClient();
  const scanner = opts.scanner ?? cleanScanner;
  const slack = new SlackSource({ client, channels: [CHANNEL], scanner, log });
  const gh = new FakeSource();
  const auth = new RecordingAuth();
  const controller = new Controller({ store: real, sources: [gh, slack], auth, clock, config, log, scanner, llm: new ApproveLLM() });
  const ac = new AbortController();
  running.push(ac);
  void new Listener({ store, source: slack, clock, config, log, owner: "replica-a", reconnect: { base_ms: 1_000, max_ms: 1_000 } }).run(ac.signal);
  /** Delivers `env`, waits for its ack (or a flush), then lets the controller read the inbox. */
  const deliver = async (env: SlackEnvelope, acked = true) => {
    client.push(env);
    if (acked) await waitFor(() => client.acks.includes(env.envelope_id!), "ack");
    else await flush();
    await controller.tickIntake();
  };
  return { clock, store: real, log, client, slack, gh, auth, controller, deliver };
}

type F = Awaited<ReturnType<typeof setup>>;

const sourceId = (thread: string, channel = CHANNEL) => `slack:${TEAM}:${channel}:${thread}`;
const itemOf = (f: F, thread: string) => f.store.getWorkItemBySource("slack_thread", sourceId(thread));

/** A Slack item at spec_pending: a mention, then its triage run done with `spec`. */
async function specPending(f: F, spec: Record<string, unknown> = triageSpec): Promise<{ thread: string; item: WorkItem }> {
  const env = mention();
  const thread = (env.payload as { event: { ts: string } }).event.ts;
  await f.deliver(env);
  await finishAll(f, "triage", { spec });
  return { thread, item: (await itemOf(f, thread))! };
}

async function finishAll(f: F, kind: "triage" | "implement" | "review", data: Record<string, unknown>): Promise<void> {
  for (;;) {
    const run = await f.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
    if (!run) break;
    await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data });
  }
  await f.controller.tickRuns();
}

const buttonsOf = (p: SlackPost) =>
  (p.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).flatMap((b) => (b.type === "actions" ? b.elements ?? [] : []));
const fields = (it: WorkItem | null) => it && { stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason, version: it.version };

describe("slack plugin: descriptor, secrets and config", () => {
  it("is a source plugin named slack, with intake stream and the two Slack tokens, each with a one-line purpose", () => {
    expect(REGISTRY.source.plugins.slack).toBeTypeOf("function");
    expect(slackPlugin.kind).toBe("source");
    const decls = REGISTRY.source.secrets.slack!;
    expect(decls.map((d) => d.name).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    for (const d of decls) {
      expect(d.purpose.trim()).not.toBe("");
      expect(d.purpose).not.toContain("\n");
    }
    expect(new SlackSource({ client: new FakeSlackClient(), channels: [CHANNEL], scanner: cleanScanner, log: recordingLog() }).intake).toBe("stream");
  });

  it("reads its channel IDs from the slack block; an unknown key or a bad channel fails at load", () => {
    expect(slackConfig({ slack: { channels: [CHANNEL] } })).toEqual({ channels: [CHANNEL] });
    expect(() => checkConfigKeys({ slack: { channels: [CHANNEL] } })).not.toThrow();
    expect(() => checkConfigKeys({ slack: { channels: [CHANNEL], chanels: [] } })).toThrow(/unknown config key "chanels" at slack\.chanels/);
    expect(() => checkConfigKeys({ slack: { channels: ["#general"] } })).toThrow(/slack\.channels/);
    expect(() => checkConfigKeys({ slack: { channels: [] } })).toThrow(/slack\.channels/);
    expect(() => slackConfig({})).toThrow(/slack/);
  });

  it("never reads GITHUB_TOKEN or any GitHub credential: declared secrets and actual reads are Slack tokens only", async () => {
    const declared = REGISTRY.source.secrets.slack!.map((d) => d.name as string);
    expect(declared.filter((n) => /GITHUB|GH_/.test(n))).toEqual([]);
    const secrets = new MapSecrets({ GITHUB_TOKEN: GH_TOKEN, SLACK_APP_TOKEN: APP_TOKEN, SLACK_BOT_TOKEN: BOT_TOKEN });
    const web = new SlackWebClient(secrets, fakeFetch().fn);
    await web.whoami();
    await web.replies(CHANNEL, "1.1");
    await web.post({ channel: CHANNEL, thread_ts: "1.1", text: "t", blocks: [], marker: "m" });
    await web.connect(new AbortController().signal).catch(() => undefined);
    expect([...new Set(secrets.reads)].sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    // Through the descriptor too: building it reads nothing yet.
    const built = await slackPlugin.create({ loaded: { file: { slack: { channels: [CHANNEL] } } }, secrets, scanner: cleanScanner, clock: new FakeClock() } as never);
    expect(built.type).toBe("slack_thread");
    expect(secrets.reads.filter((n) => !n.startsWith("SLACK_"))).toEqual([]);
  });

  it("neither Slack token reaches an error, a request body or a returned value; only the Authorization header", async () => {
    const secrets = new MapSecrets({ SLACK_APP_TOKEN: APP_TOKEN, SLACK_BOT_TOKEN: BOT_TOKEN });
    const ok = fakeFetch();
    const web = new SlackWebClient(secrets, ok.fn);
    const out = JSON.stringify([await web.whoami(), await web.replies(CHANNEL, "1.1"), await web.post({ channel: CHANNEL, thread_ts: "1.1", text: "t", blocks: [], marker: "m" })]);
    const failing = new SlackWebClient(secrets, fakeFetch({ ok: false, error: "invalid_auth" }).fn);
    const errors = await Promise.all(([failing.whoami(), failing.connect(new AbortController().signal), failing.post({ channel: CHANNEL, thread_ts: "1.1", text: "t", blocks: [], marker: "m" })] as Promise<unknown>[])
      .map((p) => p.then(() => "", (e: Error) => e.message)));
    expect(errors.every((m) => m.includes("invalid_auth"))).toBe(true);
    for (const text of [out, ...errors, ...ok.calls.map((c) => c.body)]) {
      expect(text).not.toContain(APP_TOKEN);
      expect(text).not.toContain(BOT_TOKEN);
    }
    expect(ok.calls.map((c) => c.auth)).toContain(`Bearer ${BOT_TOKEN}`);
  });
});

describe("slack intake", () => {
  it("a message in a channel not on the list starts nothing", async () => {
    const f = await setup();
    const env = mention(OTHER);
    await f.deliver(env);
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);
    const thread = (env.payload as { event: { ts: string } }).event.ts;
    expect(await f.store.getWorkItemBySource("slack_thread", sourceId(thread, OTHER))).toBeNull();
    expect(f.client.posts).toEqual([]);
  });

  it("a mention in a listed channel creates exactly one item, source id slack:<team>:<channel>:<thread ts>", async () => {
    const f = await setup();
    const env = mention();
    const thread = (env.payload as { event: { ts: string } }).event.ts;
    await f.deliver(env);
    await f.controller.tickIntake();
    const item = (await itemOf(f, thread))!;
    expect(item.source.id).toBe(`slack:${TEAM}:${CHANNEL}:${thread}`);
    expect(item.title).toBe("Add a CI scope gate");
    expect((await f.store.listRuns(item.id)).filter((r) => r.kind === "triage")).toHaveLength(1);
  });

  it("stored fields, events and logs hold IDs only: no Slack display name or user name", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    await f.deliver(press(thread, "factory:cmd:approve", "approve"));
    await f.deliver(reply(thread, "/help"));
    const dump = JSON.stringify([
      await f.store.getWorkItem(item.id), await f.store.listStateChanges(item.id), await f.store.listInboxAfter("slack_thread", 0, 100), f.log.lines,
    ]);
    for (const name of NAMES) expect(dump).not.toContain(name);
    expect(dump).toContain(ALLOWED);
  });

  it("acks an event only after its inbox write commits; a failed write leaves it unacked and it comes back", async () => {
    let fail = true;
    const f = await setup({
      store: (s) => new Proxy(s, {
        get(t, prop, r) {
          if (prop === "appendInbox") return (...a: Parameters<FactoryStore["appendInbox"]>) => (fail ? Promise.reject(new Error("db down")) : t.appendInbox(...a));
          const v = Reflect.get(t, prop, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    });
    const env = mention();
    await f.deliver(env, false);
    expect(f.client.acks).toEqual([]);
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);
    fail = false;
    // The listener reconnects after its backoff; the unacked envelope is delivered again.
    for (let i = 0; i < 20 && !f.client.acks.includes(env.envelope_id!); i++) {
      f.clock.advance(1_000);
      await flush();
    }
    expect(f.client.acks).toContain(env.envelope_id);
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toHaveLength(1);
  });

  it("a replay after a reconnect creates no second item and no second transition: the dedupe key is the event id", async () => {
    const f = await setup();
    const ts = nextTs();
    const first = mention(CHANNEL, ts, "EvSAME");
    await f.deliver(first);
    const item = (await itemOf(f, ts))!;
    const changes = (await f.store.listStateChanges(item.id)).length;
    f.client.disconnect();
    // Slack redelivers the same event in a new envelope on the next connection.
    const again = { ...mention(CHANNEL, ts, "EvSAME"), envelope_id: "env-replayed" };
    for (let i = 0; i < 20 && f.client.connects < 2; i++) {
      f.clock.advance(1_000);
      await flush();
    }
    await f.deliver(again);
    const rows = await f.store.listInboxAfter("slack_thread", 0, 10);
    expect(rows.map((r) => r.dedupe_key)).toEqual(["EvSAME"]);
    expect((await f.store.listStateChanges(item.id)).length).toBe(changes);
    expect((await f.store.listRuns(item.id)).filter((r) => r.kind === "triage")).toHaveLength(1);
  });
});

describe("slack thread: spec, buttons and commands", () => {
  it("posts the spec in the thread with buttons for exactly the button commands that apply now (the command table)", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    const spec = f.client.posts.find((p) => p.thread_ts === thread && p.marker.includes(":spec"))
      ?? f.client.posts.find((p) => p.thread_ts === thread && p.text.includes("Add a CI scope gate"))!;
    expect(spec).toBeTruthy();
    const expected = commandsFor(commandState(item)).map((c) => c.name).filter((n) => BUTTON_COMMANDS.includes(n));
    expect(buttonsOf(spec).map((b) => b.value)).toEqual(expected);
    expect(expected).toContain("approve");
    expect(buttonsOf(spec).map((b) => b.value)).not.toContain("reject");
  });

  it("an Approve press and a typed /approve move the item to the same state", async () => {
    const f = await setup();
    const a = await specPending(f);
    const b = await specPending(f);
    await f.deliver(press(a.thread, "factory:cmd:approve", "approve"));
    await f.deliver(reply(b.thread, "/approve"));
    const [x, y] = [(await itemOf(f, a.thread))!, (await itemOf(f, b.thread))!];
    expect(x.stage).not.toBe(a.item.stage);
    expect({ stage: x.stage, blocked_on: x.blocked_on, blocked_reason: x.blocked_reason }).toEqual({
      stage: y.stage, blocked_on: y.blocked_on, blocked_reason: y.blocked_reason,
    });
    expect((await f.store.listRuns(x.id)).some((r) => r.kind === "implement")).toBe(true);
    expect((await f.store.listRuns(y.id)).some((r) => r.kind === "implement")).toBe(true);
  });

  it("a press or typed command from a user the factory does not know is refused in the thread; the item does not change", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    const before = fields(await itemOf(f, thread));
    for (const env of [press(thread, "factory:cmd:approve", "approve", STRANGER), reply(thread, "/approve", STRANGER), press(thread, "factory:cmd:help", "help", STRANGER)]) {
      const posts = f.client.posts.length;
      await f.deliver(env);
      const replies = f.client.posts.slice(posts);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.thread_ts).toBe(thread);
      expect(replies[0]!.text).toMatch(/was not applied: your account is not linked/);
    }
    expect(fields(await f.store.getWorkItem(item.id))).toEqual(before);
  });

  it("every press and typed command calls AuthProvider.authorize first; a deny changes nothing", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    const before = fields(await itemOf(f, thread));
    const actions = [
      press(thread, "factory:cmd:approve", "approve", DENIED), reply(thread, "/approve", DENIED),
      press(thread, "factory:cmd:help", "help", DENIED), reply(thread, "/help", DENIED), reply(thread, "/retry", DENIED),
    ];
    for (const env of actions) {
      const calls = f.auth.authorized.length;
      await f.deliver(env);
      expect(f.auth.authorized.slice(calls).map((c) => c.user_id)).toEqual([`u:${DENIED}`]);
    }
    expect(fields(await f.store.getWorkItem(item.id))).toEqual(before);
  });

  it("a plain-language reply gets a suggestion with Confirm and Cancel; nothing runs before Confirm, Cancel changes nothing", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    const before = fields(await itemOf(f, thread));
    await f.deliver(reply(thread, "looks good, ship it"));
    const suggestion = f.client.posts.at(-1)!;
    expect(suggestion.text).toContain("Did you mean");
    const [confirm, cancel] = buttonsOf(suggestion);
    expect([confirm!.action_id, cancel!.action_id]).toEqual([CONFIRM_ACTION, CANCEL_ACTION]);
    expect(confirm!.value).toBe("/approve");
    expect(fields(await f.store.getWorkItem(item.id))).toEqual(before);

    const posts = f.client.posts.length;
    await f.deliver(press(thread, CANCEL_ACTION, cancel!.value));
    expect(fields(await f.store.getWorkItem(item.id))).toEqual(before);
    expect(f.client.posts.length).toBe(posts);

    await f.deliver(press(thread, CONFIRM_ACTION, confirm!.value));
    const after = (await f.store.getWorkItem(item.id))!;
    expect(after.version).toBeGreaterThan(before!.version);
    expect((await f.store.listRuns(item.id)).some((r) => r.kind === "implement")).toBe(true);
  });

  it("when a PR exists the thread gets its link; review then runs through the existing GitHub path", async () => {
    const f = await setup();
    const { thread, item } = await specPending(f);
    await f.deliver(press(thread, "factory:cmd:approve", "approve"));
    await finishAll(f, "implement", { pr_number: 42 });
    const link = f.client.posts.filter((p) => p.thread_ts === thread && p.marker === "<!-- factory:pr-link:42 -->");
    expect(link).toHaveLength(1);
    expect(link[0]!.text).toContain(`<https://${config.project.label}/pull/42|PR #42>`);
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("REVIEW");
    expect((await f.store.listRuns(item.id)).some((r) => r.kind === "review")).toBe(true);
    // PR status goes to GitHub, unchanged; GitHub items get no link comment.
    expect(f.gh.statusCalls.some((c) => c.pr_number === 42)).toBe(true);
    expect(f.gh.comments.some((c) => c.marker.includes("pr-link"))).toBe(false);
  });
});

describe("slack egress", () => {
  const leaky = () => new PatternEgressScanner(async () => [GH_TOKEN, APP_TOKEN, BOT_TOKEN]);
  const thread = "1700000000.000100";
  const ref = { type: "slack_thread" as const, id: sourceId(thread), link: "https://app.slack.com/x" };

  it("every post passes the EgressScanner first; a message with a planted secret is not posted", async () => {
    const client = new FakeSlackClient();
    const scanned: string[] = [];
    const scanner: EgressScanner = { scan: async (ch, c) => (scanned.push(c), leaky().scan(ch, c)) };
    const slack = new SlackSource({ client, channels: [CHANNEL], scanner, log: recordingLog() });
    await slack.postComment(ref, "all clear", "<!-- factory:a -->");
    expect(scanned.some((s) => s.includes("all clear"))).toBe(true);
    await slack.postComment(ref, `token ${BOT_TOKEN}`, "<!-- factory:b -->");
    expect(client.posts.map((p) => p.text)).toEqual(["all clear", WITHHELD_NOTICE]);
  });

  it("a blocked message is not retried: no reworded, split or re-encoded copy, only one withheld notice", async () => {
    const client = new FakeSlackClient();
    const log = recordingLog();
    const slack = new SlackSource({ client, channels: [CHANNEL], scanner: leaky(), log });
    const body = `Spec\n\n${"x".repeat(4000)}\n${GH_TOKEN}\n\nCommands you can reply with now:\n- \`/approve [notes]\`: ok.`;
    expect(await slack.postComment(ref, body, "<!-- factory:spec:1 -->")).toEqual({ url: null });
    // The same message again (a re-decide, a restart): the withheld notice holds its marker, so nothing is posted.
    for (let i = 0; i < 2; i++) await slack.postComment(ref, body, "<!-- factory:spec:1 -->");
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]!.text).toBe(WITHHELD_NOTICE);
    expect(buttonsOf(client.posts[0]!)).toEqual([]);
    const out = JSON.stringify([client.posts, log.lines]);
    const pieces = [GH_TOKEN, GH_TOKEN.slice(0, 18), GH_TOKEN.slice(18), Buffer.from(GH_TOKEN).toString("base64"), "x".repeat(100)];
    for (const p of pieces) expect(out).not.toContain(p);
  });

  it("GITHUB_TOKEN planted in the spec and in status text reaches no Slack event, post, log or inbox row", async () => {
    const f = await setup({ scanner: leaky() });
    const { thread, item } = await specPending(f, { ...triageSpec, in_short: `AS-IS: ${GH_TOKEN}\nTO-BE: none`, problem: `Use ${GH_TOKEN} to push` });
    await f.slack.postComment(item.source, `Status: implementing with ${GH_TOKEN}`, "<!-- factory:status:x -->");
    await f.deliver(reply(thread, "/help"));
    const out = JSON.stringify([f.client.posts, f.client.pending, f.log.lines, await f.store.listInboxAfter("slack_thread", 0, 100), item.source, item.title]);
    expect(out).not.toContain(GH_TOKEN);
    expect(f.client.posts.filter((p) => p.text === WITHHELD_NOTICE).length).toBeGreaterThanOrEqual(2);
  });
});

describe("slack boundaries", () => {
  it("no Slack SDK import anywhere in src outside src/impl/source/", () => {
    const root = join(import.meta.dirname, "..", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const offenders = files(root).filter((p) => !p.includes(join("src", "impl", "source")) && /from\s+["']@slack\//.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});

/** A SecretStore over fixed values that records every name read. */
class MapSecrets implements SecretStore {
  reads: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    this.reads.push(name);
    const v = this.values[name];
    return v === undefined ? null : { name, reveal: () => v, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

/** A fetch that answers every Slack method with `answer` and records the auth header and body. */
function fakeFetch(answer: Record<string, unknown> = { ok: true, team_id: TEAM, user_id: BOT, messages: [], ts: "1.2" }) {
  const calls: { url: string; auth: string; body: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).authorization), body: String(init.body) });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

