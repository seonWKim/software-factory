// The `slack` stream source (issue #109), end to end on a fake Slack: Socket Mode envelopes through the real
// listener and inbox into the controller, and the thread replies back out. docs/plugins/source-adapter.md, `slack`.

import { afterEach, describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import type { Logger } from "../src/core/log.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { AuthAction, AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { Secret, SecretName } from "../src/interfaces/secret-store.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HttpSlackApi, SLACK_BOT_TOKEN, type FetchFn } from "../src/impl/source/slack-api.js";
import { ACTION_CANCEL, ACTION_CONFIRM, cutNote, escapeSlack, toMrkdwn } from "../src/impl/source/slack-format.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { commentEvent } from "../src/core/comment-event.js";
import { commandState, commandsFor, helpReply, refusalText, roleRefusal, specNotWaiting } from "../src/core/commands.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { plainRefusal } from "../web/src/api.js";
import { storedAnswers } from "../src/shared/command-notes.js";
import { parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { META_STATUS, SlackSource, parseSlackSourceId, slackLink, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeForge, FakeSource, config, issueRef, recordingLog, silent, triageSpec, waitFor } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSlackApi, FakeSocket, OTHER_CHANNEL, TEAM, eventEnvelope, mention, message, press } from "./helpers/slack.js";
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

