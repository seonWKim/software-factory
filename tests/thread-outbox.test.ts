import { OwnerAuth } from "../src/core/authorize.js";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { SourceRef, UserId, WorkerId, WorkItem, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceAdapter } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSlackPollSource, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef,
  prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, w1 } from "./helpers/store.js";

// Thread first, then the outbox (issue #282): the controller writes every message to the item thread, and only the
// outbox step calls a source's postComment, once per entry, with backoff on failure. Commands come from the command
// inbox, so the factory runs with no source at all.

/**
 * A GitHub-type source that is not idempotent on the marker (every call counts), and that checks on each call that
 * the message is already in the thread and that the outbox step is the caller.
 */
class StrictSource extends FakeSource {
  calls: { marker: string; inThread: boolean; fromOutbox: boolean }[] = [];
  failNext = 0;
  delayMs = 0;
  constructor(private readonly store: FactoryStore) {
    super();
  }
  override async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string }> {
    const fromOutbox = /Outbound\.deliver\b/.test(new Error().stack ?? "");
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const item = await this.store.getWorkItemBySource(source.type, source.id);
    const inThread = item ? (await this.store.listItemMessages(item.id)).some((m) => m.marker === marker && m.body === body) : false;
    this.calls.push({ marker, inThread, fromOutbox });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("forge down");
    }
    const url = `${source.link}#issuecomment-${this.calls.length}`;
    this.comments.push({ source, body, marker, url });
    return { url };
  }
}

async function setup(sources?: (store: FactoryStore) => SourceAdapter[]) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new StrictSource(store);
  const controller = new ControllerRole({
    store, sources: sources ? sources(store) : [source], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner,
  });
  const intake = async (n: number): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  /** Finishes the queued triage run and applies it with `c`, without its outbox step. */
  const finishTriage = async (c: ControllerRole) => {
    const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    await store.completeRun(run!.id, run!.lease!.token, { status: "succeeded", summary: "s", data: { spec: triageSpec } });
    await (await c.unit("run-results")).runsStep();
  };
  return { clock, store, source, controller, intake, finishTriage };
}

describe("thread first", () => {
  it("every message is in the item thread before any source is called, and only the outbox step calls postComment", async () => {
    const f = await setup();
    const item = await f.intake(1);
    await f.finishTriage(f.controller);
    // Applied, written to the thread, not posted yet.
    expect((await f.store.getWorkItem(item.id))!.blocked_reason).toBe("spec_pending");
    const spec = (await f.store.listItemMessages(item.id)).find((m) => m.marker.startsWith("<!-- factory:spec:"));
    expect(spec).toBeDefined();
    expect(f.source.calls).toEqual([]);
    expect((await f.store.listDeliveries(item.id)).map((d) => d.delivered_at)).toEqual([null]);

    await f.controller.tickOutbox();
    // A refused command: its reply goes the same way.
    f.source.queue.push({ kind: "spec_approved", source: issueRef(1), comment_id: "77", approver: { provider: "github", subject: "666" } });
    await f.controller.tickIntake();
    expect(f.source.calls.map((c) => c.marker)).toEqual([spec!.marker, "<!-- factory:refused:77 -->"]);
    expect(f.source.calls.every((c) => c.inThread && c.fromOutbox)).toBe(true);
    expect((await f.store.listDeliveries(item.id)).every((d) => d.delivered_at !== null && d.target.id === issueRef(1).id)).toBe(true);
  });

  it("the delivered spec comment's URL fills the item's link, with no new version", async () => {
    const f = await setup();
    const item = await f.intake(1);
    await f.finishTriage(f.controller);
    const before = (await f.store.getWorkItem(item.id))!;
    expect(before.spec_comment_url).toBeNull();
    await f.controller.tickOutbox();
    const after = (await f.store.getWorkItem(item.id))!;
    expect(after.spec_comment_url).toBe(f.source.comments[0]!.url);
    expect(after.version).toBe(before.version);
  });
});

