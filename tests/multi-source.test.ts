// Several sources in one controller (docs/plugins.md, SourceAdapter; design 2026-11-01): each item's calls go
// to the adapter of its own source type, PR status goes to the forge (issue #273), and one source failing does not
// stop another.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { Logger } from "../src/core/log.js";
import type { SourceRef, WorkItem } from "../src/core/types.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import type { LLMProvider, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { SourceAdapter, SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import {
  FakeAuth,
  FakeForge,
  FakeSlackPollSource,
  FakeSource,
  FakeStreamSource,
  alice,
  cleanScanner,
  config,
  issueRef,
  mallory,
  recordingLog,
  silent,
  slackRef,
  triageSpec,
} from "./helpers/fakes.js";
import { newStore, w1, PROJECT_KEY } from "./helpers/store.js";

/** Slack identities: FakeAuth allows subject "1" only, whatever the provider. */
const slackAlice: ExternalIdentity = { provider: "slack", subject: "1" };
const slackMallory: ExternalIdentity = { provider: "slack", subject: "666" };

/** Always suggests `/approve`. */
class ApproveLLM implements LLMProvider {
  async complete(): Promise<LLMResponse> {
    const parsed = { command: "approve", args: "", confidence: 0.95 };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

async function setup(log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const sl = new FakeSlackPollSource();
  const forge = new FakeForge(gh);
  const controller = new ControllerRole({
    store, sources: [gh, sl], forge, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, llm: new ApproveLLM(),
  });
  return { clock, store, gh, sl, forge, controller };
}

type F = Awaited<ReturnType<typeof setup>>;

function requested(source: SourceRef, requester: ExternalIdentity): SourceEvent {
  return { kind: "item_requested", source, requester, title: "t", body: "b" };
}

/** One item from each source, through one intake tick. */
async function intakeBoth(f: F): Promise<{ ghItem: WorkItem; slItem: WorkItem }> {
  f.gh.queue.push(requested(issueRef(7), alice));
  f.sl.queue.push(requested(slackRef(1), slackAlice));
  await f.controller.tickIntake();
  const ghItem = (await f.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
  const slItem = (await f.store.getWorkItemBySource("slack_thread", slackRef(1).id))!;
  expect(ghItem).toBeTruthy();
  expect(slItem).toBeTruthy();
  return { ghItem, slItem };
}

/** Finishes every queued run of `kind` with `data`, then lets the controller apply them. */
async function finishAll(f: F, kind: "triage" | "implement" | "review", data: Record<string, unknown>): Promise<void> {
  for (;;) {
    const run = await f.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
    if (!run) break;
    await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data });
  }
  await f.controller.tickRuns();
}

const sources = (calls: { source: SourceRef }[]) => [...new Set(calls.map((c) => c.source.id))];
const bodies = (src: FakeSource) => src.comments.map((c) => ({ body: c.body, marker: c.marker }));

describe("multi-source controller: per-item routing", () => {
  it("comments, mark-seen and status updates go only to the adapter of the item's source type", async () => {
    const f = await setup();
    await intakeBoth(f);
    await finishAll(f, "triage", { spec: triageSpec });

    expect(f.gh.comments.length).toBeGreaterThan(0);
    expect(f.sl.comments.length).toBeGreaterThan(0);
    expect(sources(f.gh.comments)).toEqual([issueRef(7).id]);
    expect(sources(f.sl.comments)).toEqual([slackRef(1).id]);
    expect(sources(f.gh.reactions)).toEqual([issueRef(7).id]);
    expect(sources(f.sl.reactions)).toEqual([slackRef(1).id]);
    expect(sources(f.gh.statusCalls)).toEqual([issueRef(7).id]);
    expect(sources(f.sl.statusCalls)).toEqual([slackRef(1).id]);
    expect(f.sl.statusLabels(slackRef(1))).toEqual(["needs_approval"]);
  });

  it("a command's mark-seen and a reject's comment and close go to the item's own adapter", async () => {
    const f = await setup();
    await intakeBoth(f);
    await finishAll(f, "triage", { spec: triageSpec });
    const before = { gh: f.gh.reactions.length, sl: f.sl.reactions.length };

    f.sl.queue.push({ kind: "spec_rejected", source: slackRef(1), comment_id: "200", approver: slackAlice, reason: "not now" });
    await f.controller.tickIntake();

    expect(f.sl.reactions.slice(before.sl)).toEqual([{ source: slackRef(1), comment_id: "200" }]);
    expect(f.gh.reactions.length).toBe(before.gh);
    expect(f.sl.closed).toEqual([slackRef(1)]);
    expect(f.gh.closed).toEqual([]);
    expect(f.sl.comments.some((c) => c.marker.startsWith("<!-- factory:rejected:"))).toBe(true);
    expect(f.gh.comments.some((c) => c.marker.startsWith("<!-- factory:rejected:"))).toBe(false);

    f.gh.queue.push({ kind: "spec_rejected", source: issueRef(7), comment_id: "201", approver: alice, reason: "" });
    await f.controller.tickIntake();
    expect(f.gh.closed).toEqual([issueRef(7)]);
    expect(f.sl.closed).toEqual([slackRef(1)]);
  });

  it("status for the PR of a non-GitHub item goes to the forge; the item's own status stays on its source", async () => {
    const f = await setup();
    const { slItem } = await intakeBoth(f);
    await finishAll(f, "triage", { spec: triageSpec });
    f.sl.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: "300", approver: slackAlice });
    await f.controller.tickIntake();
    await finishAll(f, "implement", { pr_number: 42 });

    expect((await f.store.getWorkItem(slItem.id))!.change_ref).toBe("42");
    expect(f.sl.statusCalls.filter((c) => c.change_ref !== null)).toEqual([]);
    expect(f.forge.statusCalls.filter((c) => c.source.id === slackRef(1).id)).toEqual([
      { source: slackRef(1), status: "in_review", pr_number: 42 },
    ]);
    expect(f.gh.statusCalls.some((c) => c.source.id === slackRef(1).id)).toBe(false);
    expect(f.sl.statusLabels(slackRef(1))).toEqual(["in_review"]);
  });

