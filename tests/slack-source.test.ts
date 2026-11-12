// The `slack` stream source (issue #109), end to end on a fake Slack: Socket Mode envelopes through the real
// listener and inbox into the controller, and the thread replies back out. docs/plugins/source-adapter.md, `slack`.

import { afterEach, describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import type { Logger } from "../src/core/log.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { AuthAction, AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { Secret, SecretName } from "../src/interfaces/secret-store.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HttpSlackApi, SLACK_BOT_TOKEN, type FetchFn } from "../src/impl/source/slack-api.js";
import { ACTION_MAKE_TASK, cutNote, escapeSlack, proposalButtons, renderSpecMessage, toMrkdwn } from "../src/impl/source/slack-format.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { TOP_LEVEL_FACT } from "../src/core/interpret.js";
import { commentEvent } from "../src/core/comment-event.js";
import { chatForm, commandFooter, commandState, commandsFor, helpReply, refusalText, roleRefusal, specNotWaiting } from "../src/core/commands.js";
import { parseTriage } from "../src/core/outputs.js";
import { autoApprovedFooter, renderSpec, utcMinute } from "../src/core/spec-comment.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { plainRefusal } from "../web/src/api.js";
import { storedAnswers } from "../src/shared/command-notes.js";
import { parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { META_STATUS, SlackSource, parseSlackSourceId, slackLink, slackSourceId } from "../src/impl/source/slack-source.js";
import { NAMES_NO_ITEM } from "../src/impl/source/slack-notice-replies.js";
import { UNLINKED } from "../src/impl/source/slack-commands.js";
import { FakeForge, FakeSource, config, issueRef, recordingLog, silent, triageSpec, waitFor } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSlackApi, FakeSocket, OTHER_CHANNEL, TEAM, eventEnvelope, mention, message, modalPress, press, submission } from "./helpers/slack.js";
import { itemModal } from "../src/impl/source/slack-modals.js";
import { PROJECT_KEY, issue, newStore, system, w1 } from "./helpers/store.js";

/** Not shaped like any token the scanner's patterns know: it is caught only as a known secret value. */
const FAKE_GITHUB_TOKEN = "fake-github-token-for-the-leak-test-0001";

/**
 * The forge's auth plugin, for GitHub identities only: Slack accounts are judged by the local auth plugin over the
 * store's links and local users (setup links U0ALICE to github:1, the owner, and U0BOB to github:2, a requester).
 */
class SlackAuth implements AuthProvider {
  calls: { user_id: string; action: AuthAction }[] = [];
  denyAll = false;
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    const links: Record<string, string> = { U0ALICE: "github:1", U0BOB: "github:2" };
    const user = identity.provider === "slack" ? links[identity.subject] : `github:${identity.subject}`;
    return user ? { user_id: user as UserId, attributes: {} } : null;
  }
  async authorize(p: Principal, action: AuthAction): Promise<AuthDecision> {
    this.calls.push({ user_id: p.user_id, action });
    if (this.denyAll) return { allow: false, reason: "denied" };
    if (action === "submit_work" || p.user_id === "github:1") return { allow: true };
    return { allow: false, reason: "no_role" };
  }
}

/** Reads a top-level mention as a work request; proposes `/approve` on the first open item listed for any plain reply. */
class ApproveLLM implements LLMProvider {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const id = /"id":"([^"]+)"/.exec(req.messages[0]!.content)?.[1] ?? "";
    const parsed = req.messages[0]!.content.includes(TOP_LEVEL_FACT)
      ? { kind: "request", entries: [], text: "" }
      : { kind: "commands", entries: [{ item: id, command: "approve", args: "" }], text: "" };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

const running: { ac: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.ac.abort();
    await r.done;
  }
});

async function setup(opts: { store?: (s: FactoryStore) => FactoryStore; channels?: string[]; llm?: LLMProvider; dashboard_url?: string; notify_channel?: string } = {}) {
  const clock = new FakeClock();
  const { store: real } = await newStore(clock);
  const store = opts.store ? opts.store(real) : real;
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => [FAKE_GITHUB_TOKEN]);
  const repo = { owner: "o", name: "r" };
  // `settings list|history` from Slack: the CLI's own reads (slack.plugin.ts builds the same over the config file).
  const settings = async (args: readonly string[]) => {
    const a = parseSettingsArgs(args);
    if ("error" in a) return { ok: false, lines: [a.error] };
    return runSettings({ store: real, base: { file: {}, layers: config.settings }, repo, resolveProject: () => Promise.reject(new Error("no")), actor: "" }, a);
  };
  // slack.dashboard_url and slack.notify_channel as slack.plugin.ts passes them: absent unless the test sets them.
  const optional = { ...(opts.dashboard_url ? { dashboard_url: opts.dashboard_url } : {}), ...(opts.notify_channel ? { notify_channel: opts.notify_channel } : {}) };
  const slack = new SlackSource({ api, connect: socket.connect, channels: opts.channels ?? [CHANNEL], scanner, store, repo, log, settings, ...optional });
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const auth = new SlackAuth();
  // Slack users: U0ALICE is linked to github:1 (the local owner: may approve), U0BOB to github:2 (no role: never
  // allowed to approve), anyone else is not linked.
  for (const [user, account] of [["github:1", "U0ALICE"], ["github:2", "U0BOB"]] as const) {
    await real.createLinkCode(user as UserId, `code-${account}`);
    await real.redeemLinkCode(`code-${account}`, { provider: "slack", subject: account });
  }
  await real.claimLocalOwner("github:1" as UserId);
  const controller = new ControllerRole({
    store: real, sources: [gh, slack], forge, auth, local_auth: new LocalAuthProvider(real), clock, config, log, scanner, llm: opts.llm ?? new ApproveLLM(),
  });
  const ac = new AbortController();
  const listener = new Listener({ store, source: slack, clock, config, log: silentLike(log), owner: "replica-a" });
  const done = listener.run(ac.signal);
  running.push({ ac, done });
  return { clock, store: real, api, socket, log, slack, gh, forge, auth, controller, scanner };
}

/** The listener's own lines go to the same recorder, so the "nothing names a person" checks see them too. */
function silentLike(log: Logger): Logger {
  return log;
}

type F = Awaited<ReturnType<typeof setup>>;

/** Pushes envelopes, waits until each is acked (stored or dropped), then lets the controller read the inbox. */
async function deliver(f: F, ...envelopes: Record<string, unknown>[]): Promise<void> {
  for (const e of envelopes) f.socket.push(e);
  const ids = envelopes.map((e) => String(e.envelope_id));
  await waitFor(() => ids.every((id) => f.socket.acks.includes(id)), "acks");
  await f.controller.tickIntake();
}

/** Waits for `cond`, moving the fake clock a second at a time so the listener's reconnect backoff can pass. */
async function untilAdvancing(f: F, cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    f.clock.advance(1_000);
    for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sourceId = (ts: string) => slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: ts });
const itemOf = (f: F, ts: string) => f.store.getWorkItemBySource("slack_thread", sourceId(ts));

/** Finishes every queued run of `kind` with `data`, then lets the controller apply them. */
async function finishAll(f: F, kind: "triage" | "implement" | "review", data: Record<string, unknown>): Promise<void> {
  for (;;) {
    const run = await f.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
    if (!run) break;
    await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data });
  }
  await f.controller.tickRuns();
}

/**
 * A top-level mention made an item: the mention gets its reply, then `user` presses its Make this a task button
 * (design 04-gate-commands, "a mention creates an item only on a press").
 */
async function requested(f: F, ts: string, text: string, over: Record<string, unknown> = {}): Promise<void> {
  await deliver(f, eventEnvelope(mention(ts, text, over)));
  await deliver(f, press(ts, ACTION_MAKE_TASK, text, typeof over.user === "string" ? over.user : "U0ALICE"));
}

/** The factory's messages in a thread after the item exists: the mention's reply and the "Task created" line left out. */
const itemThread = (f: F, ts: string) => f.api.thread(ts).slice(2);

/** A mention that became an item, triaged: its spec is waiting in the thread. */
async function specPending(f: F, ts = "1800000001.000100", spec: Record<string, unknown> = triageSpec): Promise<WorkItem> {
  await requested(f, ts, "please add a scope gate");
  await finishAll(f, "triage", { spec });
  const item = (await itemOf(f, ts))!;
  expect(item.blocked_reason).toBe("spec_pending");
  return item;
}

const fields = (it: WorkItem | null) => it && { stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason };

describe("slack source: intake", () => {
  it("a mention of the bot in a listed channel and a press of its button create exactly one work item, keyed slack:<team>:<channel>:<thread ts>", async () => {
    const f = await setup();
    await requested(f, "1800000001.000100", "please add a scope gate");
    const items = await f.store.listWorkItems(10);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toEqual({
      type: "slack_thread", id: `slack:${TEAM}:${CHANNEL}:1800000001.000100`, link: `https://slack.com/archives/${CHANNEL}/p1800000001000100`,
    });
    expect(items[0]!.title).toBe("please add a scope gate");
    expect(items[0]!.requester_id).toBe("github:1");
    expect(parseSlackSourceId(items[0]!.source.id)).toEqual({ team: TEAM, channel: CHANNEL, thread_ts: "1800000001.000100" });
    // The mention's reply, the press's one line, then the status message.
    expect(f.api.thread("1800000001.000100").map((m) => m.text?.split("\n")[0])).toEqual([
      "I couldn't read that. Make it a task?", "Task created: please add a scope gate", "Status: *triaging*",
    ]);
  });

  it("a top-level mention is marked classify, never offered; only a Make this a task press is marked offered", async () => {
    const f = await setup();
    const me = { team_id: TEAM, user_id: BOT };
    const ts = "1800000001.000300";
    const said = await f.slack.toEvent(eventEnvelope(mention(ts, "please add a scope gate")), me);
    expect(said?.event).toMatchObject({ kind: "item_requested", classify: true });
    expect(said?.event).not.toHaveProperty("offered");
    const pressed = await f.slack.toEvent(press(ts, ACTION_MAKE_TASK, "please add a scope gate", "U0BOB"), me);
    expect(pressed?.event).toEqual({
      kind: "item_requested", source: { type: "slack_thread", id: sourceId(ts), link: slackLink(CHANNEL, ts) }, requester: { provider: "slack", subject: "U0BOB" },
      title: "please add a scope gate", body: "please add a scope gate", offered: true,
    });
  });

  it("a mention inside a thread starts the item from the thread root", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000002.000200", "can the factory take this?", { thread_ts: "1800000002.000100" })));
    expect((await itemOf(f, "1800000002.000100"))?.source.id).toBe(sourceId("1800000002.000100"));
  });

  it("the message + app_mention pair Slack sends for one mention gets one reply (owner's live test)", async () => {
    const f = await setup();
    const ts = "1794038471.990329";
    await deliver(
      f,
      eventEnvelope(message(ts, `<@${BOT}> small request`), "Ev0CFTHQ6TA5"),
      eventEnvelope(mention(ts, "small request"), "Ev0CFTHQ8WBB"),
    );
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(f.api.thread(ts)).toHaveLength(1);
    expect((await f.store.listInboxAfter("slack_thread", 0, 10)).map((r) => r.dedupe_key)).toEqual(["event:Ev0CFTHQ8WBB"]);
  });

  it("a message in a channel not on the list starts nothing, mention or not", async () => {
    const f = await setup();
    await deliver(
      f,
      eventEnvelope(mention("1800000003.000100", "do it", { channel: OTHER_CHANNEL })),
      eventEnvelope(message("1800000003.000200", "hello", { channel: OTHER_CHANNEL })),
    );
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);
    expect(f.api.calls).toEqual([]);
  });

  it("ignores top-level messages without a mention, the bot's own messages, other bots and subtype events", async () => {
    const f = await setup();
    await deliver(
      f,
      eventEnvelope(message("1800000004.000100", "just chatting")),
      eventEnvelope(message("1800000004.000200", `<@${BOT}> loop?`, { user: BOT })),
      eventEnvelope(mention("1800000004.000300", "from a bot", { bot_id: "B0OTHER" })),
      eventEnvelope(mention("1800000004.000400", "edited", { subtype: "message_changed" })),
      eventEnvelope(message("1800000004.000500", "joined", { subtype: "channel_join", thread_ts: "1800000004.000100" })),
      { type: "slash_commands", envelope_id: "env-slash", payload: {} },
    );
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);
  });

  it("does not store replies in threads that are not work items", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(message("1800000004.000700", "unrelated reply", { thread_ts: "1800000004.000600" })));
    expect(await f.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);
  });

  it("stores IDs only: no Slack display or real names in the inbox, the store, the logs or the posts", async () => {
    const f = await setup();
    const ts = "1800000005.000100";
    const profile = { user_profile: { real_name: "Alice Example-Realname", display_name: "alice-display", name: "alice-handle" } };
    await requested(f, ts, "add a gate", profile);
    await finishAll(f, "triage", { spec: triageSpec });
    await deliver(f, press(ts, "sf_cmd:approve", "/approve"));
    const item = (await itemOf(f, ts))!;
    const everything = JSON.stringify([
      await f.store.listInboxAfter("slack_thread", 0, 50),
      item,
      await f.store.listStateChanges(item.id),
      await f.store.listRuns(item.id),
      f.log.lines,
      f.api.messages,
    ]);
    for (const name of ["Alice Example-Realname", "alice-display", "alice-handle", "display-name-never-read", "channel-name-never-read"]) {
      expect(everything).not.toContain(name);
    }
    expect(everything).toContain("U0ALICE");
  });
});