describe("outbox delivery", () => {
  it("delivers each entry once: a second delivery pass posts nothing", async () => {
    const f = await setup();
    const item = await f.intake(1);
    await f.finishTriage(f.controller);
    await f.controller.tickOutbox();
    await f.controller.tickOutbox();
    const markers = (await f.store.listItemMessages(item.id)).map((m) => m.marker);
    expect(f.source.calls.map((c) => c.marker)).toEqual(markers);
  });

  it("a failed delivery is retried with backoff (retry_base_ms doubling, capped at retry_max_ms); the item is untouched", async () => {
    const f = await setup();
    const item = await f.intake(1);
    await f.finishTriage(f.controller);
    const before = (await f.store.getWorkItem(item.id))!;
    f.source.failNext = 10;
    const t0 = f.clock.now().getTime();

    await f.controller.tickOutbox();
    let [row] = await f.store.listDeliveries(item.id);
    expect(row).toMatchObject({ attempts: 1, last_error: "forge down", delivered_at: null });
    expect(Date.parse(row!.next_attempt_at) - t0).toBe(config.retry_base_ms);
    // Not yet due: no call.
    f.clock.advance(config.retry_base_ms - 1);
    await f.controller.tickOutbox();
    expect(f.source.calls).toHaveLength(1);
    f.clock.advance(1);
    await f.controller.tickOutbox();
    [row] = await f.store.listDeliveries(item.id);
    expect(row!.attempts).toBe(2);
    expect(Date.parse(row!.next_attempt_at) - f.clock.now().getTime()).toBe(config.retry_base_ms * 2);
    // Many failures later the wait stops growing at retry_max_ms.
    for (let i = 0; i < 8; i++) {
      f.clock.advance(config.retry_max_ms);
      await f.controller.tickOutbox();
    }
    [row] = await f.store.listDeliveries(item.id);
    expect(Date.parse(row!.next_attempt_at) - f.clock.now().getTime()).toBe(config.retry_max_ms);

    const during = (await f.store.getWorkItem(item.id))!;
    expect({ stage: during.stage, blocked_on: during.blocked_on, blocked_reason: during.blocked_reason, version: during.version })
      .toEqual({ stage: before.stage, blocked_on: before.blocked_on, blocked_reason: before.blocked_reason, version: before.version });

    f.source.failNext = 0;
    f.clock.advance(config.retry_max_ms);
    await f.controller.tickOutbox();
    expect((await f.store.listDeliveries(item.id))[0]!.delivered_at).not.toBeNull();
    expect(f.source.comments).toHaveLength(1);
    expect((await f.store.getWorkItem(item.id))!.version).toBe(before.version);
  });

  it("two delivery passes at once over the same entries, as two replicas run them, post each message once", async () => {
    const f = await setup();
    const a = await f.intake(1);
    await f.finishTriage(f.controller);
    const b = await f.intake(2);
    await f.finishTriage(f.controller);
    const other = new StrictSource(f.store);
    f.source.delayMs = 5;
    other.delayMs = 5;
    const replica = new ControllerRole({ store: f.store, sources: [other], auth: new FakeAuth(), clock: f.clock, config, log: silent, scanner: cleanScanner });
    await Promise.all([f.controller.tickOutbox(), replica.tickOutbox()]);
    await Promise.all([f.controller.tickOutbox(), replica.tickOutbox()]);
    const posted = [...f.source.calls, ...other.calls].map((c) => c.marker).sort();
    const entries = [...(await f.store.listItemMessages(a.id)), ...(await f.store.listItemMessages(b.id))].map((m) => m.marker).sort();
    expect(posted).toEqual(entries);
  });
});

