// Top-level Slack mentions read before intake (design 05-sources and 04-gate-commands, the chat answer): a mention
// from an account that may approve is classified by one model call. A chat message gets one answer in its own
// thread and no item; a request is taken in as before; an unsure one gets an answer with a "Make this a task" button
// whose press takes the message in as the presser. End to end on a fake Slack, through the real listener and inbox.

import { afterEach, describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import { TOP_LEVEL_FACT, taskOfferMarker } from "../src/core/interpret.js";
import type { UserId } from "../src/core/types.js";
import type { AuthAction, AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ACTION_MAKE_TASK, SLACK_VALUE_MAX, renderComment } from "../src/impl/source/slack-format.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeForge, FakeSource, config, recordingLog, waitFor } from "./helpers/fakes.js";
import { CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope, mention, press } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";

/** A known secret value: the scanner catches it only as such. */
const SECRET = "fake-secret-value-for-the-chat-leak-test-01";

/** The forge's auth plugin; Slack accounts are judged by the local auth plugin over the store's links and users. */
class TestAuth implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return { user_id: `github:${identity.subject}` as UserId, attributes: {} };
  }
  async authorize(_p: Principal, action: AuthAction): Promise<AuthDecision> {
    return action === "submit_work" ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

/** The fake LLM: answers each call with the next scripted answer (the last repeats), or throws; records every request. */
class ScriptedLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answers: ({ kind: string; text?: string } | "throw")[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const a = this.answers[Math.min(this.requests.length - 1, this.answers.length - 1)]!;
    if (a === "throw") throw new Error("model unavailable");
    const parsed = { kind: a.kind, entries: [], text: a.text ?? "" };
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

async function setup(llm: ScriptedLLM) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const slack = new SlackSource({ api, connect: socket.connect, channels: [CHANNEL], scanner, store, auth: new LocalAuthProvider(store), repo: { owner: "o", name: "r" }, log });
  const gh = new FakeSource();
  // U0ALICE is linked to github:1, the local owner (may approve); U0BOB to github:2, who may only submit work.
  for (const [user, account] of [["github:1", "U0ALICE"], ["github:2", "U0BOB"]] as const) {
    await store.createLinkCode(user as UserId, `code-${account}`);
    await store.redeemLinkCode(`code-${account}`, { provider: "slack", subject: account });
  }
  await store.claimLocalOwner("github:1" as UserId);
  const controller = new ControllerRole({
    store, sources: [gh, slack], forge: new FakeForge(gh), auth: new TestAuth(), local_auth: new LocalAuthProvider(store), clock, config, log, scanner, llm,
  });
  const ac = new AbortController();
  const listener = new Listener({ store, source: slack, clock, config, log, owner: "replica-a" });
  running.push({ ac, done: listener.run(ac.signal) });
  return { store, api, socket, controller, llm };
}

type F = Awaited<ReturnType<typeof setup>>;

/** Pushes envelopes, waits until each is acked, then lets the controller read the inbox and deliver. */
async function deliver(f: F, ...envelopes: Record<string, unknown>[]): Promise<void> {
  for (const e of envelopes) f.socket.push(e);
  const ids = envelopes.map((e) => String(e.envelope_id));
  await waitFor(() => ids.every((id) => f.socket.acks.includes(id)), "acks");
  await f.controller.tickIntake();
}

const TS = "1800000001.000100";
const items = (f: F) => f.store.listWorkItems(10);
/** The factory's messages in the message's own thread, status messages left out. */
const replies = (f: F, ts = TS) => f.api.thread(ts).filter((m) => !(m.text ?? "").startsWith("Status:"));

describe("chat intake: top-level Slack mentions", () => {
  it("'can you receive natural inputs?' from a linked owner creates no item and gets exactly one chat reply in its own thread", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "Yes: mention me and say what you need in plain words." }]));
    await deliver(f, eventEnvelope(mention(TS, "can you receive natural inputs?")));
    expect(f.llm.requests).toHaveLength(1);
    expect(f.llm.requests[0]!.messages[0]!.content).toContain(TOP_LEVEL_FACT);
    expect(await items(f)).toEqual([]);
    const thread = f.api.thread(TS);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.text).toContain("Yes: mention me and say what you need in plain words.");
    expect(FakeSlackApi.buttons(thread[0]!)).toEqual([]);
  });

  it("'build a Today view for tasks' creates a work item as today and posts no chat reply", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "request" }]));
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks")));
    const all = await items(f);
    expect(all).toHaveLength(1);
    expect(all[0]!.source.id).toBe(slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS }));
    expect(all[0]!.title).toBe("build a Today view for tasks");
    expect(all[0]!.requester_id).toBe("github:1");
    expect(f.api.thread(TS).map((m) => m.text)).toEqual(["Status: *triaging*"]);
  });

  it("unsure: one reply with a 'Make this a task' button and no item until it is pressed; a second press creates none", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "unsure", text: "I can't tell whether you want this built." }]));
    await deliver(f, eventEnvelope(mention(TS, "the tasks list feels slow")));
    expect(await items(f)).toEqual([]);
    const [reply, ...rest] = replies(f);
    expect(rest).toEqual([]);
    expect(reply!.text).toContain("I can't tell whether you want this built.");
    expect(FakeSlackApi.buttons(reply!)).toEqual([ACTION_MAKE_TASK]);

    await deliver(f, press(TS, ACTION_MAKE_TASK, "the tasks list feels slow", "U0BOB"));
    const all = await items(f);
    expect(all).toHaveLength(1);
    expect(all[0]!.source.id).toBe(slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS }));
    expect(all[0]!.title).toBe("the tasks list feels slow");
    expect(all[0]!.requester_id).toBe("github:2");

    await deliver(f, press(TS, ACTION_MAKE_TASK, "the tasks list feels slow", "U0ALICE"));
    expect(await items(f)).toHaveLength(1);
    expect((await items(f))[0]!.version).toBe(all[0]!.version);
    // The press makes no model call: only the mention was read.
    expect(f.llm.requests).toHaveLength(1);
    expect(replies(f)).toHaveLength(1);
  });

  it("a request from an account without approve_spec makes no model call and creates the item as today", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "never asked" }]));
    await deliver(f, eventEnvelope(mention(TS, "can you receive natural inputs?", { user: "U0BOB" })));
    expect(f.llm.requests).toHaveLength(0);
    expect(await items(f)).toHaveLength(1);
    expect(replies(f)).toEqual([]);
  });

  it("a request whose model call fails still creates the work item", async () => {
    const f = await setup(new ScriptedLLM(["throw"]));
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks")));
    expect(f.llm.requests).toHaveLength(1);
    expect(await items(f)).toHaveLength(1);
    expect(replies(f)).toEqual([]);
  });

  it("a redelivered message posts no second reply: the reply is keyed on the message id", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "Yes, I read plain words." }]));
    await deliver(f, eventEnvelope(mention(TS, "can you receive natural inputs?"), "Ev0FIRST01"));
    await deliver(f, eventEnvelope(mention(TS, "can you receive natural inputs?"), "Ev0AGAIN01"));
    // The second delivery reached the controller (a second read), and still posted nothing more.
    expect(f.llm.requests).toHaveLength(2);
    expect(f.api.thread(TS)).toHaveLength(1);
    expect(f.api.calls.filter((c) => c.method === "postMessage")).toHaveLength(1);
    expect(await f.store.getPostedComment(slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS }), `<!-- factory:chat-answer:${slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS })} -->`, ""))
      .toMatchObject({ comment_id: f.api.thread(TS)[0]!.ts });
    expect(await items(f)).toEqual([]);
  });

  for (const kind of ["chat", "unsure"] as const) {
    it(`a ${kind} answer the egress scan flags posts nothing and stores nothing`, async () => {
      const f = await setup(new ScriptedLLM([{ kind, text: `Use ${SECRET} to log in.` }]));
      await deliver(f, eventEnvelope(mention(TS, "how do I log in?")));
      expect(f.llm.requests).toHaveLength(1);
      expect(f.api.calls).toEqual([]);
      expect(await items(f)).toEqual([]);
      const id = slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS });
      expect(await f.store.getPostedComment(id, `<!-- factory:chat-answer:${id} -->`, "")).toBeNull();
    });
  }
});

describe("chat intake: the Make this a task button", () => {
  it("its value is the message; a message over Slack's value limit gets no button and a reply saying why", () => {
    const short = renderComment(`I can't tell.\n${taskOfferMarker("make it faster")}`, { owner: "o", name: "r" }, "U0BOT");
    const actions = short.blocks.find((b) => (b as { type: string }).type === "actions") as { elements: { action_id: string; value: string }[] };
    expect(actions.elements).toEqual([expect.objectContaining({ action_id: ACTION_MAKE_TASK, value: "make it faster" })]);
    expect(short.text).not.toContain("factory:make-task");

    const long = renderComment(`I can't tell.\n${taskOfferMarker("x".repeat(SLACK_VALUE_MAX + 1))}`, { owner: "o", name: "r" }, "U0BOT");
    expect(long.blocks.some((b) => (b as { type: string }).type === "actions")).toBe(false);
    expect(long.text).toContain("too long for a *Make this a task* button");
  });
});