describe("slack source: ack after store, replay", () => {
  it("acks an envelope only after its inbox write commits; a failed write leaves it unacked", async () => {
    let fail = true;
    let f: F | null = null;
    const storedAtAck: boolean[] = [];
    f = await setup({
      store: (s) =>
        new Proxy(s, {
          get(target, prop, receiver) {
            if (prop === "appendInbox") {
              return async (...args: Parameters<FactoryStore["appendInbox"]>) => {
                if (fail) throw new Error("store down");
                return target.appendInbox(...args);
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
    });
    const env = eventEnvelope(mention("1800000006.000100", "do it"));
    const g = f;
    g.socket.push(env);
    await waitFor(() => g.log.lines.some((l) => l.msg.startsWith("stream disconnected")), "failed write");
    expect(g.socket.acks).toEqual([]);
    expect(await g.store.listInboxAfter("slack_thread", 0, 10)).toEqual([]);

    // The listener reconnects after its backoff; Slack sends the envelope again, it is stored, and only then acked.
    fail = false;
    await untilAdvancing(g, () => g.socket.acks.includes(String(env.envelope_id)), "ack after the retry");
    storedAtAck.push((await g.store.listInboxAfter("slack_thread", 0, 10)).length === 1);
    expect(storedAtAck).toEqual([true]);
    expect(g.socket.connections).toBeGreaterThanOrEqual(2);
  });

  it("events replayed after a reconnect create no second item and no second transition (dedupe on the event id)", async () => {
    const f = await setup();
    const ts = "1800000007.000100";
    const item = await specPending(f, ts);
    const changes = (await f.store.listStateChanges(item.id)).length;

    // The approve press is stored as a command row, but its ack is lost with the connection: Slack sends it again.
    const approve = press(ts, "sf_cmd:approve", "/approve");
    f.socket.loseAcks = true;
    f.socket.push(approve);
    await waitFor(async () => (await f.store.listCliCommandsAfter(0, 50)).length === 1, "stored");
    f.socket.loseAcks = false;
    f.socket.drop();
    await untilAdvancing(f, () => f.socket.acks.includes(String(approve.envelope_id)), "redelivered and acked");
    // Slack retries the original mention too, with the same event id.
    const again = eventEnvelope(mention(ts, "please add a scope gate"), String((await f.store.listInboxAfter("slack_thread", 0, 1))[0]!.dedupe_key.slice("event:".length)));
    await deliver(f, again);
    await f.controller.tickIntake();

    expect(await f.store.listWorkItems(10)).toHaveLength(1);
    expect((await f.store.listInboxAfter("slack_thread", 0, 50)).map((r) => r.dedupe_key.split(":")[0])).toEqual(["event", "action"]);
    expect((await f.store.listCliCommandsAfter(0, 50)).map((c) => [c.command, c.actor])).toEqual([["approve", "github:1"]]);
    const after = await f.store.listStateChanges(item.id);
    expect(after.length).toBe(changes + 1);
    expect(after.at(-1)!.reason).not.toBe("intake");
    expect(f.socket.connections).toBeGreaterThanOrEqual(2);
  });
});

/** The item's thread entries that came from Slack people: marker, actor, body. */
const slackEntries = async (f: F, item: WorkItem) =>
  (await f.store.listItemMessages(item.id)).filter((m) => m.marker.startsWith("slack:")).map((m) => [m.marker, m.actor, m.body]);

describe("slack source: people's replies in the item thread (issue #480)", () => {
  it("stores a reply in an item's thread once, keyed by its ts, with the Slack user ID as actor and no outbox row", async () => {
    const f = await setup();
    const ts = "1800000040.000100";
    const item = await specPending(f, ts);
    await deliver(f, eventEnvelope(message("1800000040.000200", "looks good to me", { thread_ts: ts })));
    expect(await slackEntries(f, item)).toEqual([["slack:1800000040.000200", "slack:U0ALICE", "looks good to me"]]);
    expect((await f.store.listDeliveries(item.id)).map((d) => d.marker).filter((m) => m.startsWith("slack:"))).toEqual([]);
    // The request text of the mention that created the item is not an entry.
    expect((await f.store.listItemMessages(item.id)).map((m) => m.body)).not.toContain("please add a scope gate");
  });

  it("the reply sits between the factory messages it followed, in the order Slack sent them", async () => {
    const f = await setup();
    const ts = "1800000041.000100";
    const item = await specPending(f, ts);
    await deliver(f, eventEnvelope(message("1800000041.000200", "one question first", { thread_ts: ts })));
    await f.store.recordItemMessage({ work_item_id: item.id, marker: "<!-- factory:later -->", body: "a later factory message" });
    const markers = (await f.store.listItemMessages(item.id)).map((m) => m.marker);
    const spec = markers.findIndex((m) => m.startsWith("<!-- factory:spec"));
    const reply = markers.indexOf("slack:1800000041.000200");
    const later = markers.indexOf("<!-- factory:later -->");
    expect(spec).toBeGreaterThanOrEqual(0);
    expect(spec < reply && reply < later).toBe(true);
  });

  it("a redelivered envelope or a restarted listener stores no second entry", async () => {
    const f = await setup();
    const ts = "1800000042.000100";
    const item = await specPending(f, ts);
    const reply = eventEnvelope(message("1800000042.000200", "one more thing", { thread_ts: ts }));
    await deliver(f, reply);
    // Slack sends the same event again in a new envelope, before and after the listener restarts.
    await deliver(f, { ...reply, envelope_id: "env-480-again" });
    f.socket.drop();
    await untilAdvancing(f, () => f.socket.connections >= 2, "reconnected");
    await deliver(f, { ...reply, envelope_id: "env-480-restart" });
    expect(await slackEntries(f, item)).toEqual([["slack:1800000042.000200", "slack:U0ALICE", "one more thing"]]);
  });

  it("a command typed in the thread, plain or after a mention, is stored the same way and runs once", async () => {
    const f = await setup();
    const ts = "1800000043.000100";
    const item = await specPending(f, ts);
    const typed = eventEnvelope(mention("1800000043.000200", "/approve", { thread_ts: ts }));
    await deliver(f, typed);
    await deliver(f, { ...typed, envelope_id: "env-480-typed-again" });
    await deliver(f, eventEnvelope(message("1800000043.000300", " /retry", { thread_ts: ts })));
    expect(await slackEntries(f, item)).toEqual([
      ["slack:1800000043.000200", "slack:U0ALICE", "/approve"],
      ["slack:1800000043.000300", "slack:U0ALICE", "/retry"],
    ]);
    expect((await f.store.listCliCommandsAfter(0, 50)).filter((c) => c.command === "approve")).toHaveLength(1);
    expect((await f.store.listStateChanges(item.id)).filter((c) => c.reason === "spec_approved")).toHaveLength(1);
  });

  it("a mention in an item's thread that is a plain request is stored too", async () => {
    const f = await setup();
    const ts = "1800000044.000100";
    const item = await specPending(f, ts);
    await deliver(f, eventEnvelope(mention("1800000044.000200", "can you also cover tags?", { thread_ts: ts })));
    expect(await slackEntries(f, item)).toEqual([["slack:1800000044.000200", "slack:U0ALICE", "can you also cover tags?"]]);
  });

  it("a reply or a mention in a thread that is not a work item stores no entry anywhere", async () => {
    const f = await setup();
    const other = await specPending(f, "1800000045.000100");
    await deliver(f, eventEnvelope(message("1800000045.000300", "unrelated", { thread_ts: "1800000045.000200" })));
    await deliver(f, eventEnvelope(mention("1800000045.000400", "/approve", { thread_ts: "1800000045.000200" })));
    expect(await slackEntries(f, other)).toEqual([]);
    for (const it of await f.store.listWorkItems(10)) expect(await slackEntries(f, it)).toEqual([]);
  });

  it("stored entries carry no Slack display or real name", async () => {
    const f = await setup();
    const ts = "1800000046.000100";
    const item = await specPending(f, ts);
    const profile = { user_profile: { real_name: "Alice Example-Realname", display_name: "alice-display", name: "alice-handle" } };
    await deliver(f, eventEnvelope(message("1800000046.000200", "fine by me", { thread_ts: ts, ...profile })));
    await deliver(f, eventEnvelope(mention("1800000046.000300", "/approve", { thread_ts: ts, ...profile })));
    const entries = await f.store.listItemMessages(item.id);
    expect(entries.filter((m) => m.marker.startsWith("slack:"))).toHaveLength(2);
    const stored = JSON.stringify(entries);
    for (const name of ["Alice Example-Realname", "alice-display", "alice-handle"]) expect(stored).not.toContain(name);
    expect(stored).toContain("slack:U0ALICE");
  });

  it("a failed thread write leaves the envelope unacked and yields no event; Slack's resend stores it once", async () => {
    let fail = false;
    const f = await setup({
      store: (s) =>
        new Proxy(s, {
          get(target, prop, receiver) {
            if (prop === "recordItemMessage") {
              return async (...args: Parameters<FactoryStore["recordItemMessage"]>) => {
                if (fail && args[0].marker.startsWith("slack:")) throw new Error("store down");
                return target.recordItemMessage(...args);
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
    });
    const ts = "1800000047.000100";
    const item = await specPending(f, ts);
    const inbox = (await f.store.listInboxAfter("slack_thread", 0, 100)).length;
    fail = true;
    const reply = eventEnvelope(message("1800000047.000200", "hold on", { thread_ts: ts }));
    f.socket.push(reply);
    await waitFor(() => f.log.lines.some((l) => l.msg.startsWith("stream disconnected")), "failed write");
    expect(f.socket.acks).not.toContain(String(reply.envelope_id));
    expect(await f.store.listInboxAfter("slack_thread", 0, 100)).toHaveLength(inbox);
    expect(await slackEntries(f, item)).toEqual([]);

    // The listener reconnects after its backoff and Slack sends the envelope again.
    fail = false;
    await untilAdvancing(f, () => f.socket.acks.includes(String(reply.envelope_id)), "ack after the retry");
    expect(await slackEntries(f, item)).toEqual([["slack:1800000047.000200", "slack:U0ALICE", "hold on"]]);
  });
});

describe("slack source: replies, buttons and commands", () => {
  it("posts a spec waiting for approval as the short spec message, with no separate needs-approval status message", async () => {
    const f = await setup();
    const ts = "1800000008.000100";
    const item = await specPending(f, ts);
    const spec = itemThread(f, ts).find((m) => FakeSlackApi.buttons(m).length > 0)!;
    expect(spec.text).toBe("Needs your approval: please add a scope gate");
    expect(FakeSlackApi.buttons(spec)).toEqual(["sf_spec_approve", "sf_spec_reject"]);
    expect(JSON.stringify(spec.blocks)).not.toContain("<!--");
    expect(JSON.stringify(spec.blocks)).not.toContain("Full spec");
    expect((spec.blocks![0] as { accessory: unknown }).accessory).toEqual({ type: "button", text: { type: "plain_text", text: "View" }, action_id: "sf_view", value: item.id });
    // The thread's status message, if any, was posted before (triaging) and edited in place: no second one.
    expect(f.api.thread(ts).filter((m) => m.text?.startsWith("Status:")).length).toBeLessThanOrEqual(1);
    expect(f.api.calls.filter((c) => c.method === "postMessage" && c.text === "Status: *needs approval*")).toEqual([]);
  });

  it("an Approve press moves the item to the same state as a typed /approve", async () => {
    const f = await setup();
    const pressed = await specPending(f, "1800000009.000100");
    const typed = await specPending(f, "1800000009.000200");
    await deliver(f, press("1800000009.000100", "sf_cmd:approve", "/approve"));
    await deliver(f, eventEnvelope(mention("1800000009.000300", "/approve", { thread_ts: "1800000009.000200" })));
    const a = await f.store.getWorkItem(pressed.id);
    const b = await f.store.getWorkItem(typed.id);
    expect(fields(a)).toEqual(fields(b));
    expect(a!.stage).toBe("RUNNING");
    expect((await f.store.listStateChanges(a!.id)).at(-1)!.reason).toBe((await f.store.listStateChanges(b!.id)).at(-1)!.reason);
    expect((await f.store.listRuns(a!.id)).map((r) => r.kind)).toContain("implement");
  });

  it("a typed command in a thread reply works without a mention too", async () => {
    const f = await setup();
    const item = await specPending(f, "1800000010.000100");
    await deliver(f, eventEnvelope(message("1800000010.000200", " /approve ship it", { thread_ts: "1800000010.000100" })));
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
  });

  it("a press or typed command from a user the factory does not know is refused in the thread, and nothing changes", async () => {
    const f = await setup();
    const ts = "1800000011.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    await deliver(f, press(ts, "sf_cmd:approve", "/approve", "U0STRANGER"));
    await deliver(f, eventEnvelope(mention("1800000011.000200", "/approve", { thread_ts: ts, user: "U0STRANGER" })));
    expect(await f.store.getWorkItem(item.id)).toEqual(before);
    const refusals = f.api.thread(ts).filter((m) => m.text?.includes("not linked to a factory user"));
    expect(refusals).toHaveLength(2);
    expect(await f.store.listCliCommandsAfter(0, 50)).toEqual([]);
  });

  it("an unlinked person's mention gets one reply and no item", async () => {
    const f = await setup();
    const ts = "1800000012.000100";
    await deliver(f, eventEnvelope(mention(ts, "do it", { user: "U0STRANGER" })));
    await deliver(f, eventEnvelope(mention(ts, "do it", { user: "U0STRANGER" })));
    expect(await f.store.listWorkItems(10)).toEqual([]);
    const replies = f.api.thread(ts);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("not taken in as a work item");
  });

  it("a linked user whose stored role does not allow it gets the CLI's refusal once per command; nothing changes", async () => {
    const f = await setup();
    const ts = "1800000013.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    await deliver(f, press(ts, "sf_cmd:approve", "/approve", "U0BOB"));
    await deliver(f, eventEnvelope(mention("1800000013.000200", "/approve", { thread_ts: ts, user: "U0BOB" })));
    expect(await f.store.getWorkItem(item.id)).toEqual(before);
    // The same command row the CLI stores, with the linked factory user as actor.
    expect((await f.store.listCliCommandsAfter(0, 50)).map((c) => [c.command, c.actor, c.args])).toEqual([
      ["approve", "github:2", { item: item.id }],
      ["approve", "github:2", { item: item.id }],
    ]);
    const refusal = "github:2 has no role that allows it (`no_role`); the local owner can grant one with `factory users add github:2 --role approver`";
    const replies = f.api.thread(ts).filter((m) => m.text?.includes("was not applied"));
    expect(replies).toHaveLength(2);
    for (const r of replies) expect(r.text).toContain(refusal);
  });

  it("a plain reply gets a proposal with its buttons; nothing changes until a press or the typed command", async () => {
    const f = await setup();
    const ts = "1800000014.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    await deliver(f, eventEnvelope(message("1800000014.000200", "looks good to me", { thread_ts: ts })));
    const proposal = f.api.thread(ts).find((m) => m.text?.startsWith("The factory read one command"))!;
    expect(JSON.stringify(proposal.blocks)).toContain("/approve");
    expect(FakeSlackApi.buttons(proposal)).toEqual(["sf_proposal:0", "sf_proposal_all", "sf_proposal_cancel"]);
    expect(await f.store.getWorkItem(item.id)).toEqual(before);

    await deliver(f, eventEnvelope(mention("1800000014.000300", "/approve", { thread_ts: ts })));
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
  });

  it("no mention needed in a thread the factory owns: a plain reply gets one proposal and changes no state; elsewhere a reply is not stored and gets no reply", async () => {
    let calls = 0;
    const llm = new ApproveLLM();
    const counting: LLMProvider = { complete: (req) => (calls++, llm.complete(req)) };
    const f = await setup({ llm: counting });
    const ts = "1800000015.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    const startCalls = calls;
    await deliver(f, eventEnvelope(message("1800000015.000200", "fine by me, go ahead", { thread_ts: ts })));
    expect(calls).toBe(startCalls + 1);
    expect(f.api.thread(ts).filter((m) => m.text?.startsWith("The factory read one command"))).toHaveLength(1);
    expect(await f.store.getWorkItem(item.id)).toEqual(before);

    // A thread with no work item: no inbox row, no thread entry, no model call, no post.
    const other = "1800000015.000300";
    const inbox = await f.store.listInboxAfter("slack_thread", 0, 100);
    const posted = f.api.calls.length;
    await deliver(f, eventEnvelope(message("1800000015.000400", "fine by me, go ahead", { thread_ts: other })));
    expect(await f.store.listInboxAfter("slack_thread", 0, 100)).toEqual(inbox);
    for (const it of await f.store.listWorkItems(10)) expect((await f.store.listItemMessages(it.id)).map((m) => m.marker)).not.toContain("slack:1800000015.000400");
    expect(calls).toBe(startCalls + 1);
    expect(f.api.calls.length).toBe(posted);
    expect(f.api.thread(other)).toEqual([]);
  });

  it("the thread gets a link to the PR once there is one; PR status goes to the forge", async () => {
    const f = await setup();
    const ts = "1800000015.000100";
    const item = await specPending(f, ts);
    await deliver(f, press(ts, "sf_cmd:approve", "/approve"));
    await finishAll(f, "implement", { pr_number: 42 });
    expect((await f.store.getWorkItem(item.id))!.change_ref).toBe("42");
    const status = f.api.thread(ts).filter((m) => m.text?.startsWith("Status:"));
    expect(status).toHaveLength(1);
    expect(status[0]!.text).toBe("Status: *in review* · <https://github.com/o/r/pull/42|PR #42>");
    expect(f.forge.statusCalls.filter((c) => c.source.id === item.source.id)).toEqual([{ source: item.source, status: "in_review", pr_number: 42 }]);
    expect(f.gh.statusCalls.filter((c) => c.source.id === item.source.id)).toEqual([]);
  });

  it("the PR link is built from the item's change_ref: text PR #<n>, the same URL as before", async () => {
    const f = await setup();
    const ts = "1800000015.000300";
    const item = await specPending(f, ts);
    // An item whose change_ref names PR 57: the link can only come from change_ref.
    const read = f.store.getWorkItemBySource.bind(f.store);
    f.store.getWorkItemBySource = async (type, id) => {
      const it = await read(type, id);
      return it && { ...it, change_ref: "57" };
    };
    await f.slack.setStatus(item.source, "in_review", null);
    const status = f.api.thread(ts).filter((m) => m.text?.startsWith("Status:"));
    expect(status).toHaveLength(1);
    expect(status[0]!.text).toBe("Status: *in review* · <https://github.com/o/r/pull/57|PR #57>");
    // A PR's own status (a non-null change_ref) is the forge's: nothing changes in the thread.
    await f.slack.setStatus(item.source, "done", "57");
    expect(f.api.thread(ts).filter((m) => m.text?.startsWith("Status:")).map((m) => m.text)).toEqual([status[0]!.text]);
  });

  it("posts a marker at most once", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000016.000100"), link: "" };
    const a = await f.slack.postComment(source, "hello", "<!-- m1 -->");
    const b = await f.slack.postComment(source, "hello again", "<!-- m1 -->");
    expect(a).toEqual(b);
    expect(f.api.calls).toHaveLength(1);
    expect(JSON.stringify(f.api.messages)).not.toContain("m1");
  });
});

describe("slack source: buttons after a state change (issue #586)", () => {
  /** Every chat.update with its blocks (the fake keeps only the text). */
  function updates(f: F): { ts: string; text: string; blocks: readonly unknown[] }[] {
    const out: { ts: string; text: string; blocks: readonly unknown[] }[] = [];
    const update = f.api.updateMessage.bind(f.api);
    f.api.updateMessage = async (m) => {
      out.push({ ts: m.ts, text: m.text, blocks: m.blocks ?? [] });
      return update(m);
    };
    return out;
  }
  const buttonsOf = (blocks: readonly unknown[]) => FakeSlackApi.buttons({ blocks } as never);
  const specMessage = (f: F, ts: string) => f.api.thread(ts).find((m) => FakeSlackApi.buttons(m).includes("sf_cmd:approve"))!;

  it("posting an auto-approved spec renders no Approve button, only the buttons of the state after it", async () => {
    const f = await setup();
    const parsed = parseTriage({ ...triageSpec, decisions: ["Fail the job, or only warn?"] });
    if (!parsed.ok) throw new Error(parsed.error);
    const footer = autoApprovedFooter(commandState({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, change_ref: null }), 2, "2026-11-11T10:00:00.000Z");
    const source = { type: "slack_thread" as const, id: sourceId("1800000018.000100"), link: "" };
    await f.slack.postComment(source, renderSpec(parsed.value, 2, {}, footer, { approved: true }), "<!-- factory:spec:r1 -->");
    const [posted] = f.api.thread("1800000018.000100");
    expect(FakeSlackApi.buttons(posted!)).toEqual(["sf_cmd:help"]);
    const text = JSON.stringify(posted!.blocks);
    expect(text).toContain("Approved automatically (auto mode, tier 2) at 2026-11-11 10:00 UTC.");
    expect(text).not.toContain("To answer, reply");
  });

  it("a state change edits each earlier message with buttons once: stale buttons dropped, a Done line added; again, no call", async () => {
    const f = await setup();
    const ts = "1800000019.000100";
    const item = await specPending(f, ts);
    // A factory message with the spec gate's command buttons (its footer), kept on the item's thread and posted.
    const body = `Waiting for the spec.\n\n${commandFooter(commandState(item))}`;
    await f.store.recordItemMessage({ work_item_id: item.id, marker: "<!-- factory:note -->", body });
    await f.slack.postComment(item.source, body, "<!-- factory:note -->");
    const note = specMessage(f, ts);
    const spec = f.api.thread(ts).find((m) => FakeSlackApi.buttons(m).includes("sf_spec_approve"))!;
    const seen = updates(f);
    await deliver(f, eventEnvelope(mention("1800000019.000200", "/approve", { thread_ts: ts })));
    await f.controller.tickCommands();
    await f.controller.tickOutbox();
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
    const edits = seen.filter((u) => u.ts === note.ts);
    expect(edits).toHaveLength(1);
    expect(buttonsOf(edits[0]!.blocks)).toEqual(["sf_cmd:help"]);
    const text = JSON.stringify(edits[0]!.blocks);
    const approved = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(text).toContain(`Done: spec approved by ${approved.actor.id} at ${utcMinute(approved.at)}. The item is now implementing.`);
    expect(text).not.toContain("Commands you can reply with now");
    expect(text).toContain("Waiting for the spec.");
    // The spec message keeps its buttons (a press gets the stale reply): never edited.
    expect(seen.filter((u) => u.ts === spec.ts)).toEqual([]);

    // The same update again (a redelivered status, the next state change with the same buttons left): no call.
    await f.slack.setStatus(item.source, "implementing", null);
    await f.slack.setStatus(item.source, "implementing", null);
    expect(seen.filter((u) => u.ts === note.ts)).toHaveLength(1);
  });

  it("a press of a stale Approve says what already happened and when, with the current buttons, and no error wording", async () => {
    const f = await setup();
    const ts = "1800000020.000100";
    const item = await specPending(f, ts);
    await deliver(f, eventEnvelope(mention("1800000020.000200", "/approve", { thread_ts: ts })));
    await f.controller.tickCommands();
    const before = await f.store.getWorkItem(item.id);
    const changes = (await f.store.listStateChanges(item.id)).length;
    const inbox = (await f.store.listInboxAfter("slack_thread", 0, 100)).length;
    const posts = f.api.calls.filter((c) => c.method === "postMessage").length;
    await deliver(f, press(ts, "sf_cmd:approve", "/approve", "U0ALICE", "1800000120.000001"));
    await f.controller.tickCommands();

    const replies = f.api.calls.filter((c) => c.method === "postMessage").slice(posts);
    expect(replies).toHaveLength(1);
    const reply = JSON.stringify(replies[0]!.blocks);
    const approved = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(reply).toContain(`Done: spec approved by ${approved.actor.id} at ${utcMinute(approved.at)}. The item is now implementing.`);
    expect(reply).not.toMatch(/not applied|refused|error|failed/i);
    // The current buttons: implementing has Help only.
    expect(buttonsOf(replies[0]!.blocks!)).toEqual(["sf_cmd:help"]);
    // Nothing else happened: no state change, no inbox row, no CLI command.
    expect(fields(await f.store.getWorkItem(item.id))).toEqual(fields(before));
    expect(await f.store.listStateChanges(item.id)).toHaveLength(changes);
    expect(await f.store.listInboxAfter("slack_thread", 0, 100)).toHaveLength(inbox);
    // The same press sent again (a new envelope, the same action): no second reply.
    await deliver(f, press(ts, "sf_cmd:approve", "/approve", "U0ALICE", "1800000120.000001"));
    expect(f.api.calls.filter((c) => JSON.stringify(c.blocks ?? []).includes("from an earlier step"))).toHaveLength(1);
  });

  it("a typed /approve on an item that left the spec gate still gets the shared refusal", async () => {
    const f = await setup();
    const ts = "1800000021.000100";
    await specPending(f, ts);
    await deliver(f, eventEnvelope(mention("1800000021.000200", "/approve", { thread_ts: ts })));
    await f.controller.tickCommands();
    await deliver(f, eventEnvelope(mention("1800000021.000300", "/approve", { thread_ts: ts })));
    await f.controller.tickCommands();
    expect(JSON.stringify(f.api.thread(ts).map((m) => m.blocks))).toContain("was not applied");
  });
});

describe("slack source: answers and structured revise (issue #527)", () => {
  const DECISIONS = [
    { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: false },
    { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: false },
  ];
  const ANSWERS = [
    { question: "Fail the job, or only warn?", answer: "Only warn", accepted_default: false },
    { question: "Name the step?", answer: "scope", accepted_default: true },
  ];
  const approval = async (f: F, it: WorkItem) => (await f.store.listStateChanges(it.id)).find((c) => c.reason === "spec_approved");

  it("a thread /approve with N: lines stores the same answers as the dashboard approve, as the linked user's ID", async () => {
    const f = await setup();
    const thread = await specPending(f, "1800000050.000100", { ...triageSpec, decisions: DECISIONS });
    const app = await specPending(f, "1800000050.000200", { ...triageSpec, decisions: DECISIONS });
    await deliver(f, eventEnvelope(mention("1800000050.000300", "/approve\n1: Only warn\nkeep it small", { thread_ts: "1800000050.000100" })));
    await f.store.recordAppCommandRequest({ key: "app-1", actor: "github:1" as UserId, command: "approve", args: { work_item_id: app.id, note: "1: Only warn\nkeep it small" } });
    await f.controller.tickCommands();

    const byThread = (await approval(f, thread))!;
    const byApp = (await approval(f, app))!;
    expect(storedAnswers(byThread.detail)).toEqual(ANSWERS);
    expect(storedAnswers(byApp.detail)).toEqual(storedAnswers(byThread.detail));
    expect(byThread.detail?.note).toBe("keep it small");
    expect(byThread.actor).toEqual({ kind: "user", id: "github:1" });
  });

  it("a thread /revise with ### <Section> lines is stored with its text unchanged; one with no heading too", async () => {
    const f = await setup();
    const structured = "### Problem\nSay why the gate is slow.\n\n### Done when\nAdd a timing test.";
    for (const [n, text] of [[1, structured], [2, "keep the existing CLI flag"]] as const) {
      const ts = `180000005${n}.000100`;
      const item = await specPending(f, ts);
      await deliver(f, eventEnvelope(mention(`180000005${n}.000200`, `/revise ${text}`, { thread_ts: ts })));
      expect(await f.store.getWorkItem(item.id), `revise ${n}`).toMatchObject({ stage: "NEW", spec_feedback: text });
      const change = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_revision_requested");
      expect(change?.actor).toEqual({ kind: "user", id: "github:1" });
    }
  });

  it("a requester's thread /approve or /revise is still refused by the role check, and nothing changes", async () => {
    const f = await setup();
    const ts = "1800000053.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: DECISIONS });
    const before = await f.store.getWorkItem(item.id);
    await deliver(f, eventEnvelope(mention("1800000053.000200", "/approve\n1: Only warn", { thread_ts: ts, user: "U0BOB" })));
    await deliver(f, eventEnvelope(mention("1800000053.000300", "/revise ### Problem\nnarrower", { thread_ts: ts, user: "U0BOB" })));
    expect(await f.store.getWorkItem(item.id)).toEqual(before);
    const replies = f.api.thread(ts).filter((m) => m.text?.includes("was not applied"));
    expect(replies).toHaveLength(2);
    for (const r of replies) expect(r.text).toContain("github:2 has no role that allows it (`no_role`)");
  });
});

describe("slack source: egress", () => {
  it("scans every message before it is posted; a planted secret is not posted, only a withheld notice, never retried", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000017.000100"), link: "" };
    const body = `Here it is: ${FAKE_GITHUB_TOKEN}\n\nCommands you can reply with now:\n- \`/approve [notes]\`: Approve.`;
    await f.slack.postComment(source, body, "<!-- leak -->");
    await f.slack.postComment(source, body, "<!-- leak -->");
    await f.slack.postComment(source, body.split(":").join(" :"), "<!-- leak -->");
    expect(f.api.calls).toHaveLength(1);
    expect(f.api.calls[0]!.text).toBe("A factory message for this thread was withheld by the leak scanner (known_secret). It is not posted in any form.");
    expect(f.api.messages[0]!.blocks).toHaveLength(1);
    expect(f.log.lines.find((l) => l.msg.includes("withheld"))?.fields).toMatchObject({ rules: "known_secret" });
  });

  it("the GitHub token planted in spec text never reaches Slack posts, events, logs or the store", async () => {
    const f = await setup();
    const ts = "1800000018.000100";
    await requested(f, ts, "add a gate");
    await finishAll(f, "triage", { spec: { ...triageSpec, problem: `Use ${FAKE_GITHUB_TOKEN} to push`, scope: `token ${FAKE_GITHUB_TOKEN}` } });
    const item = (await itemOf(f, ts))!;
    const slackOut = JSON.stringify([f.api.messages, f.api.calls]);
    expect(slackOut).not.toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(await f.store.listInboxAfter("slack_thread", 0, 50))).not.toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(f.log.lines)).not.toContain(FAKE_GITHUB_TOKEN);
    // The spec itself is in the store here only because the test skips the worker, whose G5 scan of the run
    // outcome would have stopped it; the Slack source adds nothing: no inbox row, no log line carries it.
    void item;
    expect(f.api.thread(ts).some((m) => m.text?.includes("withheld by the leak scanner"))).toBe(true);
  });
});

describe("slack source: store records before thread reads (issue #484)", () => {
  const statusOf = (f: F, ts: string) => f.api.thread(ts).filter((m) => m.text?.startsWith("Status:"));
  const STATUS_MARKER = "slack:status";

  it("a second status edits the first in place with no thread read; only the first status reads the thread", async () => {
    const f = await setup();
    const ts = "1800000040.000100";
    const source = { type: "slack_thread" as const, id: sourceId(ts), link: "" };
    await f.slack.setStatus(source, "triaging", null);
    const reads = f.api.threadReplyCalls;
    await f.slack.setStatus(source, "implementing", null);
    expect(f.api.threadReplyCalls).toBe(reads);
    expect(reads).toBe(1);
    expect(f.api.calls.map((c) => c.method)).toEqual(["postMessage", "updateMessage"]);
    const status = statusOf(f, ts);
    expect(status.map((m) => m.text)).toEqual(["Status: *implementing*"]);
    expect(await f.store.getPostedComment(source.id, STATUS_MARKER, "")).toMatchObject({
      comment_id: status[0]!.ts, url: slackLink(CHANNEL, status[0]!.ts, ts),
    });
  });

  it("a deleted status message (message_not_found) is replaced by a new one, recorded, and later edits go to it", async () => {
    const f = await setup();
    const ts = "1800000041.000100";
    const source = { type: "slack_thread" as const, id: sourceId(ts), link: "" };
    await f.slack.setStatus(source, "triaging", null);
    const first = statusOf(f, ts)[0]!.ts;
    f.api.messages = f.api.messages.filter((m) => m.ts !== first);
    await f.slack.setStatus(source, "implementing", null);
    const after = statusOf(f, ts);
    expect(after.map((m) => m.text)).toEqual(["Status: *implementing*"]);
    expect(after[0]!.ts).not.toBe(first);
    expect(await f.store.getPostedComment(source.id, `slack:status:after:${first}`, "")).toMatchObject({ comment_id: after[0]!.ts });
    const calls = f.api.calls.length;
    await f.slack.setStatus(source, "in_review", null);
    expect(f.api.calls.slice(calls).map((c) => c.method)).toEqual(["updateMessage"]);
    expect(statusOf(f, ts).map((m) => [m.ts, m.text])).toEqual([[after[0]!.ts, "Status: *in review*"]]);
    expect(f.api.threadReplyCalls).toBe(1);
  });

  it("a status posted before the records is found by one thread read, recorded, and later updates read nothing", async () => {
    const f = await setup();
    const ts = "1800000042.000100";
    const source = { type: "slack_thread" as const, id: sourceId(ts), link: "" };
    const { ts: old } = await f.api.postMessage({
      channel: CHANNEL, thread_ts: ts, text: "Status: *triaging*", metadata: { event_type: META_STATUS, event_payload: { status: "triaging" } },
    });
    await f.slack.setStatus(source, "implementing", null);
    await f.slack.setStatus(source, "in_review", null);
    expect(f.api.threadReplyCalls).toBe(1);
    expect(statusOf(f, ts).map((m) => [m.ts, m.text])).toEqual([[old, "Status: *in review*"]]);
    expect((await f.store.getPostedComment(source.id, STATUS_MARKER, ""))?.comment_id).toBe(old);
  });

  it("a recorded comment marker returns its stored link with no thread read and no post", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000043.000100"), link: "" };
    await f.store.recordPostedComment({ source_id: source.id, marker: "<!-- m2 -->", comment_id: "1800000043.000200", url: "https://slack.com/archives/x", body: "hi" });
    expect(await f.slack.postComment(source, "hi", "<!-- m2 -->")).toEqual({ url: "https://slack.com/archives/x" });
    expect(f.api.threadReplyCalls).toBe(0);
    expect(f.api.calls).toEqual([]);
  });

  it("a posted comment is recorded with its ts and link; a second post of the marker makes no call", async () => {
    const f = await setup();
    const thread = "1800000044.000100";
    const source = { type: "slack_thread" as const, id: sourceId(thread), link: "" };
    const a = await f.slack.postComment(source, "hello", "<!-- m3 -->");
    const posted = f.api.thread(thread)[0]!;
    expect(a.url).toBe(slackLink(CHANNEL, posted.ts, thread));
    expect(await f.store.getPostedComment(source.id, "<!-- m3 -->", "hello")).toMatchObject({ comment_id: posted.ts, url: a.url, same_body: true });
    const reads = f.api.threadReplyCalls;
    expect(await f.slack.postComment(source, "hello", "<!-- m3 -->")).toEqual(a);
    expect(f.api.threadReplyCalls).toBe(reads);
    expect(f.api.calls).toHaveLength(1);
  });

  it("a blocked comment or status is not posted or edited and leaves no record", async () => {
    const f = await setup();
    const ts = "1800000045.000100";
    const source = { type: "slack_thread" as const, id: sourceId(ts), link: "" };
    await f.slack.postComment(source, `leak ${FAKE_GITHUB_TOKEN}`, "<!-- leak2 -->");
    expect(f.api.calls.map((c) => c.text)).not.toContain(expect.stringContaining(FAKE_GITHUB_TOKEN));
    expect(await f.store.getPostedComment(source.id, "<!-- leak2 -->", "")).toBeNull();
    await f.slack.postComment(source, `leak ${FAKE_GITHUB_TOKEN}`, "<!-- leak2 -->");
    expect(f.api.calls).toHaveLength(1);
    expect(await f.store.getPostedComment(source.id, "<!-- leak2 -->", "")).toBeNull();

    f.scanner.scan = async () => ({ clean: false, findings: [{ rule: "known_secret", channel: "comment" }] });
    const calls = f.api.calls.length;
    await f.slack.setStatus(source, "triaging", null);
    expect(f.api.calls.length).toBe(calls);
    expect(await f.store.getPostedComment(source.id, STATUS_MARKER, "")).toBeNull();
  });
});

describe("slack source: 👀 on a command", () => {
  /** An item in review with PR 42, from a thread at `ts`. */
  async function inReview(f: F, ts: string): Promise<WorkItem> {
    const item = await specPending(f, ts);
    await deliver(f, press(ts, "sf_cmd:approve", "/approve"));
    await finishAll(f, "implement", { pr_number: 42 });
    return (await f.store.getWorkItem(item.id))!;
  }

  it("/verdict accept in a thread gets exactly one eyes reaction on its message; a redelivered markSeen adds none", async () => {
    const f = await setup();
    const ts = "1800000020.000100";
    const item = await inReview(f, ts);
    const before = f.api.reactions.length;
    await deliver(f, eventEnvelope(mention("1800000020.000200", "/verdict accept none looks right", { thread_ts: ts })));
    expect((await f.store.listVerdicts(item.id)).map((v) => v.comment_id)).toContain("1800000020.000200");
    const mine = () => f.api.reactions.filter((r) => r.ts === "1800000020.000200");
    expect(mine()).toEqual([{ channel: CHANNEL, ts: "1800000020.000200", name: "eyes" }]);

    await f.slack.markSeen(item.source, "1800000020.000200");
    expect(mine()).toHaveLength(1);
    // No other message got one from the verdict.
    expect(f.api.reactions.length - before).toBe(1);
  });

  it("does nothing for no comment id or a button press's action key", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000021.000100"), link: "" };
    await f.slack.markSeen(source, null);
    await f.slack.markSeen(source, "action:1800000121.000001");
    expect(f.api.reactCalls).toBe(0);
  });

  it("a failed reaction (missing_scope) is a warning and the command still runs", async () => {
    const f = await setup();
    const ts = "1800000022.000100";
    const item = await inReview(f, ts);
    f.api.failReact = "missing_scope";
    await deliver(f, eventEnvelope(mention("1800000022.000200", "/verdict accept none fine", { thread_ts: ts })));
    expect((await f.store.listVerdicts(item.id)).map((v) => v.comment_id)).toContain("1800000022.000200");
    expect(f.api.reactCalls).toBeGreaterThan(0);
    expect(f.log.lines.some((l) => l.level === "warn" && l.msg === "mark seen failed" && String(l.fields?.error).includes("missing_scope"))).toBe(true);
  });

  it("HttpSlackApi.react calls reactions.add with the bot token and takes already_reacted as success", async () => {
    const requests: { url: string; auth: string; body: string }[] = [];
    let error: string | null = "already_reacted";
    const fn: FetchFn = async (url, init) => {
      requests.push({ url, auth: init.headers.authorization ?? "", body: init.body });
      return { status: 200, json: async () => (error === null ? { ok: true } : { ok: false, error }) };
    };
    const api = new HttpSlackApi({ get: async (name) => (name === SLACK_BOT_TOKEN ? fakeSecret(name, "test-bot-value") : null) }, fn);
    await api.react(CHANNEL, "1800000023.000200", "eyes");
    expect(requests).toEqual([{ url: "https://slack.com/api/reactions.add", auth: "Bearer test-bot-value", body: JSON.stringify({ channel: CHANNEL, timestamp: "1800000023.000200", name: "eyes" }) }]);
    error = "missing_scope";
    await expect(api.react(CHANNEL, "1800000023.000200", "eyes")).rejects.toThrow("slack reactions.add failed: missing_scope");
    error = null;
    await api.react(CHANNEL, "1800000023.000200", "eyes");
  });
});

function fakeSecret(name: SecretName, v: string): Secret {
  return { name, reveal: () => v, toString: () => "[secret]", toJSON: () => "[secret]" };
}

describe("slack source: factory commands (issue #498)", () => {
  /** The code block a reply of printed lines starts with. */
  const block = (lines: readonly string[]) => `\`\`\`\n${escapeSlack(lines.join("\n"))}\n\`\`\``;
  /** What the CLI prints for `a` on the same store, as `who`. */
  const cli = (f: F, a: Parameters<typeof runLocalCli>[1], who = "github:1") =>
    runLocalCli({ store: f.store, identity: { user: who as UserId, from: "cli_user" }, project: async () => null, read: async () => "", newId: () => "x" }, a);

  it("`list` in a channel and `show <id>` in a thread reply with the text `task list` and `task show` print", async () => {
    const f = await setup();
    const item = await specPending(f, "1800000030.000100");
    const sid = "local-chat-test";
    await f.store.createWorkItem(
      { source: { type: "local", id: sid, link: `local:${sid}` }, title: "a local task", requester_id: "github:1" as UserId, project: item.project, problem: "p", resources: [] },
      { kind: "user", id: "github:1" as UserId },
    );
    await deliver(f, eventEnvelope(mention("1800000030.000200", "list")));
    await deliver(f, eventEnvelope(mention("1800000030.000300", `show ${item.id}`, { thread_ts: "1800000030.000100" })));
    const list = (await cli(f, { action: "list" })).lines;
    expect(list.join("\n")).toContain("a local task");
    expect(f.api.thread("1800000030.000200").map((m) => m.text)).toEqual([block(list)]);
    const show = (await cli(f, { action: "show", id: item.id })).lines;
    expect(f.api.thread("1800000030.000100").find((m) => m.text?.startsWith("```"))?.text).toBe(block(show));
    // A read stores nothing, and a redelivery posts nothing more.
    expect(await f.store.listCliCommandsAfter(0, 10)).toEqual([]);
  });

  it("an unlinked account gets one reply saying so; only `/link` and `help` are answered for it", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000031.000100", "list", { user: "U0STRANGER" })));
    await deliver(f, eventEnvelope(mention("1800000031.000200", "help", { user: "U0STRANGER" })));
    const [refusal] = f.api.thread("1800000031.000100");
    expect(f.api.thread("1800000031.000100")).toHaveLength(1);
    expect(refusal!.text).toContain("This Slack account is not linked to a factory user, so the command was not run");
    const help = f.api.thread("1800000031.000200")[0]!.text!;
    expect(help).toContain("/link &lt;code&gt;");
    expect(help).not.toContain("`list`");
  });

  it("`users`, `mode` and `settings` writes get one refusal until #479 and write nothing; reads work", async () => {
    const f = await setup();
    const users = await f.store.listLocalUsers();
    for (const [ts, text] of [["1800000032.000100", "users add local:dev@example.com --role approver"], ["1800000032.000200", "mode auto"], ["1800000032.000300", "settings set max_loops 9"]]) {
      await deliver(f, eventEnvelope(mention(ts!, text!)));
      const replies = f.api.thread(ts!);
      expect(replies, text).toHaveLength(1);
      expect(replies[0]!.text).toContain("signed command passports (issue #479)");
    }
    expect(await f.store.listLocalUsers()).toEqual(users);
    expect(await f.store.listSettingChanges(10)).toEqual([]);
    await deliver(f, eventEnvelope(mention("1800000032.000400", "users list")));
    expect(f.api.thread("1800000032.000400")[0]!.text).toContain("you are github:1 (from linked chat account)");
    await deliver(f, eventEnvelope(mention("1800000032.000500", "settings history")));
    expect(f.api.thread("1800000032.000500")[0]!.text).toContain("no settings changes yet");
  });

  it("`merge` and item commands outside an item's thread get one reply naming where they work", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000033.000100", "merge")));
    expect(f.api.thread("1800000033.000100").map((m) => m.text)).toEqual(["`merge` works only in a work item's thread: post it there, after a mention of the bot."]);
  });

  it("`merge` in the thread of an item with no local branch gets the CLI's refusal", async () => {
    const f = await setup();
    const item = await specPending(f, "1800000034.000100");
    await deliver(f, eventEnvelope(mention("1800000034.000200", "merge", { thread_ts: "1800000034.000100" })));
    const reply = f.api.thread("1800000034.000100").find((m) => m.text?.startsWith("```"))!;
    expect(reply.text).toContain(`${item.id} is not a local work item: merge its change on the forge instead`);
    expect(await f.store.listCliCommandsAfter(0, 10)).toEqual([]);
  });

  it("`help` lists only what the sender may run there: no item command in a channel, and none for a user without the role", async () => {
    const f = await setup();
    await specPending(f, "1800000035.000100");
    await deliver(f, eventEnvelope(mention("1800000035.000200", "help")));
    await deliver(f, eventEnvelope(mention("1800000035.000300", "help", { thread_ts: "1800000035.000100" })));
    await deliver(f, eventEnvelope(mention("1800000035.000400", "help", { thread_ts: "1800000035.000100", user: "U0BOB" })));
    const channel = f.api.thread("1800000035.000200")[0]!.text!;
    expect(channel).toContain("`list`");
    expect(channel).not.toContain("approve");
    const replies = f.api.thread("1800000035.000100").filter((m) => m.text?.startsWith("Commands you can run in this item"));
    expect(replies).toHaveLength(2);
    expect(replies[0]!.text).toContain("`approve [notes]`");
    expect(replies[1]!.text).not.toContain("approve");
    expect(replies[1]!.text).toContain("`list`");
  });

  it("a reply longer than Slack's limits is cut to them, with a note naming the CLI command and linking the item", async () => {
    const f = await setup();
    const item = await specPending(f, "1800000036.000100");
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n");
    await f.store.recordItemMessage({ work_item_id: item.id, marker: "<!-- long -->", body: long, actor: "github:1" });
    await deliver(f, eventEnvelope(mention("1800000036.000200", `show ${item.id}`)));
    const [reply] = f.api.thread("1800000036.000200");
    const blocks = reply!.blocks as { text: { text: string } }[];
    expect(blocks).toHaveLength(45);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(item.source.link).toMatch(/^https:\/\//);
    expect(blocks.at(-1)!.text.text).toBe(cutNote(`factory task show ${item.id}`, item.source.link));
    expect(blocks.at(-1)!.text.text).toContain(`<${item.source.link}|`);
  });

  it("makes no Slack call before the command is stored, and a failing Slack API does not stop it being applied", async () => {
    const f = await setup();
    const ts = "1800000037.000100";
    const item = await specPending(f, ts);
    const down = async () => {
      throw new Error("slack is down");
    };
    f.api.postMessage = down;
    f.api.updateMessage = down;
    f.api.threadReplies = down;
    const calls = f.api.calls.length;
    await deliver(f, eventEnvelope(mention("1800000037.000200", "/approve ship it", { thread_ts: ts })));
    expect(f.api.calls.length).toBe(calls);
    expect((await f.store.listCliCommandsAfter(0, 10)).map((c) => [c.key.startsWith("cli:slack-"), c.actor, c.command, c.args])).toEqual([
      [true, "github:1", "approve", { item: item.id, text: "ship it" }],
    ]);
    await f.controller.tickIntake();
    const after = (await f.store.getWorkItem(item.id))!;
    expect(after.stage).toBe("RUNNING");
    expect((await f.store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "spec_approved", actor: { kind: "user", id: "github:1" } });
  });

  it("a mention in plain words outside an item's thread is a request: a press of its button starts a work item, as `task create` does", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000038.000100", "list the open bugs in the parser")));
    expect(await itemOf(f, "1800000038.000100")).toBeNull();
    await deliver(f, press("1800000038.000100", ACTION_MAKE_TASK, "list the open bugs in the parser"));
    expect((await itemOf(f, "1800000038.000100"))?.title).toBe("list the open bugs in the parser");
  });
});

describe("slack source: one help and refusal text (issue #528)", () => {
  const repo = { owner: "o", name: "r" };
  /** The thread's replies that start with `prefix`. */
  const replies = (f: F, ts: string, prefix: string) => f.api.thread(ts).filter((m) => m.text?.startsWith(prefix)).map((m) => m.text!);

  /** The item API as the page of `actor` reads it, its approve_spec checked by the local auth plugin on the project, as compose.ts wires it. */
  async function dashboard(f: F, actor: string, id: string) {
    const auth = new LocalAuthProvider(f.store);
    const d: ApiDeps = {
      store: f.store, scanner: f.scanner, clock: f.clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], f.clock),
      commands: {
        actor: actor as UserId, source: "config", token: "t",
        allowed: (action) => auth.authorize({ user_id: actor as UserId, attributes: {} }, action, { kind: "project", id: PROJECT_KEY }),
      },
    };
    const r = await respond(d, { method: "GET", url: `/api/v1/items/${encodeURIComponent(id)}`, host: "127.0.0.1:4310" });
    return JSON.parse(r.body) as { commands: { name: string; allowed: boolean; reason: string | null }[]; replies: { refusal: string | null }[] };
  }

  it("/help outside an item's thread answers in the mention's thread: how to start work and how to link an account", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000060.000100", "/help")));
    await deliver(f, eventEnvelope(mention("1800000060.000300", "help", { thread_ts: "1800000060.000200" })));
    for (const ts of ["1800000060.000100", "1800000060.000200"]) {
      const [help, ...more] = f.api.thread(ts);
      expect(more, ts).toEqual([]);
      expect(help!.text).toMatch(/^Commands you can run here/);
      expect(help!.text).toContain("`&lt;request in plain words&gt;`");
      expect(help!.text).toContain("`/link &lt;code&gt;`");
      expect(help!.text).not.toContain("/approve");
    }
    expect(await f.store.listWorkItems(10)).toEqual([]);
  });

  it("/help in an item's thread lists the commands that apply now in the same text as the issue /help reply for that state", async () => {
    const f = await setup();
    const ts = "1800000061.000100";
    const item = await specPending(f, ts);
    await deliver(f, eventEnvelope(mention("1800000061.000200", "/help", { thread_ts: ts })));
    const [help] = replies(f, ts, "Commands you can run in this item");
    const state = commandState(item);
    const now = commandsFor(state).filter((c) => c.name !== "help");
    expect(now.map((c) => c.name)).toEqual(["approve", "reject", "revise"]);
    for (const c of now) {
      expect(helpReply(state)).toContain(`- \`${c.usage}\` **(now)**: ${c.description}.`);
      // The same words, each command shown without its slash, as typed after the mention.
      expect(help).toContain(toMrkdwn(chatForm(`- \`${c.usage}\`: ${c.description}.`), repo));
    }
    expect(help).toContain("`@software-factory help`");
    expect(help).not.toMatch(/(^|[\s`(])\/[a-z]/);
  });

  it("in an item's thread, `@bot /approve` and `@bot approve` both approve; outside one, a bare `approve` is a request", async () => {
    const f = await setup();
    const slashed = await specPending(f, "1800000062.000100");
    const bare = await specPending(f, "1800000062.000200");
    await deliver(f, eventEnvelope(mention("1800000062.000300", "/approve ship it", { thread_ts: "1800000062.000100" })));
    await deliver(f, eventEnvelope(mention("1800000062.000400", "approve ship it", { thread_ts: "1800000062.000200" })));
    await f.controller.tickIntake();
    const a = (await f.store.getWorkItem(slashed.id))!;
    const b = (await f.store.getWorkItem(bare.id))!;
    expect(fields(b)).toEqual(fields(a));
    expect(b.stage).toBe("RUNNING");
    expect((await f.store.listCliCommandsAfter(0, 10)).map((c) => [c.command, c.args])).toEqual([
      ["approve", { item: slashed.id, text: "ship it" }],
      ["approve", { item: bare.id, text: "ship it" }],
    ]);
    await requested(f, "1800000062.000500", "approve");
    expect((await itemOf(f, "1800000062.000500"))?.title).toBe("approve");
  });
  it("the same command refused for the same reason reads the same on GitHub, the CLI, Slack and the dashboard", async () => {
    const f = await setup();
    const want = refusalText("/approve", specNotWaiting("triaging"));
    // One triaging item per surface: an issue for GitHub, the CLI and the dashboard; a thread for Slack.
    const gh = (await f.store.createWorkItem(issue(71), system)).item;
    const cli = (await f.store.createWorkItem(issue(72), system)).item;
    const app = (await f.store.createWorkItem(issue(73), system)).item;
    await requested(f, "1800000063.000100", "please add a scope gate");
    f.gh.queue.push(commentEvent(issueRef(71), "101", { provider: "github", subject: "1" }, "/approve")!);
    await f.store.recordAppCommandRequest({ key: "app-528", actor: "github:1" as UserId, command: "approve", args: { work_item_id: app.id } });
    await deliver(f, eventEnvelope(mention("1800000063.000200", "/approve", { thread_ts: "1800000063.000100" })));
    await f.controller.tickIntake();
    await f.controller.tickCommands();
    const typed = await runLocalCli({ store: f.store, identity: { user: "github:1" as UserId, from: "cli_user" }, project: async () => null, read: async () => "", newId: () => "x" }, {
      action: "command", command: "approve", id: cli.id, text: "",
    });
    const stored = (await dashboard(f, "github:1", app.id)).replies[0]!.refusal!;
    const table: [string, string][] = [
      ["github", f.gh.comments.find((c) => c.source.id === gh.source.id && c.marker.startsWith("<!-- factory:refused:"))!.body],
      ["cli", typed.lines.join("\n")],
      ["slack", f.api.thread("1800000063.000100").find((m) => m.text?.startsWith("```"))!.text!],
      ["dashboard (stored)", stored],
    ];
    for (const [surface, text] of table) expect({ surface, text }).toEqual({ surface, text: expect.stringContaining(want) });
    expect(stored).toBe(want);
    // The dashboard shows it as plain text; the stored row keeps the backticks.
    expect(plainRefusal(stored)).toBe("/approve was not applied: the spec is not waiting for approval (the item is triaging).");
    // The CLI and Slack refused before any write: no `cli:` row (Slack's go through the CLI's), only the others' rows.
    expect((await f.store.listCliCommandsAfter(0, 10)).filter((c) => c.key.startsWith("cli:"))).toEqual([]);
  });

  it("team: a linked requester sees approve disallowed on the dashboard, and Slack refuses the approve with that same text", async () => {
    const f = await setup();
    const ts = "1800000064.000100";
    const item = await specPending(f, ts);
    const page = await dashboard(f, "github:2", item.id);
    expect(page.commands.map((c) => [c.name, c.allowed, c.reason])).toEqual(
      ["approve", "reject", "revise"].map((n) => [n, false, roleRefusal("github:2", "no_role")]),
    );
    expect((await dashboard(f, "github:1", item.id)).commands.map((c) => c.name)).toEqual(["approve", "reject", "revise"]);
    await deliver(f, eventEnvelope(mention("1800000064.000200", "approve", { thread_ts: ts, user: "U0BOB" })));
    const [refused] = f.api.thread(ts).filter((m) => m.text?.includes("was not applied"));
    expect(refused!.text).toContain(refusalText("/approve", page.commands[0]!.reason!));
  });
});

describe("slack source: commands with no slash after a mention (issue #541)", () => {
  /** The stored CLI rows, as command and arguments. */
  const rows = async (f: F) => (await f.store.listCliCommandsAfter(0, 50)).map((c) => [c.command, c.args]);
  /** The inbox events of the Slack source from `after`, without their comment IDs. */
  const events = async (f: F, after: number) =>
    (await f.store.listInboxAfter("slack_thread", after, 50)).map((r) => {
      const { comment_id: _id, ...e } = r.event as unknown as Record<string, unknown>;
      return e;
    });
  const lastSeq = async (f: F) => (await f.store.listInboxAfter("slack_thread", 0, 500)).at(-1)?.seq ?? 0;

  it("in an item's thread, `@bot revise <feedback>` stores and applies the same command as `@bot /revise <feedback>`", async () => {
    const f = await setup();
    const slashed = await specPending(f, "1800000070.000100");
    const bare = await specPending(f, "1800000070.000200");
    await deliver(f, eventEnvelope(mention("1800000070.000300", "/revise narrower scope\nkeep the flag", { thread_ts: "1800000070.000100" })));
    await deliver(f, eventEnvelope(mention("1800000070.000400", "revise narrower scope\nkeep the flag", { thread_ts: "1800000070.000200" })));
    await f.controller.tickIntake();
    expect(await rows(f)).toEqual([
      ["revise", { item: slashed.id, text: "narrower scope\nkeep the flag" }],
      ["revise", { item: bare.id, text: "narrower scope\nkeep the flag" }],
    ]);
    const a = (await f.store.getWorkItem(slashed.id))!;
    const b = (await f.store.getWorkItem(bare.id))!;
    expect(fields(b)).toEqual(fields(a));
    expect(b).toMatchObject({ stage: "NEW", spec_feedback: "narrower scope\nkeep the flag" });
  });

  it("every table command (approve, retry, reject, resolve, merge) stores the same row bare as with its slash", async () => {
    for (const [i, text] of ["approve, but fix the tests", "retry once more", "reject duplicate emails", "resolve keep ours", "merge"].entries()) {
      const f = await setup();
      const slashed = await specPending(f, `18000000${71 + i}.000100`);
      const bare = await specPending(f, `18000000${71 + i}.000200`);
      await deliver(f, eventEnvelope(mention(`18000000${71 + i}.000300`, `/${text}`, { thread_ts: slashed.source.id.split(":")[3] })));
      await deliver(f, eventEnvelope(mention(`18000000${71 + i}.000400`, text, { thread_ts: bare.source.id.split(":")[3] })));
      await f.controller.tickIntake();
      await f.controller.tickCommands();
      const [r1, r2] = await rows(f);
      if (text === "merge") {
        // Not a local item: the CLI refuses both the same way, before any row.
        expect([r1, r2], text).toEqual([undefined, undefined]);
        const refusals = (ts: string) => f.api.thread(ts).filter((m) => m.text?.includes("is not a local work item")).length;
        expect([refusals(`18000000${71 + i}.000100`), refusals(`18000000${71 + i}.000200`)]).toEqual([1, 1]);
      } else {
        expect(r1, text).toEqual([r1![0], { ...(r1![1] as object), item: slashed.id }]);
        expect(r2, text).toEqual([r1![0], { ...(r1![1] as object), item: bare.id }]);
      }
      expect(fields(await f.store.getWorkItem(bare.id)), text).toEqual(fields(await f.store.getWorkItem(slashed.id)));
    }
  });

  it("budget, verdict, standing and link bare after a mention in an item's thread are the same events as with the slash", async () => {
    const f = await setup();
    const item = await specPending(f, "1800000080.000100");
    const thread_ts = "1800000080.000100";
    for (const [n, text] of ["budget 50000", "verdict accept none fine", "standing accept spec-t1"].entries()) {
      const from = await lastSeq(f);
      await deliver(f, eventEnvelope(mention(`18000000${81 + n}.000100`, `/${text}`, { thread_ts })));
      await deliver(f, eventEnvelope(mention(`18000000${81 + n}.000200`, text, { thread_ts })));
      const [slashed, bare, ...more] = await events(f, from);
      expect(more, text).toEqual([]);
      expect(bare, text).toEqual(slashed);
      expect(slashed!.kind, text).not.toBe("plain_comment");
    }
    // `link <code>`: an unlinked account links itself in the thread with the bare word as with `/link`.
    for (const [who, user, typed] of [["U0CAROL", "github:3", "link code-carol"], ["U0DAVE", "github:4", "/link code-dave"]] as const) {
      await f.store.createLinkCode(user as UserId, `code-${who === "U0CAROL" ? "carol" : "dave"}`);
      await deliver(f, eventEnvelope(mention(`1800000085.00010${who === "U0CAROL" ? 1 : 2}`, typed, { thread_ts, user: who })));
      expect(await f.store.resolveLink("slack", who), typed).toBe(user);
    }
    expect((await f.store.getWorkItem(item.id))?.blocked_reason).toBe("spec_pending");
  });

  it("outside an item's thread, a bare command word is a request (a press starts its item); the slash form gets the refusal naming the bare form", async () => {
    const f = await setup();
    await requested(f, "1800000090.000100", "reject duplicate emails");
    await requested(f, "1800000090.000200", "budget the parser work");
    expect((await itemOf(f, "1800000090.000100"))?.title).toBe("reject duplicate emails");
    expect((await itemOf(f, "1800000090.000200"))?.title).toBe("budget the parser work");
    await deliver(f, eventEnvelope(mention("1800000090.000300", "/reject duplicate emails")));
    expect(f.api.thread("1800000090.000300").map((m) => m.text)).toEqual([
      "`reject &lt;reason&gt;` works only in a work item's thread: post it there, after a mention of the bot.",
    ]);
    expect(await itemOf(f, "1800000090.000300")).toBeNull();
    expect(await rows(f)).toEqual([]);
  });

  it("a reply in an item's thread with no mention still needs the slash: a bare word is a plain comment", async () => {
    const f = await setup();
    const ts = "1800000091.000100";
    const item = await specPending(f, ts);
    const from = await lastSeq(f);
    await deliver(f, eventEnvelope(message("1800000091.000200", "revise narrower scope", { thread_ts: ts })));
    expect((await events(f, from)).map((e) => [e.kind, e.body])).toEqual([["plain_comment", "revise narrower scope"]]);
    expect(await rows(f)).toEqual([]);
    expect((await f.store.getWorkItem(item.id))?.blocked_reason).toBe("spec_pending");
    await deliver(f, eventEnvelope(message("1800000091.000300", "/revise narrower scope", { thread_ts: ts })));
    expect(await rows(f)).toEqual([["revise", { item: item.id, text: "narrower scope" }]]);
  });
});

/** Answers every plain reply with `entries` (item IDs from the test), as the interpreter's model would. */
class ScriptedLLM implements LLMProvider {
  entries: { item: string; command: string; args: string }[] = [];
  async complete(): Promise<LLMResponse> {
    const parsed = { kind: "commands", entries: this.entries };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

describe("slack source: proposal buttons (issue #584)", () => {
  type Btn = { action_id: string; value: string };
  const buttonsOf = (m: { blocks?: readonly unknown[] | undefined }): Btn[] =>
    ((m.blocks ?? []).find((b) => (b as { type: string }).type === "actions") as { elements: Btn[] } | undefined)?.elements ?? [];
  const PROPOSAL_TEXT = /^The factory read (one command|\d+ commands)/;

  /** A plain reply in thread `ts` answered with `entries`; the posted proposal message and its proposal ID. */
  async function propose(f: F, llm: ScriptedLLM, ts: string, reply_ts: string, entries: ScriptedLLM["entries"]) {
    llm.entries = entries;
    await deliver(f, eventEnvelope(message(reply_ts, "please do what we said", { thread_ts: ts })));
    const msg = f.api.thread(ts).find((m) => PROPOSAL_TEXT.test(m.text ?? ""))!;
    const id = buttonsOf(msg).find((b) => b.action_id === "sf_proposal_all")!.value;
    return { msg, id };
  }

  /** A press, then the controller's command step. */
  async function pressed(f: F, ts: string, action_id: string, value: string, user = "U0ALICE") {
    await deliver(f, press(ts, action_id, value, user));
    await f.controller.tickCommands();
  }

  const replies = (f: F, ts: string, re: RegExp) => f.api.thread(ts).filter((m) => re.test(m.text ?? ""));
  const statuses = async (f: F, id: string) => (await f.store.listCommandProposals(id)).map((r) => [r.idx, r.status, r.answered_by, r.refusal]);

  it("stores one pending row per proposed command, once, and posts one button each plus Confirm all and Cancel, built by the button builder", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000090.000100";
    const a = await specPending(f, ts);
    const b = await specPending(f, "1800000090.000200");
    const { msg, id } = await propose(f, llm, ts, "1800000090.000300", [
      { item: a.id, command: "approve", args: "ship it" },
      { item: b.id, command: "reject", args: "not needed any more" },
    ]);
    expect(buttonsOf(msg)).toEqual(proposalButtons(id, ["approve", "reject"]));
    expect(buttonsOf(msg).map((x) => x.action_id)).toEqual(["sf_proposal:0", "sf_proposal:1", "sf_proposal_all", "sf_proposal_cancel"]);
    // Values carry the proposal ID and index only: no command text, no args.
    expect(buttonsOf(msg).map((x) => x.value)).toEqual([`${id}:0`, `${id}:1`, id, id]);
    expect(JSON.stringify(buttonsOf(msg))).not.toMatch(/ship it|not needed/);
    expect((await f.store.listCommandProposals(id)).map((r) => [r.idx, r.work_item_id, r.command, r.args, r.author_id, r.status])).toEqual([
      [0, a.id, "approve", "ship it", "slack:U0ALICE", "pending"],
      [1, b.id, "reject", "not needed any more", "slack:U0ALICE", "pending"],
    ]);
    // The same reply delivered again (a new event ID for the same message) stores nothing new and posts nothing more.
    await deliver(f, eventEnvelope(message("1800000090.000300", "please do what we said", { thread_ts: ts }), "Ev0AGAIN584"));
    expect(await f.store.listCommandProposals(id)).toHaveLength(2);
    expect(replies(f, ts, PROPOSAL_TEXT)).toHaveLength(1);
    expect((await f.store.getWorkItem(a.id))!.blocked_reason).toBe("spec_pending");
    expect((await f.store.getWorkItem(b.id))!.stage).not.toBe("CLOSED");
  });

  it("a confirm applies its command once, with the args read from the store; a second confirm applies nothing and gets one reply", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000091.000100";
    const a = await specPending(f, ts);
    const { id } = await propose(f, llm, ts, "1800000091.000200", [{ item: a.id, command: "approve", args: "ship it" }]);
    await pressed(f, ts, "sf_proposal:0", `${id}:0`);
    const after = (await f.store.getWorkItem(a.id))!;
    expect(after.stage).toBe("RUNNING");
    const approved = (await f.store.listStateChanges(a.id)).filter((c) => c.reason === "spec_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]!.actor).toEqual({ kind: "user", id: "github:1" });
    expect(approved[0]!.detail?.note).toBe("ship it");
    expect(await statuses(f, id)).toEqual([[0, "applied", "github:1", null]]);
    // The press stored one confirm row as the linked user; the args are not on it.
    expect((await f.store.listCliCommandsAfter(0, 50)).map((c) => [c.command, c.actor, c.args])).toEqual([
      ["proposal_confirm", "github:1", { item: a.id, proposal: id, index: 0 }],
    ]);

    await pressed(f, ts, "sf_proposal:0", `${id}:0`);
    await pressed(f, ts, "sf_proposal_all", id);
    expect((await f.store.getWorkItem(a.id))!.version).toBe(after.version);
    const again = replies(f, ts, /^Nothing was applied this time/);
    expect(again).toHaveLength(2);
    for (const r of again) expect(r.text).toContain("was already applied");
  });

  it("a command refused at confirm time (the item moved on) gets one reply saying why, and its row is marked refused", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000092.000100";
    const a = await specPending(f, ts);
    const { id } = await propose(f, llm, ts, "1800000092.000200", [{ item: a.id, command: "approve", args: "" }]);
    await deliver(f, eventEnvelope(mention("1800000092.000300", "/approve", { thread_ts: ts })));
    await f.controller.tickCommands();
    const moved = (await f.store.getWorkItem(a.id))!;
    expect(moved.stage).toBe("RUNNING");
    await pressed(f, ts, "sf_proposal:0", `${id}:0`);
    expect((await f.store.getWorkItem(a.id))!.version).toBe(moved.version);
    const [row] = await f.store.listCommandProposals(id);
    expect(row).toMatchObject({ status: "refused", answered_by: "github:1" });
    expect(row!.refusal).toContain("implementing");
    const refused = replies(f, ts, /^`\/approve` was not applied/);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.text).toContain(escapeSlack(row!.refusal!));
  });

  it("a press is checked like the typed command: a linked presser without the permission is refused; an unlinked one gets one refusal and stores nothing", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000093.000100";
    const a = await specPending(f, ts);
    const { id } = await propose(f, llm, ts, "1800000093.000200", [{ item: a.id, command: "approve", args: "" }]);
    const before = await f.store.getWorkItem(a.id);

    await pressed(f, ts, "sf_proposal:0", `${id}:0`, "U0CAROL");
    expect(replies(f, ts, /not linked to a factory user/)).toHaveLength(1);
    expect(await f.store.listCliCommandsAfter(0, 50)).toEqual([]);
    expect(await statuses(f, id)).toEqual([[0, "pending", null, null]]);

    await pressed(f, ts, "sf_proposal:0", `${id}:0`, "U0BOB");
    expect(await f.store.getWorkItem(a.id)).toEqual(before);
    const [row] = await f.store.listCommandProposals(id);
    expect(row).toMatchObject({ status: "refused", answered_by: "github:2" });
    // The refusal a typed `/approve` from the same account gets.
    expect(row!.refusal).toContain("github:2 has no role that allows it");
    expect(replies(f, ts, /^`\/approve` was not applied/)).toHaveLength(1);
  });

  it("Confirm all applies the pending commands in index order; one refused command does not stop the others", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000094.000100";
    const a = await specPending(f, ts);
    const b = await specPending(f, "1800000094.000200");
    const c = await specPending(f, "1800000094.000300");
    const { id } = await propose(f, llm, ts, "1800000094.000400", [
      { item: a.id, command: "approve", args: "" },
      { item: b.id, command: "approve", args: "" },
      { item: c.id, command: "approve", args: "" },
    ]);
    // b moves on before the press, so its approve is refused then.
    await deliver(f, eventEnvelope(mention("1800000094.000500", "/approve", { thread_ts: "1800000094.000200" })));
    await f.controller.tickCommands();
    const order: string[] = [];
    const transition = f.store.transition.bind(f.store);
    f.store.transition = async (input) => {
      if (input.reason === "spec_approved") order.push(input.id);
      return transition(input);
    };
    await pressed(f, ts, "sf_proposal_all", id);
    expect(order).toEqual([a.id, c.id]);
    expect((await statuses(f, id)).map(([i, st]) => [i, st])).toEqual([[0, "applied"], [1, "refused"], [2, "applied"]]);
    expect(replies(f, ts, /^`\/approve` was not applied/)).toHaveLength(1);
  });

  it("Cancel stores no command and applies nothing; a later confirm applies nothing either", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000095.000100";
    const a = await specPending(f, ts);
    const { id } = await propose(f, llm, ts, "1800000095.000200", [{ item: a.id, command: "approve", args: "" }]);
    const before = await f.store.getWorkItem(a.id);
    await pressed(f, ts, "sf_proposal_cancel", id);
    expect(await f.store.listCliCommandsAfter(0, 50)).toEqual([]);
    expect(await f.store.getWorkItem(a.id)).toEqual(before);
    expect(await statuses(f, id)).toEqual([[0, "cancelled", "github:1", null]]);
    expect(replies(f, ts, /^Cancelled by/)).toHaveLength(1);

    await pressed(f, ts, "sf_proposal_all", id);
    expect(await f.store.getWorkItem(a.id)).toEqual(before);
    expect(replies(f, ts, /^Nothing was applied this time/)[0]!.text).toContain("was already cancelled");
  });

  it("a press with a value not shaped as a proposal's starts nothing", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const ts = "1800000096.000100";
    const a = await specPending(f, ts);
    const { id } = await propose(f, llm, ts, "1800000096.000200", [{ item: a.id, command: "approve", args: "" }]);
    await pressed(f, ts, "sf_proposal:0", `${id}:1`);
    await pressed(f, ts, "sf_proposal_all", "/approve ship it");
    expect(await f.store.listCliCommandsAfter(0, 50)).toEqual([]);
    expect(await statuses(f, id)).toEqual([[0, "pending", null, null]]);
  });

  it("a reply on a GitHub issue stays plain text with no buttons; its proposal is still stored once", async () => {
    const llm = new ScriptedLLM();
    const f = await setup({ llm });
    const a = await specPending(f, "1800000097.000100");
    await f.store.createWorkItem(issue(84), system);
    llm.entries = [{ item: a.id, command: "approve", args: "" }];
    f.gh.queue.push(commentEvent(issueRef(84), "584", { provider: "github", subject: "1" }, "approve the slack one please")!);
    await f.controller.tickIntake();
    await f.controller.tickOutbox();
    const posted = f.gh.comments.find((c) => c.marker === "<!-- factory:suggest:584 -->")!;
    expect(posted.body).toMatch(PROPOSAL_TEXT);
    expect(posted.body).not.toMatch(/sf_proposal|"button"|Confirm all/);
    const id = /<!-- factory:proposal:(prop_[0-9a-f]+):approve -->/.exec(posted.body)![1]!;
    expect((await f.store.listCommandProposals(id)).map((r) => [r.work_item_id, r.author_id, r.status])).toEqual([[a.id, "github:1", "pending"]]);
    expect((await f.store.getWorkItem(a.id))!.blocked_reason).toBe("spec_pending");
  });
});