  it("with one source, PR status still goes to that source (today's behaviour)", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const only = new FakeStreamSource();
    const c = new ControllerRole({ store, sources: [only], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const { item } = await store.createWorkItem(
      { source: slackRef(5), title: "t", requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", resources: [] },
      { kind: "system", id: "system:test" },
    );
    await store.transition({ id: item.id, expected_version: item.version, patch: { change_ref: "9" }, actor: { kind: "system", id: "system:test" }, reason: "test" });
    await c.catchUpStatus();
    expect(only.statusCalls.map((x) => x.change_ref)).toEqual([null, "9"]);
  });

  it("an item whose source type has no adapter keeps its state; its writes wait unsent for a process that has one", async () => {
    const f = await setup();
    const { slItem } = await intakeBoth(f);
    const log = recordingLog();
    const gh = new FakeSource();
    const ghOnly = new ControllerRole({ store: f.store, sources: [gh], auth: new FakeAuth(), clock: f.clock, config, log, scanner: cleanScanner });

    await ghOnly.handleEvent({ kind: "help_requested", source: slackRef(1), comment_id: "400", requester: slackAlice });
    await ghOnly.catchUpStatus();

    expect(gh.comments).toEqual([]);
    expect(gh.reactions).toEqual([]);
    expect(gh.statusCalls.filter((c) => c.source.id === slackRef(1).id)).toEqual([]);
    // Outbound keeps them (RFC 0015 M7): a process with the Slack adapter sends them later.
    const pending = await f.store.db.all("SELECT destination FROM outbound_batches WHERE state <> 'sent'");
    expect(pending.map((r) => String(r.destination))).toContain(`slack_thread:${slackRef(1).id}`);
    const after = (await f.store.getWorkItem(slItem.id))!;
    expect(after.version).toBe(slItem.version);
    expect(after.stage).toBe(slItem.stage);
  });
});

describe("multi-source controller: github-issues + local (2026-11-07)", () => {
  const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });

  async function localSetup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const gh = new FakeSource();
    const local = new LocalSource(store);
    const controller = new ControllerRole({ store, sources: [gh, local], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const create = async (source: SourceRef) =>
      (await store.createWorkItem(
        { source, title: "t", requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", resources: [] },
        { kind: "system", id: "system:test" },
        { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
      )).item;
    const finishTriage = async (c: ControllerRole) => {
      for (;;) {
        const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
        if (!run) break;
        await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: triageSpec } });
      }
      await c.tickRuns();
    };
    return { clock, store, gh, controller, create, finishTriage };
  }

