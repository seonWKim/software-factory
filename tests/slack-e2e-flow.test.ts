// A Slack thread from mention to merged PR, end to end on a fake Slack (issue #109 after RFC 0015): Socket Mode
// envelopes through the real listener and inbox, the real SlackSource, the controller with the real local auth
// provider over store links and a static grant (Slack accounts) and the GitHub one (forge identities), a real Worker running triage, implement and review, outbound's
// slack-thread target posting back into the thread, and the forge for the PR. docs/plugins/source-adapter.md, `slack`.

import { afterEach, describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Listener } from "../src/core/listener.js";
import type { UserId, WorkerId, WorkItem } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { GitHubAuthProvider } from "../src/impl/github/github-auth-provider.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import { FakeBroker, FakeForge, FakeRunner, FakeSandbox, MemoryStorage, alice, config, prompts, recordingLog, triageSpec, waitFor } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope, mention, message } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";

/** The owner: a GitHub account the static grant makes an approver. Slack user U0ALICE links to it with a code. */
const OWNER = "github:1" as UserId;
const LINK_CODE = "slack-e2e-link-code";
/** A value the scanner knows as a secret: it is caught as a known value, whatever its shape. */
const PLANTED = "planted-secret-value-for-the-slack-e2e-0001";

const running: { ac: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.ac.abort();
    await r.done;
  }
});

async function slackFactory() {
  const clock = new FakeClock("2026-11-09T00:00:00Z");
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const log = recordingLog();
  const scanned: string[] = [];
  const inner = new PatternEgressScanner(async () => [PLANTED]);
  const scanner = { scan: (kind: Parameters<typeof inner.scan>[0], text: string) => (scanned.push(text), inner.scan(kind, text)) };
  const slack = new SlackSource({ api, connect: socket.connect, channels: [CHANNEL], scanner, store, repo: { owner: "o", name: "r" }, log });
  const forge = new FakeForge();
  const grant = new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} });
  const auth = new GitHubAuthProvider(store, [grant]);
  // Slack accounts act as the factory user they are linked to, judged by the local auth plugin (design 08-permissions).
  const local_auth = new LocalAuthProvider(store, [grant]);
  const controller = new ControllerRole({ store, sources: [slack], forge, auth, local_auth, clock, config, log, scanner, repeated_failure_rule: false });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "added the scope gate", next_steps: "none" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "the gate is right" } }),
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
    prompts, log, scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const ac = new AbortController();
  const done = new Listener({ store, source: slack, clock, config, log, owner: "replica-a" }).run(ac.signal);
  running.push({ ac, done });

  /** Pushes envelopes, waits until the listener stored (and so acked) each, then runs the factory until it settles. */
  const deliver = async (...envelopes: Record<string, unknown>[]) => {
    for (const e of envelopes) socket.push(e);
    const ids = envelopes.map((e) => String(e.envelope_id));
    await waitFor(() => ids.every((id) => socket.acks.includes(id)), "acks");
    await step();
  };
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  return { clock, store, api, socket, log, scanned, slack, forge, controller, worker, runner, deliver, step };
}

type F = Awaited<ReturnType<typeof slackFactory>>;

const ROOT = "1800000001.000100";
const source = (ts = ROOT) => ({ type: "slack_thread" as const, id: slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: ts }) });
const item = async (f: F, ts = ROOT): Promise<WorkItem> => (await f.store.getWorkItemBySource("slack_thread", source(ts).id))!;
const statusLines = (f: F, ts = ROOT) => f.api.thread(ts).filter((m) => m.text?.startsWith("Status:"));
const texts = (f: F, ts = ROOT) => f.api.thread(ts).map((m) => m.text ?? "");

/** U0ALICE links her Slack account to the owner with a code from `factory link-code github:1`. */
async function linked(f: F): Promise<void> {
  await f.store.createLinkCode(OWNER, LINK_CODE);
  await f.deliver(eventEnvelope(mention("1800000000.000100", `/link ${LINK_CODE}`)));
  expect(await f.store.resolveLink("slack", "U0ALICE")).toBe(OWNER);
  expect(texts(f, "1800000000.000100").some((t) => t.includes("now linked to factory user"))).toBe(true);
}