describe("slack source: spec messages and their modals", () => {
  const D3 = [
    { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: false },
    { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: false },
    { question: "Run on forks?", reason: "Forks have no secrets.", options: [], default: "No", owner_only: true },
  ];
  const specMsg = (f: F, ts: string) => f.api.thread(ts).find((m) => m.text?.startsWith("Needs your approval:"))!;
  const sections = (m: { blocks?: readonly unknown[] }) =>
    (m.blocks ?? []).filter((b) => (b as { type: string }).type === "section").map((b) => (b as { text: { text: string } }).text.text);
  const labels = (m: { blocks?: readonly unknown[] }) =>
    ((m.blocks ?? []).find((b) => (b as { type: string }).type === "actions") as { elements: { text: { text: string } }[] }).elements.map((e) => e.text.text);
  type Input = { block_id: string; label: { text: string }; element: { initial_value?: string; multiline?: boolean } };
  const cliRows = async (f: F) => (await f.store.listCliCommandsAfter(0, 50)).map((c) => ({ key: c.key, actor: c.actor, command: c.command, args: c.args }));
  /** A press of a spec message's button, its envelope ID and the trigger_id it carries. */
  const pressSpec = (ts: string, action: string, item: WorkItem, user = "U0ALICE") => {
    const env = press(ts, action, item.id, user);
    const payload = env.payload as { trigger_id: string; actions: { action_ts: string }[] };
    return { env, trigger: payload.trigger_id, action_ts: payload.actions[0]!.action_ts };
  };
  const viewOf = (f: F, i = 0) => f.api.views[i]!.view as { callback_id: string; private_metadata: string; title: { text: string }; submit: { text: string }; blocks: Input[] };

  it("renders the first line with a View button, In short and one Decisions line each with its proposed default, for 0, 1 and 3 decisions", async () => {
    for (const n of [0, 1, 3]) {
      const f = await setup();
      const ts = `18000003${n}0.000100`;
      const item = await specPending(f, ts, { ...triageSpec, decisions: D3.slice(0, n) });
      const m = specMsg(f, ts);
      const s = sections(m);
      expect(s[0]).toBe("Needs your approval: please add a scope gate");
      expect(s[1]).toBe("*In short*\nAS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.");
      if (n === 0) expect(s.some((t) => t.startsWith("*Decisions*"))).toBe(false);
      else {
        expect(s[2]!.split("\n")).toEqual([
          "*Decisions*",
          ...D3.slice(0, n).map((d, i) => `${i + 1}. ${escapeSlack(d.question)} _Proposed default: ${d.default}_`),
        ]);
      }
      // No dashboard_url: no Full spec link and no 127.0.0.1 anywhere; the first section's View button names the item.
      expect(JSON.stringify(m.blocks)).not.toMatch(/Full spec|127\.0\.0\.1/);
      expect((m.blocks![0] as { accessory: { action_id: string; value: string } }).accessory).toMatchObject({ action_id: "sf_view", value: item.id });
      // Buttons: Approve with defaults, Other… with a decision, Reject…; no per-decision "Default: …" button.
      expect(labels(m)).toEqual(n === 0 ? ["Approve with defaults", "Reject…"] : ["Approve with defaults", "Other…", "Reject…"]);
      expect(JSON.stringify(m.blocks)).not.toContain("Default:");
    }
  });

  it("leaves out Problem, Applied defaults, Done when, In scope, Out of scope, Files and Risk", async () => {
    const f = await setup();
    const ts = "1800000340.000100";
    await specPending(f, ts, {
      ...triageSpec, decisions: D3, applied_defaults: ["Run on Linux only."], in_scope: ["the CI job"], out_of_scope: ["the docs"],
    });
    const text = JSON.stringify(specMsg(f, ts).blocks);
    for (const h of ["Problem", "Applied defaults", "Done when", "In scope", "Out of scope", "Files", "Risk"]) expect(text).not.toContain(h);
  });

  it("the Full spec link goes to an https slack.dashboard_url when set, with no View button", async () => {
    const f = await setup({ dashboard_url: "https://factory.example.com/" });
    const ts = "1800000341.000100";
    const item = await specPending(f, ts);
    expect(sections(specMsg(f, ts)).at(-1)).toBe(`<https://factory.example.com/app/items/${item.id}|Full spec>`);
    expect(JSON.stringify(specMsg(f, ts).blocks)).not.toContain("sf_view");
  });

  it("Approve with defaults stores one approve with no answer lines, keyed on the press, as the linked user, and posts nothing", async () => {
    const f = await setup();
    const ts = "1800000342.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    const posts = f.api.calls.length;
    const p = pressSpec(ts, "sf_spec_approve", item);
    // The press and Slack's redelivery of it, both taken in before the controller applies anything.
    await deliver(f, p.env, { ...p.env, envelope_id: "env-again" });
    expect(await cliRows(f)).toEqual([{ key: `cli:slack-${TEAM}-U0ALICE-${p.action_ts}`, actor: "github:1", command: "approve", args: { item: item.id } }]);
    // Nothing posted: the only call after is the controller's status edit once it applied the approve.
    expect(f.api.calls.slice(posts).filter((c) => c.method === "postMessage")).toEqual([]);
    expect(f.api.views).toEqual([]);
    await f.controller.tickCommands();
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
  });

  it("Other… opens one field per decision before the envelope is acked, labelled and prefilled; its submit stores one approve with the non-blank answers", async () => {
    const f = await setup();
    const ts = "1800000343.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    const p = pressSpec(ts, "sf_spec_other", item);
    let ackedAtOpen: boolean | null = null;
    f.api.onOpenView = () => (ackedAtOpen = f.socket.acks.includes(String(p.env.envelope_id)));
    await deliver(f, p.env);
    expect(ackedAtOpen).toBe(false);
    expect(f.api.views.map((v) => v.trigger_id)).toEqual([p.trigger]);
    const view = viewOf(f);
    expect([view.title.text, view.submit.text]).toEqual(["Answer the decisions", "Approve"]);
    expect(view.blocks.map((b) => [b.label.text, b.element.initial_value])).toEqual(D3.map((d, i) => [`${i + 1}. ${d.question}`, d.default]));
    expect(await cliRows(f)).toEqual([]);

    const sub = submission({ id: "V0ANSWERS", callback_id: view.callback_id, private_metadata: view.private_metadata }, { d1: "Only warn", d2: "  ", d3: "Yes, on forks too" });
    await deliver(f, sub);
    expect(await cliRows(f)).toEqual([
      { key: "cli:slack-view-V0ANSWERS", actor: "github:1", command: "approve", args: { item: item.id, text: "1: Only warn\n3: Yes, on forks too" } },
    ]);
    // The same view submitted again: nothing more is stored.
    await deliver(f, { ...sub, envelope_id: "env-resubmit" });
    expect(await cliRows(f)).toHaveLength(1);
    await f.controller.tickCommands();
    const approved = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(storedAnswers(approved.detail).map((a) => a.answer)).toEqual(["Only warn", "scope", "Yes, on forks too"]);
  });

  it("Reject… opens one reason field; its submit stores one reject with that reason", async () => {
    const f = await setup();
    const ts = "1800000344.000100";
    const item = await specPending(f, ts);
    await deliver(f, pressSpec(ts, "sf_spec_reject", item).env);
    const view = viewOf(f);
    expect([view.title.text, view.submit.text]).toEqual(["Reject spec", "Reject"]);
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]!.label.text).toBe("Reason");
    await deliver(f, submission({ id: "V0REJECT", callback_id: view.callback_id, private_metadata: view.private_metadata }, { reason: "not needed\nany more" }));
    expect(await cliRows(f)).toEqual([{ key: "cli:slack-view-V0REJECT", actor: "github:1", command: "reject", args: { item: item.id, text: "not needed any more" } }]);
  });

  it("an unlinked presser or submitter gets the refusal in the thread; nothing is stored and no modal opens", async () => {
    const f = await setup();
    const ts = "1800000345.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    for (const a of ["sf_spec_approve", "sf_spec_other", "sf_spec_reject"]) await deliver(f, pressSpec(ts, a, item, "U0STRANGER").env);
    await deliver(f, submission({ id: "V0STRANGER", callback_id: "sf_spec_answers", private_metadata: item.source.id }, { d1: "x" }, "U0STRANGER"));
    expect(f.api.thread(ts).filter((m) => m.text?.includes("not linked to a factory user"))).toHaveLength(4);
    expect(await cliRows(f)).toEqual([]);
    expect(f.api.views).toEqual([]);
  });

  it("after the spec left needs approval, Approve with defaults and Other… get the stale reply; nothing is stored and no modal opens", async () => {
    const f = await setup();
    const ts = "1800000346.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    await deliver(f, pressSpec(ts, "sf_spec_approve", item).env);
    await f.controller.tickCommands();
    const rows = (await cliRows(f)).length;
    await deliver(f, pressSpec(ts, "sf_spec_approve", item).env);
    await deliver(f, pressSpec(ts, "sf_spec_other", item).env);
    expect(f.api.thread(ts).filter((m) => JSON.stringify(m.blocks ?? []).includes("That button is from an earlier step"))).toHaveLength(2);
    expect(await cliRows(f)).toHaveLength(rows);
    expect(f.api.views).toEqual([]);
  });

  it("a failed views.open is logged once, not retried, and stores nothing", async () => {
    const f = await setup();
    const ts = "1800000347.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    f.api.failViews = "expired_trigger_id";
    let opens = 0;
    f.api.onOpenView = () => opens++;
    const p = pressSpec(ts, "sf_spec_other", item);
    await deliver(f, p.env);
    expect(opens).toBe(1);
    expect(f.socket.acks).toContain(String(p.env.envelope_id));
    expect(f.log.lines.filter((l) => l.msg.includes("views.open failed"))).toHaveLength(1);
    expect(JSON.stringify(f.log.lines)).toContain("expired_trigger_id");
    expect(await cliRows(f)).toEqual([]);
  });

  it("the spec message and its buttons are scanned as one message; a modal is scanned before views.open and a blocked one is withheld", async () => {
    const f = await setup();
    const scanned: string[] = [];
    const scan = f.scanner.scan.bind(f.scanner);
    f.scanner.scan = async (kind, text) => (scanned.push(text), scan(kind, text));
    const ts = "1800000348.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D3 });
    expect(scanned.some((t) => t.includes("Needs your approval: please add a scope gate") && t.includes("sf_spec_approve") && t.includes("sf_spec_reject"))).toBe(true);

    // A modal carrying a known secret (planted here, past the spec's own scan): never opened, one withheld notice.
    f.scanner.scan = async (kind, text) => scan(kind, text.includes('"type":"modal"') ? `${text} ${FAKE_GITHUB_TOKEN}` : text);
    await deliver(f, pressSpec(ts, "sf_spec_other", item).env);
    expect(f.api.views).toEqual([]);
    expect(f.api.thread(ts).filter((m) => m.text?.includes("withheld by the leak scanner"))).toHaveLength(1);
    expect(await cliRows(f)).toEqual([]);
  });

  it("every section is at most 3000 characters; a long one is cut with the cut note", () => {
    const link = "https://factory.example.com/app/items/wi_1";
    const long = { in_short: ["AS-IS: a.", "TO-BE: b."], decisions: [{ n: 1, text: "x".repeat(5000), default: "y" }] };
    const m = renderSpecMessage(long, { id: "wi_1", title: "t" }, { owner: "o", name: "r" }, link);
    const s = sections(m);
    for (const t of s) expect(t.length).toBeLessThanOrEqual(3000);
    expect(s[2]!.endsWith(cutNote("factory task show wi_1", link))).toBe(true);
  });

  it("a needs-approval status with no status message posts nothing; a later status posts one, and the next edits it in place", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000349.000100"), link: "" };
    await f.slack.setStatus(source, "needs_approval", null);
    expect(f.api.calls).toEqual([]);
    await f.slack.setStatus(source, "implementing", null);
    await f.slack.setStatus(source, "in_review", null);
    expect(f.api.calls.map((c) => [c.method, c.text])).toEqual([["postMessage", "Status: *implementing*"], ["updateMessage", "Status: *in review*"]]);
  });
});