/** Suggests `/approve` with high confidence for any plain reply. */
class ApproveLLM implements LLMProvider {
  async complete(): Promise<LLMResponse> {
    const parsed = { command: "approve", args: "", confidence: 0.95 };
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

async function setup(opts: { store?: (s: FactoryStore) => FactoryStore; channels?: string[] } = {}) {
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
  const slack = new SlackSource({ api, connect: socket.connect, channels: opts.channels ?? [CHANNEL], scanner, store, repo, log, settings });
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
    store: real, sources: [gh, slack], forge, auth, local_auth: new LocalAuthProvider(real), clock, config, log, scanner, llm: new ApproveLLM(),
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

/** A mention that became an item, triaged: its spec is waiting in the thread. */
async function specPending(f: F, ts = "1800000001.000100", spec: Record<string, unknown> = triageSpec): Promise<WorkItem> {
  await deliver(f, eventEnvelope(mention(ts, "please add a scope gate")));
  await finishAll(f, "triage", { spec });
  const item = (await itemOf(f, ts))!;
  expect(item.blocked_reason).toBe("spec_pending");
  return item;
}

const fields = (it: WorkItem | null) => it && { stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason };

describe("slack source: intake", () => {
  it("a mention of the bot in a listed channel creates exactly one work item, keyed slack:<team>:<channel>:<thread ts>", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000001.000100", "please add a scope gate")));
    const items = await f.store.listWorkItems(10);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toEqual({
      type: "slack_thread", id: `slack:${TEAM}:${CHANNEL}:1800000001.000100`, link: `https://slack.com/archives/${CHANNEL}/p1800000001000100`,
    });
    expect(items[0]!.title).toBe("please add a scope gate");
    expect(items[0]!.requester_id).toBe("github:1");
    expect(parseSlackSourceId(items[0]!.source.id)).toEqual({ team: TEAM, channel: CHANNEL, thread_ts: "1800000001.000100" });
    // The status message is the thread's acknowledgement.
    expect(f.api.thread("1800000001.000100").map((m) => m.text)).toEqual(["Status: *triaging*"]);
  });

  it("a mention inside a thread starts the item from the thread root", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000002.000200", "can the factory take this?", { thread_ts: "1800000002.000100" })));
    expect((await itemOf(f, "1800000002.000100"))?.source.id).toBe(sourceId("1800000002.000100"));
  });

  it("the message + app_mention pair Slack sends for one mention creates one item (owner's live test)", async () => {
    const f = await setup();
    const ts = "1794038471.990329";
    await deliver(
      f,
      eventEnvelope(message(ts, `<@${BOT}> small request`), "Ev0CFTHQ6TA5"),
      eventEnvelope(mention(ts, "small request"), "Ev0CFTHQ8WBB"),
    );
    expect(await f.store.listWorkItems(10)).toHaveLength(1);
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
    await deliver(f, eventEnvelope(mention(ts, "add a gate", profile)));
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
    expect((await f.store.listInboxAfter("slack_thread", 0, 50)).map((r) => r.dedupe_key.split(":")[0])).toEqual(["event"]);
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
  it("posts the spec in the thread with buttons for the commands that apply now, from the command table", async () => {
    const f = await setup();
    const ts = "1800000008.000100";
    await specPending(f, ts);
    const spec = f.api.thread(ts).find((m) => m.text?.includes("Factory spec") || FakeSlackApi.buttons(m).length > 0)!;
    expect(spec).toBeTruthy();
    // spec_pending: approve, reject, revise, help apply; reject and revise take text, so they stay typed.
    expect(FakeSlackApi.buttons(spec)).toEqual(["sf_cmd:approve", "sf_cmd:help"]);
    const text = JSON.stringify(spec.blocks);
    expect(text).not.toContain("<!--");
    expect(text).toContain(`<@${BOT}> /revise`);
    expect(text).toContain(`<@${BOT}> /approve`);
    expect(text).toContain("approve with no slash works too");
    expect(text).toContain(`<@${BOT}> /help`);
    expect(f.api.thread(ts).find((m) => m.text?.startsWith("Status:"))!.text).toBe("Status: *needs approval*");
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

  it("a plain reply gets a suggestion with Confirm and Cancel; Cancel changes nothing, nothing runs before Confirm", async () => {
    const f = await setup();
    const ts = "1800000014.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    await deliver(f, eventEnvelope(message("1800000014.000200", "looks good to me", { thread_ts: ts })));
    const suggestion = f.api.thread(ts).find((m) => m.text?.startsWith("Did you mean"))!;
    expect(FakeSlackApi.buttons(suggestion)).toEqual([ACTION_CONFIRM, ACTION_CANCEL]);
    expect(await f.store.getWorkItem(item.id)).toEqual(before);

    const inbox = (await f.store.listInboxAfter("slack_thread", 0, 100)).length;
    await deliver(f, press(ts, ACTION_CANCEL, "cancel"));
    expect(await f.store.getWorkItem(item.id)).toEqual(before);
    expect(await f.store.listInboxAfter("slack_thread", 0, 100)).toHaveLength(inbox);

    await deliver(f, press(ts, ACTION_CONFIRM, "/approve"));
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("RUNNING");
  });

  it("the thread gets a link to the PR once there is one; PR status goes to the forge", async () => {
    const f = await setup();
    const ts = "1800000015.000100";
    const item = await specPending(f, ts);
    await deliver(f, press(ts, "sf_cmd:approve", "/approve"));
    await finishAll(f, "implement", { pr_number: 42 });
    expect((await f.store.getWorkItem(item.id))!.pr_number).toBe(42);
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
    // An item whose change_ref names PR 57 and that has no pr_number: the link can only come from change_ref.
    const read = f.store.getWorkItemBySource.bind(f.store);
    f.store.getWorkItemBySource = async (type, id) => {
      const it = await read(type, id);
      return it && { ...it, pr_number: null, change_ref: "57" };
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
    await deliver(f, eventEnvelope(mention(ts, "add a gate")));
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
    expect(channel).not.toContain("/approve");
    const replies = f.api.thread("1800000035.000100").filter((m) => m.text?.startsWith("Commands you can run in this item"));
    expect(replies).toHaveLength(2);
    expect(replies[0]!.text).toContain("/approve");
    expect(replies[1]!.text).not.toContain("/approve");
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

  it("a mention in plain words outside an item's thread is a request: it starts a work item, as `task create` does", async () => {
    const f = await setup();
    await deliver(f, eventEnvelope(mention("1800000038.000100", "list the open bugs in the parser")));
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
      expect(help).toContain(toMrkdwn(`- \`${c.usage}\`: ${c.description}.`, repo));
    }
    // The slash form after a mention, and the bare approve.
    expect(help).toContain("`@software-factory /help`");
    expect(help).toContain("`approve` with no slash works too: `@software-factory approve` is `@software-factory /approve`.");
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
    await deliver(f, eventEnvelope(mention("1800000062.000500", "approve")));
    expect((await itemOf(f, "1800000062.000500"))?.title).toBe("approve");
  });

  it("the same command refused for the same reason reads the same on GitHub, the CLI, Slack and the dashboard", async () => {
    const f = await setup();
    const want = refusalText("/approve", specNotWaiting("triaging"));
    // One triaging item per surface: an issue for GitHub, the CLI and the dashboard; a thread for Slack.
    const gh = (await f.store.createWorkItem(issue(71), system)).item;
    const cli = (await f.store.createWorkItem(issue(72), system)).item;
    const app = (await f.store.createWorkItem(issue(73), system)).item;
    await deliver(f, eventEnvelope(mention("1800000063.000100", "please add a scope gate")));
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