describe("an item whose source type has no adapter", () => {
  const slackRef = (n: number): SourceRef => ({ type: "slack_thread", id: `C1/${n}`, link: `https://slack.example/C1/${n}` });

  it("keeps its state, and its undelivered entries stay pending until a process with the adapter delivers them", async () => {
    const f = await setup();
    const { item } = await f.store.createWorkItem(
      { source: slackRef(1), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
      { kind: "system", id: "system:test" },
      { enqueue: { kind: "triage", idempotency_key: "slack:1:triage" } },
    );
    // A help reply written by this GitHub-only controller: in the thread, its outbox row pending.
    await f.controller.handleEvent({ kind: "help_requested", source: slackRef(1), comment_id: "5", requester: alice });
    await f.finishTriage(f.controller);
    await f.controller.tickOutbox();
    const kept = (await f.store.getWorkItem(item.id))!;
    expect(kept).toMatchObject({ stage: "NEW", blocked_on: "none", version: item.version });
    const pending = await f.store.listDeliveries(item.id);
    expect(pending.map((d) => [d.source_type, d.attempts, d.delivered_at])).toEqual([["slack_thread", 0, null]]);
    expect(f.source.calls).toEqual([]);

    const slack = new FakeSlackPollSource();
    const withSlack = new ControllerRole({ store: f.store, sources: [f.source, slack], auth: new FakeAuth(), clock: f.clock, config, log: silent, scanner: cleanScanner });
    await withSlack.tickOutbox();
    expect(slack.comments.map((c) => c.marker)).toEqual(["<!-- factory:help:5 -->"]);
  });
});

describe("no source at all", () => {
  const OWNER = "github:1" as UserId;

  async function factory() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const auth = new OwnerAuth({ store: store, claimer: OWNER });
    const controller = new ControllerRole({ store, sources: [], auth, clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "the summary", next_steps: "the next steps" } }),
    });
    // A local item's branch in the factory repo is the change itself, as the local broker stores it.
    const broker = new FakeBroker();
    broker.toForge = false;
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config,
      prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    let n = 0;
    const cli = (a: CliAction) => {
      const d: LocalCliDeps = { store, identity: { user: OWNER, from: "cli_user" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}` };
      return runLocalCli(d, a);
    };
    const step = async () => {
      await controller.tickIntake();
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
    };
    const link = async () => {
      await store.createLinkCode(OWNER, "code-1");
      await store.redeemLinkCode("code-1", { provider: "local", subject: OWNER });
    };
    return { store, controller, cli, step, link };
  }

  it("the controller starts with an empty source list", async () => {
    const f = await factory();
    const ac = new AbortController();
    const running = f.controller.run(ac.signal);
    ac.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it("intake (an item created in the store), approve from the command inbox and implement reach a passing run", async () => {
    const f = await factory();
    await f.link();
    const id = (await f.cli({ action: "create", title: "Add a gate", bodyFile: "b.md" })).lines[0] as WorkItemId;
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });

    expect((await f.cli({ action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await f.step();
    const runs = await f.store.listRuns(id);
    expect(runs.find((r) => r.kind === "implement")).toMatchObject({ status: "succeeded" });
    expect((await f.store.getWorkItem(id))!.stage).toBe("REVIEW");
    expect((await f.store.listStateChanges(id)).find((c) => c.reason === "spec_approved")!.actor).toEqual({ kind: "user", id: OWNER });
    // Local messages live in the thread only: nothing to deliver.
    expect(await f.store.listDeliveries(id)).toEqual([]);
  });

  it("a CLI command from an unlinked user is refused by the same authorize check as a GitHub comment, with the same reply", async () => {
    const f = await factory();
    const id = (await f.cli({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    await f.cli({ action: "command", command: "approve", id, text: "" });
    await f.step();
    const refusal = (await f.store.listItemMessages(id)).find((m) => m.marker.startsWith("<!-- factory:refused:cli:"));
    expect(refusal!.body).toBe("`/approve` was not applied: your local identity resolves to no factory user under the local auth plugin.");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("the inbox cursor starts at the commands cursor: commands before it are not applied again", async () => {
    const f = await factory();
    await f.link();
    const id = (await f.cli({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    const old = (await f.store.appendCliCommand({ key: "old", actor: OWNER, command: "reject", args: { item: id, text: "no" } })).command;
    await f.store.advanceCursor("commands", null, String(old.seq));
    await f.step();
    expect((await f.store.getWorkItem(id))!.stage).toBe("READY");
    expect(await f.store.listItemMessages(id).then((ms) => ms.filter((m) => m.marker.includes(":old ")))).toEqual([]);
  });
});