describe("slack source: replies under a notice (design 05-sources)", () => {
  const rows = async (f: F) => (await f.store.listCliCommandsAfter(0, 50)).map((c) => [c.command, c.args]);
  const itemCount = async (f: F) => (await f.store.listWorkItems(50)).length;
  const needsYou = (it: WorkItem) => ({
    kind: "needs_you" as const, work_item_id: it.id, title: it.title ?? "", reason: "ready to merge", close_reason: null, thread_url: null, count: 1,
  });
  const summary = { kind: "summary" as const, work_item_id: null, title: "", reason: "", close_reason: null, thread_url: null, count: 2 };

  /** Posts one notice naming `items` (none: a summary only) and returns its ts. */
  async function notice(f: F, items: readonly WorkItem[], channel = CHANNEL): Promise<string> {
    await f.slack.notifyOwner(items.length > 0 ? items.map(needsYou) : [summary]);
    return f.api.messages.filter((m) => m.channel === channel && m.thread_ts === undefined).at(-1)!.ts;
  }

  /** A local work item: `merge` stores its merge row (a Slack item's merge is refused as not local). */
  async function localItem(f: F, n: number): Promise<WorkItem> {
    const source = { type: "local", id: `local-notice-${n}`, link: `local:local-notice-${n}` };
    return (await f.store.createWorkItem({ source, title: `Local ${n}`, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system)).item;
  }

  /** A which-item press: its block names the question (the reply's event ID), its value the item. */
  function whichPress(ts: string, index: number, value: string, question: string, user = "U0ALICE"): Record<string, unknown> {
    const p = press(ts, `sf_notice_item:${index}`, value, user);
    const payload = p.payload as { actions: Record<string, unknown>[] };
    payload.actions[0]!.block_id = `sf_notice_item:${question}`;
    return p;
  }

  it('"go ahead and merge" under a one-item "ready to merge" notice queues that item\'s merge as `merge` does, and makes no item', async () => {
    const f = await setup();
    const item = await localItem(f, 1);
    const ts = await notice(f, [item]);
    expect(f.api.messages.find((m) => m.ts === ts)!.text).toContain("🙋 Needs you: ");
    await deliver(f, eventEnvelope(mention("1800000300.000200", "go ahead and merge", { thread_ts: ts })));
    expect(await rows(f)).toEqual([["merge", { item: item.id }]]);
    expect(await itemCount(f)).toBe(1);
    expect(await f.store.listInboxAfter("slack_thread", 0, 50)).toEqual([]);
  });

  it("a command's answer posts in the notice's thread, not in the item's own thread: the source's and the controller's", async () => {
    const f = await setup();
    const thread = "1800000301.000100";
    const item = await specPending(f, thread);
    const ts = await notice(f, [item]);
    const before = f.api.thread(thread).length;
    // `merge` on a Slack item: the CLI's refusal; `resolve` while the spec waits: stored, then refused by the controller.
    await deliver(f, eventEnvelope(mention("1800000301.000200", "go ahead and merge", { thread_ts: ts })));
    await deliver(f, eventEnvelope(mention("1800000301.000300", "resolve", { thread_ts: ts })));
    await f.controller.tickCommands();
    await f.controller.tickOutbox();
    const answers = f.api.thread(ts).map((m) => m.text ?? "");
    expect(answers.some((t) => t.includes("is not a local work item"))).toBe(true);
    expect(answers.some((t) => t.includes("was not applied"))).toBe(true);
    expect(f.api.thread(thread).slice(before).filter((m) => /not a local work item|was not applied/.test(m.text ?? ""))).toEqual([]);
  });

  const FORMS = ["merge", "approve", "retry", "revise narrower scope", "reject duplicate request", "resolve", "/revise narrower scope", "go ahead and merge"];
  for (const form of FORMS) {
    it(`\`${form}\` under a one-item notice reads as in the item's own thread`, async () => {
      const f = await setup();
      const [a, b] = [await specPending(f, "1800000310.000100"), await specPending(f, "1800000310.000200")];
      const ts = await notice(f, [a]);
      const bBefore = f.api.thread("1800000310.000200").length;
      await deliver(f, eventEnvelope(mention("1800000310.000300", form, { thread_ts: ts })));
      await deliver(f, eventEnvelope(mention("1800000310.000400", form, { thread_ts: "1800000310.000200" })));
      await f.controller.tickCommands();
      await f.controller.tickOutbox();
      // The notice's reply stored the same row for `a` as the thread's for `b` (none for `merge`: a Slack item is not local).
      const stored = (await rows(f)).map(([command, args]) => [command, { ...(args as object), item: (args as { item: string }).item === a.id ? "a" : "b" }]);
      const same = (r: unknown[]) => JSON.stringify([r[0], { ...(r[1] as object), item: "" }]);
      expect(stored.map((r) => (r[1] as { item: string }).item)).toEqual(form.endsWith("merge") ? [] : ["a", "b"]);
      expect(new Set(stored.map(same)).size).toBeLessThanOrEqual(1);
      expect(fields(await f.store.getWorkItem(a.id))).toEqual(fields(await f.store.getWorkItem(b.id)));
      const answers = (ms: { text?: string }[]) => ms.map((m) => (m.text ?? "").replaceAll(a.id, "X").replaceAll(b.id, "X")).filter((t) => /not a local work item|was not applied/.test(t));
      expect(answers(f.api.thread(ts))).toEqual(answers(f.api.thread("1800000310.000200").slice(bBefore)));
      expect(await itemCount(f)).toBe(2);
    });
  }

  it("a notice naming two items asks which, with one button per item; nothing runs before a press; a press runs the reply on that item as the presser", async () => {
    const f = await setup();
    const [a, b] = [await localItem(f, 1), await localItem(f, 2)];
    const ts = await notice(f, [a, b]);
    await deliver(f, eventEnvelope(mention("1800000320.000200", "go ahead and merge", { thread_ts: ts }), "Ev0WHICH1"));
    const [question, ...more] = f.api.thread(ts);
    expect(more).toEqual([]);
    expect(question!.text).toContain("Which one");
    const actions = question!.blocks!.find((x) => (x as { type: string }).type === "actions") as { block_id: string; elements: { action_id: string; value: string }[] };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([["sf_notice_item:0", a.id], ["sf_notice_item:1", b.id]]);
    expect(actions.block_id).toBe("sf_notice_item:Ev0WHICH1");
    expect(await f.store.getNoticeQuestion("Ev0WHICH1")).toMatchObject({ channel: CHANNEL, notice_ts: ts, text: "go ahead and merge" });
    expect(await rows(f)).toEqual([]);
    // An item the notice does not name, or an unknown question: nothing.
    await deliver(f, whichPress(ts, 0, "wi_not_named", "Ev0WHICH1"), whichPress(ts, 0, a.id, "Ev0OTHER"));
    expect(await rows(f)).toEqual([]);
    await deliver(f, whichPress(ts, 1, b.id, "Ev0WHICH1"));
    expect(await rows(f)).toEqual([["merge", { item: b.id }]]);
    expect((await f.store.listCliCommandsAfter(0, 50))[0]!.actor).toBe("github:1");
    expect(await itemCount(f)).toBe(2);
  });

  it("an unlinked account gets the usual refusal in the notice's thread, for a reply and for a press, and nothing is stored", async () => {
    const f = await setup();
    const [a, b] = [await localItem(f, 1), await localItem(f, 2)];
    const one = await notice(f, [a]);
    await deliver(f, eventEnvelope(mention("1800000330.000200", "go ahead and merge", { thread_ts: one, user: "U0EVE" })));
    expect(f.api.thread(one).map((m) => m.text)).toEqual([toMrkdwn(UNLINKED, { owner: "o", name: "r" })]);
    const two = await notice(f, [a, b]);
    await deliver(f, eventEnvelope(mention("1800000330.000300", "merge", { thread_ts: two }), "Ev0WHICH2"));
    await deliver(f, whichPress(two, 0, a.id, "Ev0WHICH2", "U0EVE"));
    expect(f.api.thread(two).at(-1)!.text).toBe(toMrkdwn(UNLINKED, { owner: "o", name: "r" }));
    expect(await rows(f)).toEqual([]);
    expect(await itemCount(f)).toBe(2);
  });

  it("no reply under a notice makes an item: words with no command get one reply naming the commands, with nothing stored and no model call", async () => {
    let calls = 0;
    const llm: LLMProvider = { complete: (r) => (calls++, new ApproveLLM().complete(r)) };
    const f = await setup({ llm });
    const item = await specPending(f, "1800000340.000100");
    const ts = await notice(f, [item]);
    const before = calls;
    await deliver(f, eventEnvelope(mention("1800000340.000200", "please build a dashboard for this", { thread_ts: ts })));
    await f.controller.tickCommands();
    const [reply, ...more] = f.api.thread(ts);
    expect(more).toEqual([]);
    expect(reply!.text).toContain("names no command");
    expect(reply!.text).toContain("`approve [notes]`");
    expect(reply!.blocks!.some((x) => (x as { type: string }).type === "actions")).toBe(false);
    expect([calls - before, await itemCount(f), (await rows(f)).length]).toEqual([0, 1, 0]);
    expect(await f.store.listInboxAfter("slack_thread", 0, 50)).toHaveLength(2); // the request and its press only
  });

  it("a notice that names no item (a summary) gets one reply saying so, and makes no item", async () => {
    const f = await setup();
    const ts = await notice(f, []);
    await deliver(f, eventEnvelope(mention("1800000350.000200", "go ahead and merge", { thread_ts: ts })));
    expect(f.api.thread(ts).map((m) => m.text)).toEqual([toMrkdwn(NAMES_NO_ITEM, { owner: "o", name: "r" })]);
    expect([await itemCount(f), (await rows(f)).length]).toEqual([0, 0]);
  });

  it("a slash reply with no mention under a notice runs; a reply with neither is not read", async () => {
    const f = await setup();
    const item = await localItem(f, 1);
    const ts = await notice(f, [item]);
    await deliver(f, eventEnvelope(message("1800000360.000200", "merge it now please", { thread_ts: ts })));
    expect([f.api.thread(ts).length, (await rows(f)).length]).toEqual([0, 0]);
    await deliver(f, eventEnvelope(message("1800000360.000300", "/merge", { thread_ts: ts })));
    expect(await rows(f)).toEqual([["merge", { item: item.id }]]);
  });

  it("the notices channel is read for replies under a notice even when it is not in slack.channels; nothing else there is read", async () => {
    const f = await setup({ notify_channel: OTHER_CHANNEL });
    const item = await localItem(f, 1);
    const ts = await notice(f, [item], OTHER_CHANNEL);
    await deliver(f, eventEnvelope(mention("1800000370.000100", "please make a thing", { channel: OTHER_CHANNEL })));
    await deliver(f, eventEnvelope(mention("1800000370.000300", "go ahead and merge", { channel: OTHER_CHANNEL, thread_ts: ts })));
    expect(await rows(f)).toEqual([["merge", { item: item.id }]]);
    expect(f.api.thread("1800000370.000100", OTHER_CHANNEL)).toEqual([]);
    // A thread there with no record is a notice posted before the records: it names no item.
    await deliver(f, eventEnvelope(mention("1800000370.000500", "approve", { channel: OTHER_CHANNEL, thread_ts: "1700000000.000100" })));
    expect(f.api.thread("1700000000.000100", OTHER_CHANNEL).map((m) => m.text)).toEqual([toMrkdwn(NAMES_NO_ITEM, { owner: "o", name: "r" })]);
    expect([await itemCount(f), await f.store.listInboxAfter("slack_thread", 0, 50)]).toEqual([1, []]);
  });

  it("a mention in a thread that is neither an item nor a notice still makes an item from the thread", async () => {
    const f = await setup();
    await notice(f, [await localItem(f, 1)]);
    await deliver(f, eventEnvelope(mention("1800000380.000200", "please add a scope gate", { thread_ts: "1800000380.000100" })));
    expect(await itemOf(f, "1800000380.000100")).not.toBeNull();
  });
});

describe('slack source: "go ahead and merge" in an item\'s own thread', () => {
  it("is `merge`, in any case; other wording keeps today's reading", async () => {
    const f = await setup();
    const ts = "1800000390.000100";
    await specPending(f, ts);
    const refusals = () => f.api.thread(ts).filter((m) => m.text?.includes("is not a local work item")).length;
    await deliver(f, eventEnvelope(mention("1800000390.000200", "merge", { thread_ts: ts })));
    await deliver(f, eventEnvelope(mention("1800000390.000300", "Go Ahead And Merge", { thread_ts: ts })));
    expect(refusals()).toBe(2);
    await deliver(f, eventEnvelope(mention("1800000390.000400", "go ahead and merge it after lunch", { thread_ts: ts })));
    expect(refusals()).toBe(2);
    const last = (await f.store.listInboxAfter("slack_thread", 0, 50)).at(-1)!.event;
    expect(last).toMatchObject({ kind: "plain_comment", body: "go ahead and merge it after lunch" });
  });
});

describe("slack source: View in Slack, the item modal (design 05-sources)", () => {
  const NOTIFY = "C0NOTICES";
  const D1 = [{ question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: [], default: "Fail the job", owner_only: false }];
  type Block = { type: string; text?: { text: string }; elements?: { action_id: string; text: { text: string } }[] };
  type View = { callback_id: string; private_metadata: string; title: { text: string }; submit?: unknown; blocks: Block[] };
  const sectionTexts = (v: View) => v.blocks.filter((b) => b.type === "section").map((b) => b.text!.text);
  const buttonsOf = (v: View) => v.blocks.find((b) => b.type === "actions")?.elements?.map((e) => [e.text.text, e.action_id]) ?? [];
  const cliRows = async (f: F) => (await f.store.listCliCommandsAfter(0, 50)).map((c) => ({ key: c.key, actor: c.actor, command: c.command, args: c.args }));
  /** A View press on a message in `channel` (a spec message's thread, or a top-level notice line). */
  const viewPress = (item_id: string, channel = CHANNEL, user = "U0ALICE", thread_ts?: string) => {
    const env = press(thread_ts ?? "1800000000.999999", "sf_view", item_id, user);
    const payload = env.payload as Record<string, unknown>;
    payload.channel = { id: channel };
    payload.container = { type: "message", channel_id: channel, ...(thread_ts ? { thread_ts } : {}) };
    if (!thread_ts) payload.message = { ts: "1800000000.999999" };
    return env;
  };
  /** The open item modal as a press inside it names it. */
  const opened = (f: F, i = 0) => ({ id: `V0ITEM${i}`, callback_id: (f.api.views[i]!.view as View).callback_id, private_metadata: (f.api.views[i]!.view as View).private_metadata });
  /** A local item (no Slack thread), moved to `patch`, with one factory message `body` on its thread. */
  async function localItem(f: F, sid: string, patch: Record<string, unknown>, body: string): Promise<WorkItem> {
    const { item } = await f.store.createWorkItem(
      { source: { type: "local", id: sid, link: `local:${sid}` }, title: `local ${sid}`, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
      { kind: "user", id: "github:1" as UserId },
    );
    await f.store.transition({ id: item.id, expected_version: item.version, patch: patch as never, actor: system, reason: "x" });
    await f.store.recordItemMessage({ work_item_id: item.id, marker: `<!-- factory:test:${sid} -->`, body });
    return (await f.store.getWorkItem(item.id))!;
  }
  const SPEC_PATCH = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
  const MERGE_PATCH = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };
  const specBody = ["## Factory spec", "", "### In short", "AS-IS: a.", "TO-BE: **b**.", "", "### Decisions for you", "1. Name it? Proposed default: x.", "", commandFooter({ phase: "spec_pending", has_pr: false })].join("\n");

  it("View on a waiting spec opens the item modal: title, state, reason, the spec as mrkdwn, Approve, Other… and Reject…; views.open is the only Slack call", async () => {
    const f = await setup();
    const ts = "1800000400.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D1 });
    const [calls, reads, ids] = [f.api.calls.length, f.api.threadReplyCalls, f.api.identityCalls];
    const env = viewPress(item.id, CHANNEL, "U0ALICE", ts);
    await deliver(f, env);
    expect(f.api.views.map((v) => v.trigger_id)).toEqual([(env.payload as { trigger_id: string }).trigger_id]);
    const v = f.api.views[0]!.view as View;
    expect([v.callback_id, v.private_metadata, v.title.text, v.submit]).toEqual(["sf_item", item.id, "Work item", undefined]);
    const s = sectionTexts(v);
    expect(s[0]).toBe("*please add a scope gate*\nState: spec waiting for approval\nNeeds you for: spec to approve");
    // The whole spec as mrkdwn (its heading bold, the parts the spec message leaves out included), not just In short.
    expect(s[1]!.startsWith("*Factory spec*")).toBe(true);
    expect(s.slice(1).join("\n")).toContain("AS-IS: nothing checks the scope.");
    expect(s.slice(1).join("\n")).toContain("*Done when*");
    expect(s.join("\n")).not.toMatch(/<!--|Commands you can reply with now/);
    expect(buttonsOf(v)).toEqual([["Approve", "sf_spec_approve"], ["Other…", "sf_spec_other"], ["Reject…", "sf_spec_reject"]]);
    // Store reads only: no post, update, thread read or identity call; no 127.0.0.1 in any message or modal.
    expect([f.api.calls.length, f.api.threadReplyCalls, f.api.identityCalls, f.api.updatedViews, f.api.pushedViews]).toEqual([calls, reads, ids, [], []]);
    expect(JSON.stringify([f.api.messages, f.api.views])).not.toContain("127.0.0.1");
    expect(await cliRows(f)).toEqual([]);
  });

  it("Approve inside the modal stores the thread button's approve; Other… and Reject… open their modal with views.push", async () => {
    const f = await setup();
    const ts = "1800000401.000100";
    const item = await specPending(f, ts, { ...triageSpec, decisions: D1 });
    await deliver(f, viewPress(item.id, CHANNEL, "U0ALICE", ts));
    const view = opened(f);
    const other = modalPress(view, "sf_spec_other", item.id);
    await deliver(f, other, modalPress(view, "sf_spec_reject", item.id));
    expect(f.api.views).toHaveLength(1);
    expect(f.api.pushedViews.map((v) => v.trigger_id)[0]).toBe((other.payload as { trigger_id: string }).trigger_id);
    expect(f.api.pushedViews.map((v) => [(v.view as View).callback_id, (v.view as View).private_metadata])).toEqual([["sf_spec_answers", item.source.id], ["sf_spec_reject", item.source.id]]);
    const approve = modalPress(view, "sf_spec_approve", item.id);
    await deliver(f, approve);
    const action_ts = (approve.payload as { actions: { action_ts: string }[] }).actions[0]!.action_ts;
    expect(await cliRows(f)).toEqual([{ key: `cli:slack-${TEAM}-U0ALICE-${action_ts}`, actor: "github:1", command: "approve", args: { item: item.id } }]);
    // A Slack item's answers stay in its thread, as for the thread's buttons: the modal is not updated.
    expect(f.api.updatedViews).toEqual([]);
    await f.controller.tickCommands();
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
  });

  it("an unlinked presser opens no modal and makes no Slack call; a View from an unlisted channel that is not the notices channel does nothing", async () => {
    const f = await setup();
    const ts = "1800000402.000100";
    const item = await specPending(f, ts);
    const calls = f.api.calls.length;
    await deliver(f, viewPress(item.id, CHANNEL, "U0STRANGER", ts), viewPress(item.id, OTHER_CHANNEL));
    expect([f.api.views, f.api.calls.length, f.api.updatedViews, f.api.pushedViews]).toEqual([[], calls, [], []]);
  });

  it("a local item's View from the notices channel (not listed): Approve stores the command, posts nothing and updates the modal to one line (owner answers 1 and 2)", async () => {
    const f = await setup({ notify_channel: NOTIFY });
    const item = await localItem(f, "view-spec", SPEC_PATCH, specBody);
    await deliver(f, viewPress(item.id, NOTIFY));
    const v = f.api.views[0]!.view as View;
    expect(sectionTexts(v)[0]).toBe("*local view-spec*\nState: spec waiting for approval\nNeeds you for: spec to approve");
    expect(sectionTexts(v)[1]).toBe("*Factory spec*\n\n*In short*\nAS-IS: a.\nTO-BE: *b*.\n\n*Decisions for you*\n1. Name it? Proposed default: x.");
    expect(buttonsOf(v).map(([l]) => l)).toEqual(["Approve", "Other…", "Reject…"]);
    const posts = f.api.calls.length;
    await deliver(f, modalPress(opened(f), "sf_spec_approve", item.id));
    expect((await cliRows(f)).map((r) => [r.actor, r.command, r.args])).toEqual([["github:1", "approve", { item: item.id }]]);
    expect(f.api.calls.length).toBe(posts);
    expect(f.api.updatedViews.map((u) => [u.view_id, sectionTexts(u.view as View)])).toEqual([["V0ITEM0", ["Approved. The factory answers in the item's own thread."]]]);
  });

  it("a local item's Reject… pushes the reason modal; its submit stores the reject and updates the item modal; an unlinked press gets the refusal line", async () => {
    const f = await setup({ notify_channel: NOTIFY });
    const item = await localItem(f, "view-reject", SPEC_PATCH, specBody);
    await deliver(f, viewPress(item.id, NOTIFY));
    await deliver(f, modalPress(opened(f), "sf_spec_reject", item.id, "U0STRANGER"));
    expect(sectionTexts(f.api.updatedViews[0]!.view as View)[0]).toMatch(/^This Slack account is not linked to a factory user/);
    expect(f.api.pushedViews).toEqual([]);
    await deliver(f, modalPress(opened(f), "sf_spec_reject", item.id));
    const pushed = f.api.pushedViews[0]!.view as View;
    expect([pushed.callback_id, pushed.private_metadata]).toEqual(["sf_spec_reject", item.id]);
    await deliver(f, submission({ id: "V0PUSHED", callback_id: pushed.callback_id, private_metadata: pushed.private_metadata, root_view_id: "V0ITEM0" }, { reason: "not now" }));
    expect(await cliRows(f)).toEqual([{ key: "cli:slack-view-V0PUSHED", actor: "github:1", command: "reject", args: { item: item.id, text: "not now" } }]);
    expect(f.api.updatedViews.map((u) => [u.view_id, sectionTexts(u.view as View)[0]]).at(-1)).toEqual(["V0ITEM0", "Rejected. The factory answers in the item's own thread."]);
    expect(f.api.messages).toEqual([]);
  });

  it("a ready-to-merge item's modal has a Merge button; Merge stores one merge command as the linked user", async () => {
    const f = await setup();
    const item = await localItem(f, "view-merge", MERGE_PATCH, "Review passed. Ready to merge.");
    await deliver(f, viewPress(item.id));
    const v = f.api.views[0]!.view as View;
    expect(sectionTexts(v)).toEqual(["*local view-merge*\nState: waiting for a human merge\nNeeds you for: ready to merge", "Review passed. Ready to merge."]);
    expect(buttonsOf(v)).toEqual([["Merge", "sf_merge"]]);
    const merge = modalPress(opened(f), "sf_merge", item.id);
    await deliver(f, merge, { ...merge, envelope_id: "env-merge-again" });
    expect((await cliRows(f)).map((r) => [r.actor, r.command, r.args])).toEqual([["github:1", "merge", { item: item.id }]]);
    expect(sectionTexts(f.api.updatedViews[0]!.view as View)).toEqual(["Merge requested. The factory answers in the item's own thread."]);
    // A Merge press on an item no longer ready to merge stores nothing: the modal says what it is now.
    await f.store.transition({ id: item.id, expected_version: item.version, patch: { blocked_on: "none", blocked_reason: null }, actor: system, reason: "x" });
    await deliver(f, modalPress(opened(f), "sf_merge", item.id));
    expect(await cliRows(f)).toHaveLength(1);
    expect(sectionTexts(f.api.updatedViews.at(-1)!.view as View)[0]).toMatch(/^That button is from an earlier step, so it did nothing now\. The item is now in review\.$/);
  });

  it("every modal body passes the egress scan before views.open; a withheld one shows the withheld notice and no blocked text", async () => {
    const f = await setup();
    const ts = "1800000403.000100";
    const item = await specPending(f, ts);
    const scan = f.scanner.scan.bind(f.scanner);
    const scanned: string[] = [];
    f.scanner.scan = async (kind, text) => (scanned.push(text), scan(kind, text.includes('"callback_id":"sf_item"') ? `${text} ${FAKE_GITHUB_TOKEN}` : text));
    await deliver(f, viewPress(item.id, CHANNEL, "U0ALICE", ts));
    expect(scanned.some((t) => t.includes("please add a scope gate") && t.includes("sf_spec_approve"))).toBe(true);
    const v = f.api.views[0]!.view as View;
    expect(sectionTexts(v)).toEqual([expect.stringContaining("withheld by the leak scanner")]);
    expect(JSON.stringify(v)).not.toMatch(/scope gate|sf_spec_approve/);
  });

  it("stays within Slack's limits: at most 100 blocks, each section at most 3000 characters; a cut body ends with the factory task show note", () => {
    const item = { id: "wi_long", title: "t", stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", source: { type: "local", id: "x", link: "" } } as unknown as WorkItem;
    const v = itemModal(item, [Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")], { owner: "o", name: "r" }) as unknown as View;
    expect(v.blocks.length).toBeLessThanOrEqual(100);
    for (const t of sectionTexts(v)) expect(t.length).toBeLessThanOrEqual(3000);
    expect(sectionTexts(v).at(-1)).toBe(cutNote("factory task show wi_long"));
  });
});
