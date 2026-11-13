import { OwnerAuth } from "../src/core/authorize.js";
// Top-level Slack mentions (design 05-sources and 04-gate-commands, "a mention creates an item only on a press"): a
// mention from an account that may approve is classified by one model call and answered in its own thread; it never
// becomes an item by itself. A chat message gets one answer; a request, an unsure or unread message gets a short
// reply with a "Make this a task" button whose press takes the message in as the presser. End to end on a fake
// Slack, through the real listener and inbox.

import { afterEach, describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import { TOP_LEVEL_FACT } from "../src/core/interpret.js";
import { taskOfferMarker } from "../src/interfaces/source-adapter.js";
import type { UserId } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ACTION_MAKE_TASK, SLACK_VALUE_MAX, renderComment } from "../src/impl/source/slack-format.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeForge, FakeSource, config, recordingLog, waitFor } from "./helpers/fakes.js";
import { CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope, mention, press } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";

/** A known secret value: the scanner catches it only as such. */
const SECRET = "fake-secret-value-for-the-chat-leak-test-01";

/**
 * The fake LLM: answers each call with the next scripted answer (the last repeats), throws, stops on its token limit,
 * or answers with output of the wrong shape; records every request.
 */
class ScriptedLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answers: ({ kind: string; text?: string } | "throw" | "max_tokens" | "malformed")[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const a = this.answers[Math.min(this.requests.length - 1, this.answers.length - 1)]!;
    if (a === "throw") throw new Error("model unavailable");
    const usage = { input_tokens: 1, output_tokens: 1, cost_usd: null };
    if (a === "malformed") return { text: "not json", stop_reason: "end", usage };
    // A token-limit stop cuts off an answer that would otherwise be read.
    if (a === "max_tokens") return { text: "", parsed: { kind: "request", entries: [], text: "I can make this a task." }, stop_reason: "max_tokens", usage };
    const parsed = { kind: a.kind, entries: [], text: a.text ?? "" };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage };
  }
}

const running: { ac: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.ac.abort();
    await r.done;
  }
});

/** `llm` null: no model configured. */
async function setup(llm: ScriptedLLM | null) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const slack = new SlackSource({ api, connect: socket.connect, channels: [CHANNEL], scanner, store, auth: new OwnerAuth(store), repo: { owner: "o", name: "r" }, log });
  const gh = new FakeSource();
  // U0ALICE is linked to github:1, the local owner (may approve); U0BOB to github:2, who may only submit work.
  for (const [user, account] of [["github:1", "U0ALICE"], ["github:2", "U0BOB"]] as const) {
    await store.createLinkCode(user as UserId, `code-${account}`);
    await store.redeemLinkCode(`code-${account}`, { provider: "slack", subject: account });
  }
  await store.claimLocalOwner("github:1" as UserId);
  const controller = new ControllerRole({
    store, sources: [gh, slack], forge: new FakeForge(gh), auth: new OwnerAuth(store), clock, config, log, scanner, ...(llm ? { llm } : {}),
  });
  const ac = new AbortController();
  const listener = new Listener({ store, source: slack, clock, config, log, owner: "replica-a" });
  running.push({ ac, done: listener.run(ac.signal) });
  return { store, api, socket, controller, llm: llm ?? new ScriptedLLM([]) };
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
const SOURCE_ID = slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS });
const UNREAD = "I couldn't read that. Make it a task?";
const FLAGGED = "I can't use that message: it looks like it holds a secret. Remove it and mention me again.";

