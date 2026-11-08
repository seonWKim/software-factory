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
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ACTION_CANCEL, ACTION_CONFIRM } from "../src/impl/source/slack-format.js";
import { SlackSource, parseSlackSourceId, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeForge, FakeSource, config, recordingLog, triageSpec, waitFor } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSlackApi, FakeSocket, OTHER_CHANNEL, TEAM, eventEnvelope, mention, message, press } from "./helpers/slack.js";
import { newStore, w1 } from "./helpers/store.js";

/** Not shaped like any token the scanner's patterns know: it is caught only as a known secret value. */
const FAKE_GITHUB_TOKEN = "fake-github-token-for-the-leak-test-0001";

/**
 * Slack users: U0ALICE is linked to github:1 (may approve), U0BOB to github:2 (known, never allowed to
 * approve), anyone else is not linked. Every authorize call is recorded.
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
  const slack = new SlackSource({
    api, connect: socket.connect, channels: opts.channels ?? [CHANNEL], scanner, store: real, repo: { owner: "o", name: "r" }, log,
  });
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const auth = new SlackAuth();
  const controller = new ControllerRole({
    store: real, sources: [gh, slack], forge, auth, clock, config, log, scanner, llm: new ApproveLLM(),
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

    // The approve press is stored, but its ack is lost with the connection: Slack sends it again.
    const approve = press(ts, "sf_cmd:approve", "/approve");
    f.socket.loseAcks = true;
    f.socket.push(approve);
    await waitFor(async () => (await f.store.listInboxAfter("slack_thread", 0, 50)).some((r) => r.dedupe_key.startsWith("action:")), "stored");
    f.socket.loseAcks = false;
    f.socket.drop();
    await untilAdvancing(f, () => f.socket.acks.includes(String(approve.envelope_id)), "redelivered and acked");
    // Slack retries the original mention too, with the same event id.
    const again = eventEnvelope(mention(ts, "please add a scope gate"), String((await f.store.listInboxAfter("slack_thread", 0, 1))[0]!.dedupe_key.slice("event:".length)));
    await deliver(f, again);
    await f.controller.tickIntake();

    expect(await f.store.listWorkItems(10)).toHaveLength(1);
    expect((await f.store.listInboxAfter("slack_thread", 0, 50)).map((r) => r.dedupe_key.split(":")[0])).toEqual(["event", "action"]);
    const after = await f.store.listStateChanges(item.id);
    expect(after.length).toBe(changes + 1);
    expect(after.at(-1)!.reason).not.toBe("intake");
    expect(f.socket.connections).toBeGreaterThanOrEqual(2);
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
    const refusals = f.api.thread(ts).filter((m) => m.text?.includes("was not applied"));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]!.text).toContain("not linked to a factory user");
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

  it("every press and typed command asks AuthProvider.authorize first; a deny changes nothing", async () => {
    const f = await setup();
    const ts = "1800000013.000100";
    const item = await specPending(f, ts);
    const before = await f.store.getWorkItem(item.id);
    f.auth.calls = [];
    f.auth.denyAll = true;
    await deliver(f, press(ts, "sf_cmd:approve", "/approve"));
    await deliver(f, eventEnvelope(mention("1800000013.000200", "/approve", { thread_ts: ts })));
    await deliver(f, press(ts, "sf_cmd:approve", "/approve", "U0BOB"));
    expect(f.auth.calls).toEqual([
      { user_id: "github:1", action: "approve_spec" },
      { user_id: "github:1", action: "approve_spec" },
      { user_id: "github:2", action: "approve_spec" },
    ]);
    expect(await f.store.getWorkItem(item.id)).toEqual(before);
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

  it("posts a marker at most once, looking in the thread first", async () => {
    const f = await setup();
    const source = { type: "slack_thread" as const, id: sourceId("1800000016.000100"), link: "" };
    const a = await f.slack.postComment(source, "hello", "<!-- m1 -->");
    const b = await f.slack.postComment(source, "hello again", "<!-- m1 -->");
    expect(a).toEqual(b);
    expect(f.api.calls).toHaveLength(1);
    expect(JSON.stringify(f.api.messages)).not.toContain("m1");
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