  it("a local item's comments are stored as item messages; a GitHub item's go to the GitHub adapter", async () => {
    const f = await localSetup();
    const localItem = await f.create(localRef(1));
    const ghItem = await f.create(issueRef(7));
    await f.finishTriage(f.controller);

    expect((await f.store.getWorkItem(localItem.id))!.blocked_on).toBe("human");
    expect((await f.store.listItemMessages(localItem.id)).length).toBeGreaterThan(0);
    // Every item's messages are in its thread (issue #282); only the GitHub item's have outbox rows, all delivered.
    expect(await f.store.listDeliveries(localItem.id)).toEqual([]);
    const ghRows = await f.store.listDeliveries(ghItem.id);
    expect(ghRows.length).toBeGreaterThan(0);
    expect(ghRows.every((r) => r.source_type === "github_issue" && r.delivered_at !== null)).toBe(true);
    expect(f.gh.comments.length).toBeGreaterThan(0);
    expect(sources(f.gh.comments)).toEqual([issueRef(7).id]);
    expect(sources(f.gh.statusCalls)).toEqual([issueRef(7).id]);
  });

  it("a controller without the local source still applies a local item's run: the store is its surface (issue #282)", async () => {
    const f = await localSetup();
    const localItem = await f.create(localRef(2));
    const gh = new FakeSource();
    const ghOnly = new ControllerRole({ store: f.store, sources: [gh], auth: new FakeAuth(), clock: f.clock, config, log: silent, scanner: cleanScanner });

    await f.finishTriage(ghOnly);
    expect((await f.store.getWorkItem(localItem.id))!.blocked_on).toBe("human");
    expect((await f.store.listItemMessages(localItem.id)).length).toBeGreaterThan(0);
    expect(gh.comments).toEqual([]);
    expect(await f.store.listUnacknowledgedRuns(20)).toEqual([]);
  });
});

describe("multi-source controller: intake", () => {
  it("when one poll source throws, the other still runs in the same tick: items created, cursor advanced", async () => {
    const log = recordingLog();
    const f = await setup(log);
    f.gh.pollError = new Error("github down");
    f.gh.queue.push(requested(issueRef(7), alice));
    f.sl.queue.push(requested(slackRef(1), slackAlice));

    await f.controller.tickIntake();

    expect(await f.store.getWorkItemBySource("slack_thread", slackRef(1).id)).not.toBeNull();
    expect(await f.store.getWorkItemBySource("github_issue", issueRef(7).id)).toBeNull();
    expect(await f.store.getCursor("intake:slack_thread")).not.toBeNull();
    expect(await f.store.getCursor("intake:github_issue")).toBeNull();
    expect(log.lines.some((l) => l.level === "error" && l.fields?.step === "intake:github_issue")).toBe(true);

    // And the other way round: Slack failing does not stop GitHub.
    f.gh.pollError = null;
    f.sl.pollError = new Error("slack down");
    await f.controller.tickIntake();
    expect(await f.store.getWorkItemBySource("github_issue", issueRef(7).id)).not.toBeNull();
    expect(await f.store.getCursor("intake:github_issue")).not.toBeNull();
  });

  it("each poll source keeps its own cursor under intake:<type>, moving independently", async () => {
    const f = await setup();
    const n = async (type: string) => {
      const c = await f.store.getCursor(`intake:${type}`);
      return c === null ? 0 : (JSON.parse(c) as { n: number }).n;
    };
    await f.controller.tickIntake();
    expect([await n("github_issue"), await n("slack_thread")]).toEqual([1, 1]);

    f.gh.pollError = new Error("down");
    await f.controller.tickIntake();
    await f.controller.tickIntake();
    expect([await n("github_issue"), await n("slack_thread")]).toEqual([1, 3]);

    f.gh.pollError = null;
    f.sl.pollError = new Error("down");
    await f.controller.tickIntake();
    expect([await n("github_issue"), await n("slack_thread")]).toEqual([2, 3]);
    // Each source was given its own cursor back.
    expect(f.gh.polls.at(-1)).toBe(JSON.stringify({ n: 1, last_comment_id: 0 }));
    expect(f.sl.polls.at(-1)).toBe(JSON.stringify({ n: 3, last_comment_id: 0 }));
  });
});

