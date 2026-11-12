// Good, Bad and Feedback buttons on the factory's result messages in Slack (design 04-gate-commands, one-tap
// verdicts): which messages get them, what a tap and the Feedback modal store, the record_verdict check, one verdict
// per message, the message edit, and the ack after the store write. The Slack and store fakes only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buttonVerdict, buttonVerdictKey, verdictButtonOf } from "../src/core/verdict.js";
import type { SourceRef, UserId, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { resultMarker } from "../src/impl/source/slack-format.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import { recordingLog } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSlackApi, FakeSocket, TEAM } from "./helpers/slack.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

const OWNER = "github:1" as UserId;
const LEAK = "fake-secret-for-the-feedback-leak-test-0001";
const ROOT = "1800000001.000100";
const RUN = "run_spec1";
const SPEC_MARKER = `<!-- factory:spec:${RUN} -->`;
const SPEC_BODY = "## Factory spec\n\nThe spec.\n\nCommands you can reply with now:\n- `/approve [notes]`: Approve.\n- `/help`: Help.";

/** U0ALICE is linked to the owner (may record verdicts); U0MALLORY to a user without record_verdict; others unlinked. */
class ButtonAuth implements AuthProvider {
  async resolve(id: ExternalIdentity): Promise<Principal | null> {
    const user = ({ "slack:U0ALICE": OWNER, "slack:U0MALLORY": "github:666" } as Record<string, string>)[`${id.provider}:${id.subject}`];
    return user ? { user_id: user as UserId, attributes: {} } : null;
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    return action === "submit_work" || p.user_id === OWNER ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

const source = (): SourceRef => ({ type: "slack_thread", id: slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: ROOT }), link: "https://slack.com/x" });

async function setup() {
  const clock = new FakeClock("2027-01-15T08:00:00Z");
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => [LEAK]);
  const src = new SlackSource({ api, connect: socket.connect, channels: [CHANNEL], scanner, store, auth: new ButtonAuth(), repo: { owner: "o", name: "r" }, log });
  const { item: created } = await store.createWorkItem({ source: source(), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
  // At the spec gate: Approve still applies.
  const gate = await store.transition({
    id: created.id, expected_version: created.version, actor: system, reason: "triaged", patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
  });
  if (!gate.ok) throw new Error(gate.reason);
  const item = gate.item;
  // The spec as the controller writes it: its thread entry, then outbound posts it.
  await store.recordItemMessage({ work_item_id: item.id, marker: SPEC_MARKER, body: SPEC_BODY });
  await src.postComment(source(), SPEC_BODY, SPEC_MARKER);
  const spec = api.thread(ROOT).at(-1)!;
  const key = buttonVerdictKey(CHANNEL, spec.ts, RUN);
  const me = { team_id: TEAM, user_id: BOT };
  const deliver = (env: Record<string, unknown>) => src.toEvent(env, me);
  return { clock, store, api, socket, log, src, item, spec, key, deliver };
}

let seq = 0;
/** A press of a verdict button on message `ts`. */
function tap(ts: string, button: string, user = "U0ALICE", action_ts = `${1800000300 + ++seq}.000001`): Record<string, unknown> {
  return {
    type: "interactive",
    envelope_id: `env-tap-${++seq}`,
    payload: {
      type: "block_actions", trigger_id: `trigger-${seq}`,
      user: { id: user, team_id: TEAM }, team: { id: TEAM }, channel: { id: CHANNEL },
      container: { type: "message", channel_id: CHANNEL, thread_ts: ROOT, message_ts: ts },
      message: { ts, thread_ts: ROOT },
      actions: [{ action_id: `sf_verdict:${button}`, value: button, action_ts, type: "button" }],
    },
  };
}

/** The Feedback modal's submit. */
function submit(ts: string, text: string, user = "U0ALICE", view_id = `V0VIEW${++seq}`): Record<string, unknown> {
  return {
    type: "interactive",
    envelope_id: `env-submit-${++seq}`,
    payload: {
      type: "view_submission",
      user: { id: user, team_id: TEAM }, team: { id: TEAM },
      view: {
        id: view_id, callback_id: "sf_feedback", private_metadata: JSON.stringify({ channel: CHANNEL, ts }),
        state: { values: { feedback: { feedback: { type: "plain_text_input", value: text } } } },
      },
    },
  };
}

type F = Awaited<ReturnType<typeof setup>>;
const rows = async (f: F) => (await f.store.listVerdicts(f.item.id)).map((v) => [v.comment_id, v.verdict, v.severity, v.reason]);
const actorOf = async (f: F, item: WorkItem) => {
  const [v] = await f.store.listVerdicts(item.id);
  return (await f.store.listStateChanges(item.id)).find((c) => c.id === v!.state_change_id)!.actor;
};

describe("one-tap verdicts: the mapping (src/core/verdict.ts)", () => {
  it("Good is accept/none, Bad changes/minor with no reason, Feedback changes/none with the text", () => {
    expect(buttonVerdict("good")).toEqual({ verdict: "accept", severity: "none", reason: null });
    expect(buttonVerdict("bad")).toEqual({ verdict: "changes", severity: "minor", reason: null });
    expect(buttonVerdict("feedback", "rename it")).toEqual({ verdict: "changes", severity: "none", reason: "rename it" });
    for (const b of ["good", "bad", "feedback"] as const) expect(verdictButtonOf(buttonVerdict(b, "x"))).toBe(b);
    expect(buttonVerdictKey("C1", "1.2", "run_1")).toBe("button:C1:1.2:run_1");
    expect(buttonVerdictKey("C1", "1.2", null)).toBe("button:C1:1.2");
  });

  it("only spec, finished-run (ready to merge) and merge messages are result messages", () => {
    expect(resultMarker("<!-- factory:spec:run_1 -->")).toEqual({ run: "run_1" });
    expect(resultMarker("<!-- factory:merge:run_2 -->")).toEqual({ run: "run_2" });
    expect(resultMarker("<!-- factory:pr-merged:abc -->")).toEqual({ run: null });
    expect(resultMarker("<!-- factory:local-merged:7 -->")).toEqual({ run: null });
    for (const m of ["slack:status", "<!-- factory:refused:1.2 -->", "<!-- factory:run-failed:run_3 -->", "<!-- factory:chat:x -->", "<!-- factory:stale:x -->", "<!-- factory:help:1 -->"]) {
      expect(resultMarker(m)).toBeNull();
    }
  });
});

describe("one-tap verdicts in Slack", () => {
  it("a result message ends with Good, Bad and Feedback after its command buttons; another factory message gets none", async () => {
    const f = await setup();
    expect(FakeSlackApi.buttons(f.spec)).toEqual(["sf_spec_approve", "sf_spec_reject", "sf_verdict:good", "sf_verdict:bad", "sf_verdict:feedback"]);
    await f.src.postComment(source(), "Merged PR #4 as `abc`. The item is closed.", "<!-- factory:pr-merged:4 -->");
    expect(FakeSlackApi.buttons(f.api.thread(ROOT).at(-1)!)).toEqual(["sf_verdict:good", "sf_verdict:bad", "sf_verdict:feedback"]);
    await f.src.postComment(source(), "`/approve` was not applied: no.", "<!-- factory:refused:1.5 -->");
    expect(FakeSlackApi.buttons(f.api.thread(ROOT).at(-1)!)).toEqual([]);
  });

  it("Good stores accept/none on the message with the linked user ID as actor, then edits the message to show it", async () => {
    const f = await setup();
    expect(await f.deliver(tap(f.spec.ts, "good"))).toBeNull();
    expect(await rows(f)).toEqual([[f.key, "accept", "none", null]]);
    expect(await actorOf(f, f.item)).toEqual({ kind: "user", id: OWNER });
    const edited = f.api.messages.find((m) => m.ts === f.spec.ts)!;
    expect(FakeSlackApi.buttons(edited)).toEqual(["sf_spec_approve", "sf_spec_reject", "sf_verdict:bad", "sf_verdict:feedback"]);
    expect(JSON.stringify(edited.blocks)).toContain(`Verdict: Good by ${OWNER} at`);
    expect(JSON.stringify(edited.blocks)).not.toContain("U0ALICE");
  });

  it("a second tap updates the message's one verdict row and adds no row; the same tap again changes nothing and makes no Slack call", async () => {
    const f = await setup();
    await f.deliver(tap(f.spec.ts, "good"));
    const [first] = await f.store.listVerdicts(f.item.id);
    await f.deliver(tap(f.spec.ts, "bad"));
    const after = await f.store.listVerdicts(f.item.id);
    expect(after.map((v) => [v.id, v.comment_id, v.verdict, v.severity, v.reason])).toEqual([[first!.id, f.key, "changes", "minor", null]]);
    expect(FakeSlackApi.buttons(f.api.messages.find((m) => m.ts === f.spec.ts)!)).toEqual(["sf_spec_approve", "sf_spec_reject", "sf_verdict:good", "sf_verdict:feedback"]);
    const version = (await f.store.getWorkItem(f.item.id))!.version;
    const calls = f.api.calls.length;
    await f.deliver(tap(f.spec.ts, "bad"));
    expect(await f.store.listVerdicts(f.item.id)).toEqual(after);
    expect((await f.store.getWorkItem(f.item.id))!.version).toBe(version);
    expect(f.api.calls).toHaveLength(calls);
  });

  it("a repeated delivery of the same press stores one verdict", async () => {
    const f = await setup();
    const env = tap(f.spec.ts, "good");
    await f.deliver(env);
    await f.deliver(env);
    expect(await rows(f)).toEqual([[f.key, "accept", "none", null]]);
    expect(f.api.calls.filter((c) => c.method === "updateMessage")).toHaveLength(1);
  });

  it("Feedback opens a modal and stores nothing; its submit stores changes/none with the text as the reason", async () => {
    const f = await setup();
    await f.deliver(tap(f.spec.ts, "feedback"));
    expect(f.api.views).toHaveLength(1);
    expect(f.api.views[0]!.view).toMatchObject({ type: "modal", callback_id: "sf_feedback", private_metadata: JSON.stringify({ channel: CHANNEL, ts: f.spec.ts }) });
    expect(await f.store.listVerdicts(f.item.id)).toEqual([]);
    await f.deliver(submit(f.spec.ts, "  The flag name is wrong.  "));
    expect(await rows(f)).toEqual([[f.key, "changes", "none", "The flag name is wrong."]]);
    const edited = f.api.messages.find((m) => m.ts === f.spec.ts)!;
    expect(FakeSlackApi.buttons(edited)).toEqual(["sf_spec_approve", "sf_spec_reject", "sf_verdict:good", "sf_verdict:bad"]);
    expect(JSON.stringify(edited.blocks)).not.toContain("flag name");
  });

  it("the modal submit is acked only after the store write", async () => {
    const f = await setup();
    const env = submit(f.spec.ts, "Tests are thin.");
    const order: string[] = [];
    const record = f.store.recordVerdict.bind(f.store);
    f.store.recordVerdict = async (input) => {
      order.push(f.socket.acks.includes(String(env.envelope_id)) ? "acked before store" : "store");
      return record(input);
    };
    const abort = new AbortController();
    const run = (async () => { for await (const _ of f.src.subscribe(abort.signal)) { /* no event: acked inside */ } })();
    f.socket.push(env);
    for (let i = 0; i < 50 && !f.socket.acks.includes(String(env.envelope_id)); i++) await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    f.socket.drop();
    await run;
    expect(order).toEqual(["store"]);
    expect(f.socket.acks).toContain(String(env.envelope_id));
    expect(await rows(f)).toEqual([[f.key, "changes", "none", "Tests are thin."]]);
  });

  it("Feedback text with a leak finding stores nothing and gets one notice in the thread, without the text", async () => {
    const f = await setup();
    const env = submit(f.spec.ts, `here: ${LEAK}`, "U0ALICE", "V0LEAK");
    const posts = f.api.calls.filter((c) => c.method === "postMessage").length;
    await f.deliver(env);
    await f.deliver(env);
    expect(await f.store.listVerdicts(f.item.id)).toEqual([]);
    const notices = f.api.calls.filter((c) => c.method === "postMessage").slice(posts);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Your feedback was not stored");
    expect(JSON.stringify(f.api.messages)).not.toContain(LEAK);
  });

  it.each([
    ["an unlinked account", "U0STRANGER"],
    ["a linked user without record_verdict", "U0MALLORY"],
  ])("a tap or submit from %s stores nothing and gets no reply", async (_name, user) => {
    const f = await setup();
    const calls = f.api.calls.length;
    for (const b of ["good", "bad", "feedback"]) expect(await f.deliver(tap(f.spec.ts, b, user))).toBeNull();
    expect(await f.deliver(submit(f.spec.ts, "no", user))).toBeNull();
    expect(await f.store.listVerdicts(f.item.id)).toEqual([]);
    expect(f.api.calls).toHaveLength(calls);
    expect(f.api.views).toEqual([]);
  });

  it("a tap on a message that is not a result message, or not the factory's, stores nothing", async () => {
    const f = await setup();
    await f.src.postComment(source(), "`/approve` was not applied: no.", "<!-- factory:refused:1.5 -->");
    const refused = f.api.thread(ROOT).at(-1)!;
    await f.deliver(tap(refused.ts, "good"));
    await f.deliver(tap("1800000999.000100", "good"));
    expect(await f.store.listVerdicts(f.item.id)).toEqual([]);
  });

  it("Bad and Feedback verdicts are read by listVerdictsSince, the verdict signal's read", async () => {
    const f = await setup();
    await f.deliver(tap(f.spec.ts, "bad"));
    expect((await f.store.listVerdictsSince(null)).map((v) => [v.comment_id, v.verdict, v.severity])).toEqual([[f.key, "changes", "minor"]]);
    await f.deliver(submit(f.spec.ts, "More tests."));
    expect((await f.store.listVerdictsSince(null)).map((v) => [v.comment_id, v.verdict, v.severity, v.reason])).toEqual([[f.key, "changes", "none", "More tests."]]);
  });

  it("a state change after a verdict keeps the verdict line and buttons on a result message; the spec message is not edited by it", async () => {
    const f = await setup();
    // A finished run's ready-to-merge message with the spec gate's command footer, as the controller writes it.
    const marker = "<!-- factory:merge:run_r2 -->";
    const body = "Ready to merge.\n\nCommands you can reply with now:\n- `/approve [notes]`: Approve.\n- `/help`: Help.";
    await f.store.recordItemMessage({ work_item_id: f.item.id, marker, body });
    await f.src.postComment(source(), body, marker);
    const result = f.api.thread(ROOT).at(-1)!;
    await f.deliver(tap(result.ts, "good"));
    const it = (await f.store.getWorkItem(f.item.id))!;
    const r = await f.store.transition({ id: it.id, expected_version: it.version, actor: system, reason: "spec_approved", patch: { stage: "RUNNING" } });
    if (!r.ok) throw new Error(r.reason);
    const specBefore = JSON.stringify(f.api.messages.find((m) => m.ts === f.spec.ts)!.blocks);
    await f.src.setStatus(source(), "implementing", null);
    const edited = f.api.messages.find((m) => m.ts === result.ts)!;
    expect(FakeSlackApi.buttons(edited)).toEqual(["sf_cmd:help", "sf_verdict:bad", "sf_verdict:feedback"]);
    const text = JSON.stringify(edited.blocks);
    expect(text).toContain(`Verdict: Good by ${OWNER}`);
    expect(text).toContain("Done: spec approved by");
    expect(JSON.stringify(f.api.messages.find((m) => m.ts === f.spec.ts)!.blocks)).toBe(specBefore);
  });
});

describe("one-tap verdicts: no schema change", () => {
  const SQLITE = readFileSync("src/impl/store/sqlite/schema.ts", "utf8");

  it("the schema has nothing of its own for buttons: the verdict table and its comment-id key serve", () => {
    expect(SQLITE.toLowerCase()).not.toContain("button");
    // The key a tap is stored under is the verdict table's unique comment id.
    expect(SQLITE).toMatch(/CREATE TABLE verdicts \([^;]*?comment_id\s+TEXT NOT NULL UNIQUE/);
  });
});