describe("a Slack thread from mention to merged PR", { timeout: 60_000 }, () => {
  it("mention → triage spec in the thread → /approve reply → implement → review → merge on the forge → done in the thread", async () => {
    const f = await slackFactory();
    await linked(f);

    // Intake: one mention is one item, requested by the linked factory user; its triage runs on the worker.
    await f.deliver(eventEnvelope(mention(ROOT, "please add a scope gate\nIt should run on every push.")));
    const triaged = await item(f);
    expect(triaged).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", requester_id: OWNER, title: "please add a scope gate" });
    expect(f.runner.specs.map((s) => s.role)).toEqual(["triage"]);
    // The spec is in the thread, with buttons for the commands that apply now, and no marker text.
    const spec = f.api.thread(ROOT).find((m) => FakeSlackApi.buttons(m).length > 0)!;
    expect(spec).toBeTruthy();
    expect(FakeSlackApi.buttons(spec)).toEqual(["sf_cmd:approve", "sf_cmd:help"]);
    expect(statusLines(f).map((m) => m.text)).toEqual(["Status: *needs approval*"]);

    // Approve with a mention in the thread, as the spec's hint says (Slack itself takes a message that starts with
    // `/`): implement opens PR 42 on the forge, review passes.
    const approve = eventEnvelope(mention("1800000001.000200", "/approve", { thread_ts: ROOT }));
    await f.deliver(approve);
    const waiting = await item(f);
    expect(waiting).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" });
    expect(f.runner.specs.map((s) => s.role)).toEqual(["triage", "implement", "review"]);
    expect(f.forge.prOpens).toHaveLength(1);
    // The item's status stays in the Slack thread, one message edited in place, linking the PR; the PR's on the forge.
    expect(statusLines(f).map((m) => m.text)).toEqual(["Status: *ready to merge* · <https://github.com/o/r/pull/42|PR #42>"]);
    expect(f.forge.prStatus(42)).toBe("ready_to_merge");
    const approvals = (await f.store.listStateChanges(waiting.id)).filter((c) => c.reason === "spec_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.actor).toEqual({ kind: "user", id: OWNER });

    // Slack redelivers the approve after a reconnect: one inbox row, no second transition.
    f.socket.push({ ...approve });
    await f.step();
    expect((await f.store.listStateChanges(waiting.id)).filter((c) => c.reason === "spec_approved")).toHaveLength(1);

    // A person merges the PR on GitHub: the item closes and the thread says done.
    f.forge.queue.push({ kind: "change_merged", change_ref: "42", head_branch: `factory/${waiting.id}`, merge_sha: "m42", merger: alice });
    await f.step();
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m42" });
    expect(statusLines(f).map((m) => m.text)).toEqual(["Status: *done* · <https://github.com/o/r/pull/42|PR #42>"]);

    const reasons = (await f.store.listStateChanges(waiting.id)).map((c) => c.reason);
    const order = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "pr_merged"];
    const at = order.map((r) => reasons.indexOf(r));
    expect(at.every((i) => i >= 0), `reasons: ${reasons.join(", ")}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    // Every post was scanned first; no marker, no display name, no duplicate message in the thread.
    for (const c of f.api.calls) expect(f.scanned.some((s) => s.includes(c.text))).toBe(true);
    expect(JSON.stringify(f.api.messages)).not.toContain("<!--");
    const posted = f.api.thread(ROOT).map((m) => m.metadata?.event_payload.marker).filter((m) => m !== undefined);
    expect(new Set(posted).size).toBe(posted.length);
    expect(f.api.messages.every((m) => m.user === BOT)).toBe(true);
    expect(f.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("the person who asked sees each step in the thread, in order: status, spec, review verdict, ready for a human merge", async () => {
    const f = await slackFactory();
    await linked(f);
    await f.deliver(eventEnvelope(mention(ROOT, "please add a scope gate")));
    // A reply without a mention starting with a space reaches the factory as a message (Slack keeps it).
    await f.deliver(eventEnvelope(message("1800000001.000200", " /approve", { thread_ts: ROOT })));
    const thread = texts(f);
    expect(thread).toHaveLength(4);
    expect(thread[0]).toBe("Status: *ready to merge* · <https://github.com/o/r/pull/42|PR #42>");
    expect(thread[1]).toMatch(/^\*Factory spec\*/);
    // The spec's folded "What the PR contains" block reads as a heading, not as escaped HTML tags.
    expect(thread[1]).toContain("*What the PR contains*\n\nworkflow + test");
    expect(thread[1]).not.toContain("&lt;details");
    expect(thread[2]).toBe("*Factory review: pass*\n\nthe gate is right\n\nTier recheck: 2");
    expect(thread[3]).toMatch(/^<https:\/\/github\.com\/o\/r\/pull\/42\|PR #42> passed review \(tier 2\) and its checks passed\. A human merge is required\./);
    // The item's own conversation in the store holds the same factory messages, once each, and the reply between them.
    const stored = (await f.store.listItemMessages((await item(f)).id)).map((m) => m.marker.split(":").slice(0, 2).join(":"));
    expect(stored).toEqual(["<!-- factory:spec", "slack:1800000001.000200", "<!-- factory:review", "<!-- factory:merge"]);
  });

  it("a /verdict typed in the thread is recorded as the linked factory user", async () => {
    const f = await slackFactory();
    await linked(f);
    await f.deliver(eventEnvelope(mention(ROOT, "please add a scope gate")));
    await f.deliver(eventEnvelope(mention("1800000001.000200", "/approve", { thread_ts: ROOT })));
    await f.deliver(eventEnvelope(mention("1800000001.000300", "/verdict accept", { thread_ts: ROOT })));
    const verdict = (await f.store.listStateChanges((await item(f)).id)).find((c) => c.reason === "human_verdict");
    expect(verdict?.actor).toEqual({ kind: "user", id: OWNER });
  });

  it("a 👍 on the factory's review message stores accept for the PR head; a 👎 on the spec asks for the severity once", async () => {
    const f = await slackFactory();
    await linked(f);
    await f.deliver(eventEnvelope(mention(ROOT, "please add a scope gate")));
    await f.deliver(eventEnvelope(mention("1800000001.000200", "/approve", { thread_ts: ROOT })));
    const review = f.api.thread(ROOT).find((m) => m.text?.startsWith("*Factory review"))!;
    const spec = f.api.thread(ROOT).find((m) => m.text?.startsWith("*Factory spec"))!;
    const reacted = (ts: string, emoji: string) =>
      eventEnvelope({ type: "reaction_added", user: "U0ALICE", reaction: emoji, item: { type: "message", channel: CHANNEL, ts }, item_user: BOT, event_ts: "1800000900.000100" });
    const before = f.api.thread(ROOT).length;
    await f.deliver(reacted(review.ts, "+1"));
    const it0 = await item(f);
    expect((await f.store.listVerdicts(it0.id)).map((v) => [v.verdict, v.severity, v.target, v.pr_head])).toEqual([["accept", "none", "issue", it0.last_head_sha]]);
    expect(f.api.thread(ROOT)).toHaveLength(before);

    await f.deliver(reacted(spec.ts, "-1"));
    await f.deliver(reacted(spec.ts, "-1"));
    expect(f.api.thread(ROOT).filter((m) => m.text?.includes("/verdict changes"))).toHaveLength(1);
    expect(await f.store.listVerdicts(it0.id)).toHaveLength(1);
    expect(f.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a planted secret in a run's output never reaches Slack: the worker's egress guard fails the run first", async () => {
    const f = await slackFactory();
    f.runner.script.triage = () => ({ output: { ...triageSpec, problem: `Add a CI scope gate using ${PLANTED}` } });
    await linked(f);
    await f.deliver(eventEnvelope(mention(ROOT, "please add a scope gate")));
    const runs = await f.store.listRuns((await item(f)).id);
    expect(runs[0]).toMatchObject({ kind: "triage", status: "failed", outcome: { error_code: "egress_blocked" } });
    expect(JSON.stringify(f.api.messages)).not.toContain(PLANTED);
    expect(JSON.stringify(f.log.lines)).not.toContain(PLANTED);
  });
});