describe("multi-source controller: commands", () => {
  /** Both items at spec_pending, so the same commands apply to both. */
  async function pending() {
    const f = await setup();
    await intakeBoth(f);
    await finishAll(f, "triage", { spec: triageSpec });
    f.gh.comments = [];
    f.sl.comments = [];
    return f;
  }

  type Cmd = (source: SourceRef, who: ExternalIdentity, comment_id: string) => SourceEvent;
  const cases: [string, Cmd, "alice" | "mallory"][] = [
    ["/approve without permission", (source, who, comment_id) => ({ kind: "spec_approved", source, comment_id, approver: who }), "mallory"],
    ["/revise without feedback", (source, who, comment_id) => ({ kind: "revise_requested", source, comment_id, requester: who, feedback: " " }), "alice"],
    ["/help", (source, who, comment_id) => ({ kind: "help_requested", source, comment_id, requester: who }), "alice"],
    ["an unknown command", (source, who, comment_id) => ({ kind: "unknown_command", source, comment_id, requester: who, command: "shipit" }), "alice"],
    ["a plain comment (suggestion)", (source, who, comment_id) => ({ kind: "plain_comment", source, comment_id, author: who, body: "ship it" }), "alice"],
  ];

  for (const [name, make, who] of cases) {
    it(`${name} from a non-GitHub source gets the same reply as from GitHub, on its own source`, async () => {
      const f = await pending();
      f.gh.queue.push(make(issueRef(7), who === "alice" ? alice : mallory, "500"));
      f.sl.queue.push(make(slackRef(1), who === "alice" ? slackAlice : slackMallory, "500"));
      await f.controller.tickIntake();

      expect(f.gh.comments).toHaveLength(1);
      expect(bodies(f.sl)).toEqual(bodies(f.gh));
      expect(sources(f.gh.comments)).toEqual([issueRef(7).id]);
      expect(sources(f.sl.comments)).toEqual([slackRef(1).id]);
    });
  }

  it("the permission refusal text is the same on both sources", async () => {
    const f = await pending();
    f.sl.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: "600", approver: slackMallory });
    await f.controller.tickIntake();
    expect(f.sl.comments.map((c) => c.body)).toEqual([
      "`/approve` was not applied: only the owner may send this command (`not_a_collaborator`).",
    ]);
  });

  it("an allowed /approve from a non-GitHub source applies the same transition", async () => {
    const f = await pending();
    f.sl.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: "700", approver: slackAlice });
    await f.controller.tickIntake();
    const it = (await f.store.getWorkItemBySource("slack_thread", slackRef(1).id))!;
    expect(it.stage).toBe("RUNNING");
    expect((await f.store.listStateChanges(it.id)).at(-1)).toMatchObject({ reason: "spec_approved", actor: { kind: "user", id: "github:1" } });
  });
});

describe("multi-source controller: startup checks", () => {
  const make = (sources: SourceAdapter[]) => () =>
    new ControllerRole({ store: {} as never, sources, auth: new FakeAuth(), clock: new FakeClock(), config, log: silent, scanner: cleanScanner });

  it("no sources is allowed: items and commands live in the store (issue #282)", () => {
    expect(make([])).not.toThrow();
  });

  it("two sources of the same type fail, naming plugins.source and the type", () => {
    expect(make([new FakeSource(), new FakeSource()])).toThrow(/plugins\.source.*github_issue/);
    expect(make([new FakeSlackPollSource(), new FakeStreamSource()])).toThrow(/plugins\.source.*slack_thread/);
  });

  it("several sources with none of type github_issue are accepted: PRs come from the forge (issue #273)", () => {
    const other = new FakeStreamSource();
    (other as { type: string }).type = "local" as never;
    expect(make([new FakeSlackPollSource(), other])).not.toThrow();
  });

  it("one non-GitHub source alone is accepted", () => {
    expect(make([new FakeStreamSource()])).not.toThrow();
    expect(make([new FakeSlackPollSource()])).not.toThrow();
  });
});
