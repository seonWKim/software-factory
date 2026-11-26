// A top-level Slack mention the model reads as one work request becomes its item at once (design 04-chat-commands,
// 05-slack-intake): the same create a press of "Make this a task" makes, one reply naming the item by ID and title,
// keyed on the message's source id. End to end on a fake Slack and a fake LLM, through the real listener and inbox.

import { afterEach, describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import type { UserId } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ACTION_MAKE_TASK } from "../src/impl/source/slack-format.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { config, recordingLog, waitFor } from "./helpers/fakes/config.js";
import { CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope, mention, press } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";
import { classifierAnswer } from "./helpers/classifier.js";

const SECRET = "fake-secret-value-for-the-work-request-test-01";

/** The fake LLM: the classifier says `command`, the interpreter answers `answer`; records every interpreter request. */
class FakeLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: { kind: string; text: string }) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const label = classifierAnswer(req, "command");
    if (label) return label;
    this.requests.push(req);
    const parsed = { kind: this.answer.kind, entries: [], text: this.answer.text };
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

async function setup(llm: FakeLLM) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const slack = new SlackSource({ api, connect: socket.connect, channels: [CHANNEL], scanner, store, auth: new OwnerAuth(store), repo: { owner: "o", name: "r" }, log });
  const gh = new FakeSource();
  await store.createLinkCode("github:1" as UserId, "code-alice");
  await store.redeemLinkCode("code-alice", { provider: "slack", subject: "U0ALICE" });
  await store.claimOwner("github:1" as UserId);
  const controller = new ControllerRole({ store, sources: [gh, slack], forge: new FakeForge(gh), auth: new OwnerAuth(store), clock, config, log, scanner, llm });
  const ac = new AbortController();
  const listener = new Listener({ store, source: slack, clock, config, log, owner: "replica-a" });
  running.push({ ac, done: listener.run(ac.signal) });
  return { store, api, socket, controller, llm };
}

type F = Awaited<ReturnType<typeof setup>>;

async function deliver(f: F, ...envelopes: Record<string, unknown>[]): Promise<void> {
  for (const e of envelopes) f.socket.push(e);
  const ids = envelopes.map((e) => String(e.envelope_id));
  await waitFor(() => ids.every((id) => f.socket.acks.includes(id)), "acks");
  await f.controller.tickIntake();
}

const TS = "1800000002.000100";
const SOURCE_ID = slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: TS });
const TEXT = "add a Today view that lists the tasks waiting on me";
const REQUEST = { kind: "request", text: "I can make this a task: a Today view of the tasks waiting on you." };
const items = (f: F) => f.store.listWorkItems(10);
/** The factory's replies in the message's thread, status messages left out. */
const replies = (f: F) => f.api.thread(TS).filter((m) => !(m.text ?? "").startsWith("Status:"));

describe("chat work requests: a top-level request becomes its item", () => {
  it("creates one item whose problem holds the message text, with one model call", async () => {
    const f = await setup(new FakeLLM(REQUEST));
    await deliver(f, eventEnvelope(mention(TS, TEXT)));
    const [item, ...more] = await items(f);
    expect(more).toEqual([]);
    expect(item!.source.id).toBe(SOURCE_ID);
    expect(item!.title).toBe(TEXT);
    expect(item!.problem).toContain(TEXT);
    expect(item!.requester_id).toBe("github:1");
    expect(f.llm.requests).toHaveLength(1);
  });

  it("posts one reply naming the item by its ID and title, keyed on the message's source id", async () => {
    const f = await setup(new FakeLLM(REQUEST));
    await deliver(f, eventEnvelope(mention(TS, TEXT)));
    const [item] = await items(f);
    const [reply, ...rest] = replies(f);
    expect(rest).toEqual([]);
    expect(reply!.text).toContain(item!.id);
    expect(reply!.text).toContain(TEXT);
    expect(FakeSlackApi.buttons(reply!)).not.toContain(ACTION_MAKE_TASK);
    expect(await f.store.getPostedComment(SOURCE_ID, `<!-- factory:task-created:${SOURCE_ID} -->`, "")).toMatchObject({ comment_id: reply!.ts });
  });

  it("a redelivered mention creates no second item, posts no second reply and makes no second model call", async () => {
    const f = await setup(new FakeLLM(REQUEST));
    await deliver(f, eventEnvelope(mention(TS, TEXT), "Ev0WRQ0001"));
    const first = await items(f);
    const posted = f.api.calls.length;
    await deliver(f, eventEnvelope(mention(TS, TEXT), "Ev0WRQ0002"));
    expect(await items(f)).toEqual(first);
    expect(f.api.calls).toHaveLength(posted);
    expect(replies(f)).toHaveLength(1);
    expect(f.llm.requests).toHaveLength(1);
  });

  it("a pasted image is not fetched: the item is made from the message text, and the reply names no attachment", async () => {
    const f = await setup(new FakeLLM(REQUEST));
    const file = { id: "F0SHOT", name: "screenshot.png", mimetype: "image/png", url_private: "https://files.fake.test/F0SHOT/screenshot.png" };
    await deliver(f, eventEnvelope(mention(TS, TEXT, { files: [file] })));
    const [item, ...more] = await items(f);
    expect(more).toEqual([]);
    expect(item!.problem).toContain(TEXT);
    expect(item!.problem).not.toContain("screenshot.png");
    expect(item!.resources.join(" ")).not.toContain("files.fake.test");
    const [reply] = replies(f);
    expect(reply!.text).not.toMatch(/attach|image|screenshot|F0SHOT/i);
  });

  it("a press after the request makes no model call and no second item", async () => {
    const f = await setup(new FakeLLM(REQUEST));
    await deliver(f, eventEnvelope(mention(TS, TEXT)));
    const first = await items(f);
    await deliver(f, press(TS, ACTION_MAKE_TASK, TEXT));
    expect(await items(f)).toEqual(first);
    expect(replies(f)).toHaveLength(1);
    expect(f.llm.requests).toHaveLength(1);
  });

  it("a chat answer creates no item and makes one model call; a message the scan flags makes none", async () => {
    const chat = await setup(new FakeLLM({ kind: "chat", text: "Yes, I read plain words." }));
    await deliver(chat, eventEnvelope(mention(TS, "can you read plain words?")));
    expect(await items(chat)).toEqual([]);
    expect(chat.llm.requests).toHaveLength(1);

    const flagged = await setup(new FakeLLM(REQUEST));
    await deliver(flagged, eventEnvelope(mention(TS, `log in with ${SECRET} and build it`)));
    expect(await items(flagged)).toEqual([]);
    expect(flagged.llm.requests).toHaveLength(0);
  });
});