/** Exactly one reply in the thread, no item and no status: its text, and its buttons. */
async function onlyReply(f: F): Promise<{ text: string; buttons: string[] }> {
  expect(await items(f)).toEqual([]);
  const thread = f.api.thread(TS);
  expect(thread).toHaveLength(1);
  return { text: thread[0]!.text ?? "", buttons: FakeSlackApi.buttons(thread[0]!) };
}

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

  it("a request creates no item: one reply, the model's sentences then the Make this a task button", async () => {
    const said = "I can make this a task: send a Slack message when a task finishes or needs you.";
    const f = await setup(new ScriptedLLM([{ kind: "request", text: said }]));
    await deliver(f, eventEnvelope(mention(TS, "report when tasks finish or need my decision")));
    expect(f.llm.requests).toHaveLength(1);
    const reply = await onlyReply(f);
    expect(reply.text.startsWith(said)).toBe(true);
    expect(reply.text).not.toContain("factory:make-task");
    expect(reply.buttons).toEqual([ACTION_MAKE_TASK]);
    expect(f.api.thread(TS)[0]!.blocks).toContainEqual({
      type: "actions", elements: [expect.objectContaining({ action_id: ACTION_MAKE_TASK, value: "report when tasks finish or need my decision" })],
    });
  });

  it("a press of Make this a task creates exactly one item and one 'Task created' line; a second press changes nothing", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "request", text: "I can make this a task: a Today view." }]));
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks")));
    await deliver(f, press(TS, ACTION_MAKE_TASK, "build a Today view for tasks"));
    const all = await items(f);
    expect(all).toHaveLength(1);
    expect(all[0]!.source.id).toBe(SOURCE_ID);
    expect(all[0]!.title).toBe("build a Today view for tasks");
    expect(all[0]!.requester_id).toBe("github:1");
    const created = replies(f).filter((m) => (m.text ?? "").startsWith("Task created:"));
    expect(created.map((m) => m.text)).toEqual(["Task created: build a Today view for tasks"]);
    expect(FakeSlackApi.buttons(created[0]!)).toEqual([]);
    const posted = f.api.calls.length;

    await deliver(f, press(TS, ACTION_MAKE_TASK, "build a Today view for tasks", "U0ALICE", "1800000999.000001"));
    expect(await items(f)).toHaveLength(1);
    expect((await items(f))[0]!.version).toBe(all[0]!.version);
    expect(f.api.calls).toHaveLength(posted);
    // Only the mention was read by the model, never a press.
    expect(f.llm.requests).toHaveLength(1);
  });

  const unread: [string, ConstructorParameters<typeof ScriptedLLM>[0][number]][] = [
    ["a failed model call", "throw"],
    ["a stop reason that is not end", "max_tokens"],
    ["malformed output", "malformed"],
    ["a request with empty text", { kind: "request", text: "" }],
  ];
  for (const [what, a] of unread) {
    it(`${what} is none: the unread line with the button, and no item`, async () => {
      const f = await setup(new ScriptedLLM([a]));
      await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks")));
      expect(f.llm.requests).toHaveLength(1);
      const reply = await onlyReply(f);
      expect(reply.text.startsWith(UNREAD)).toBe(true);
      expect(reply.buttons).toEqual([ACTION_MAKE_TASK]);
    });
  }

  it("with no model configured: the unread line with the button, whose value is the message, and no item", async () => {
    const f = await setup(null);
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks")));
    const reply = await onlyReply(f);
    expect(reply.text.startsWith(UNREAD)).toBe(true);
    expect(reply.buttons).toEqual([ACTION_MAKE_TASK]);
    expect(f.api.thread(TS)[0]!.blocks).toContainEqual({
      type: "actions", elements: [expect.objectContaining({ action_id: ACTION_MAKE_TASK, value: "build a Today view for tasks" })],
    });
  });

  it("a message over 1000 characters: no model call, the unread line with the button, and no item", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "never asked" }]));
    await deliver(f, eventEnvelope(mention(TS, `build ${"x".repeat(1000)}`)));
    expect(f.llm.requests).toHaveLength(0);
    const reply = await onlyReply(f);
    expect(reply.text.startsWith(UNREAD)).toBe(true);
    expect(reply.buttons).toEqual([ACTION_MAKE_TASK]);
  });

  it("an empty mention gets 'I couldn't read that.' with no button, and no item", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "never asked" }]));
    await deliver(f, eventEnvelope(mention(TS, "")));
    expect(f.llm.requests).toHaveLength(0);
    expect(await onlyReply(f)).toEqual({ text: "I couldn't read that.", buttons: [] });
  });

  it("a message the egress scan flags gets the one fixed line: no model call, no button, no item, nothing quoted", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "request", text: "never asked" }]));
    await deliver(f, eventEnvelope(mention(TS, `log in with ${SECRET} and build it`)));
    expect(f.llm.requests).toHaveLength(0);
    expect(await onlyReply(f)).toEqual({ text: FLAGGED, buttons: [] });
    expect(JSON.stringify(f.api.messages)).not.toContain(SECRET);
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
    expect(replies(f).map((m) => m.text?.split("\n")[0])).toEqual(["I can't tell whether you want this built.", "Task created: the tasks list feels slow"]);
  });

  it("a mention from an account without approve_spec makes no model call: the unread line with the button, and no item", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "chat", text: "never asked" }]));
    await deliver(f, eventEnvelope(mention(TS, "can you receive natural inputs?", { user: "U0BOB" })));
    expect(f.llm.requests).toHaveLength(0);
    const reply = await onlyReply(f);
    expect(reply.text.startsWith(UNREAD)).toBe(true);
    expect(reply.buttons).toEqual([ACTION_MAKE_TASK]);
  });

  it("a redelivered request posts no second reply and creates no item", async () => {
    const f = await setup(new ScriptedLLM([{ kind: "request", text: "I can make this a task: a Today view." }]));
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks"), "Ev0REQ0001"));
    await deliver(f, eventEnvelope(mention(TS, "build a Today view for tasks"), "Ev0REQ0002"));
    expect(f.api.calls.filter((c) => c.method === "postMessage")).toHaveLength(1);
    expect(await f.store.getPostedComment(SOURCE_ID, `<!-- factory:chat-answer:${SOURCE_ID} -->`, "")).toMatchObject({ comment_id: f.api.thread(TS)[0]!.ts });
    expect(await items(f)).toEqual([]);
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

  for (const kind of ["chat", "unsure", "request"] as const) {
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
