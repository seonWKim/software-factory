import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import type { AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceCloseReason, SourceEvent } from "../src/interfaces/source-adapter.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, recordingLog, triageSpec, waitFor,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

/** FakeAuth, except that subject "404" maps to no user. */
class PartialAuth extends FakeAuth implements AuthProvider {
  override async resolve(identity: ExternalIdentity): Promise<Principal> {
    return identity.subject === "404" ? (null as unknown as Principal) : super.resolve(identity);
  }
}

/** Passes every call to `inner` and keeps each call's result. */
class RecordingBroker implements ToolBroker {
  results: { name: string; result: ToolResult }[] = [];
  constructor(private readonly inner: ToolBroker) {}
  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.inner.listTools(grants);
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const result = await this.inner.call(ctx, name, args);
    this.results.push({ name, result });
    return result;
  }
}

/**
 * The real GitHub tool broker (its lease check is what stops a closed item's run), over a GitHub client
 * that only records what would have reached GitHub.
 */
function githubBroker(store: FactoryStore, clock: FakeClock) {
  const remote: string[] = [];
  const client = {
    request: async (method: string, path: string) => {
      remote.push(`${method} ${path}`);
      return {};
    },
    commentOnce: async (_r: unknown, n: number) => {
      remote.push(`comment ${n}`);
      return { created: true, url: null };
    },
  } as unknown as GitHubClient;
  const broker = new RecordingBroker(new GitHubToolBroker({
    client, store, clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    credentials: { token: async () => null }, scanner: cleanScanner,
  }));
  return { broker, remote };
}

async function factory(
  runner = new FakeRunner({ triage: () => ({ output: triageSpec }) }),
  makeBroker: (store: FactoryStore, clock: FakeClock) => ToolBroker = () => new FakeBroker(),
) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const log = recordingLog();
  const workerLog = recordingLog();
  const makeController = () => new Controller({ store, source, auth: new PartialAuth(), clock, config, log, scanner: cleanScanner });
  const controller = makeController();
  const broker = makeBroker(store, clock);
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(),
    clock, config, prompts, log: workerLog, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  return { clock, store, source, log, workerLog, controller, makeController, worker, broker };
}

const src = issueRef(7);
const bob: ExternalIdentity = { provider: "github", subject: "2", login: "bob" };
const requested: SourceEvent = { kind: "item_requested", source: src, requester: alice, title: "CI gate", body: "please" };
const closed = (closer: ExternalIdentity | null = bob, state_reason: SourceCloseReason | null = null): SourceEvent => ({
  kind: "source_closed", source: src, closer, state_reason,
});

type F = Awaited<ReturnType<typeof factory>>;

async function intake(f: F, ...events: SourceEvent[]) {
  f.source.queue.push(...events);
  await f.controller.tickIntake();
}

async function item(f: F) {
  return (await f.store.getWorkItemBySource("github_issue", src.id))!;
}

async function closes(f: F) {
  return (await f.store.listStateChanges((await item(f)).id)).filter((c) => c.reason === "source_closed");
}

describe("closing the source issue stops its work item", () => {
  it("closes an item in triage: CLOSED / wont_do, one source_closed row naming the closer's user id, queued triage cancelled", async () => {
    const f = await factory();
    await intake(f, requested);
    await intake(f, closed());

    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", blocked_on: "none", blocked_reason: null });
    const rows = await closes(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toEqual({ kind: "user", id: "github:2" as UserId });
    expect(f.source.statusLabels(src)).toEqual(["rejected"]);
    expect(JSON.stringify(rows[0])).not.toContain("bob");

    const runs = await f.store.listRuns((await item(f)).id);
    expect(runs.map((r) => r.status)).toEqual(["cancelled"]);
    expect(await f.worker.tick()).toBe(false);

    // The cancelled run is acknowledged as ignored; nothing is posted on the closed issue.
    await f.controller.tickRuns();
    expect((await f.store.getRun(runs[0]!.id))!.acknowledged_at).not.toBeNull();
    const reasons = (await f.store.listStateChanges((await item(f)).id)).map((c) => c.reason);
    expect(reasons).toEqual(["intake", "source_closed", "run_ignored"]);
    expect(f.source.comments).toEqual([]);
    expect(f.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("cancels a retry waiting on backoff; no worker claims it after the wait", async () => {
    let calls = 0;
    const f = await factory(new FakeRunner({ triage: () => (calls++ === 0 ? { status: "failed", error: "boom" } : { output: triageSpec }) }));
    await intake(f, requested);
    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();
    const queued = (await f.store.listRuns((await item(f)).id)).filter((r) => r.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.not_before).not.toBeNull();

    await intake(f, closed());
    expect((await f.store.getRun(queued[0]!.id))!.status).toBe("cancelled");
    f.clock.advance(config.retry_max_ms + 1);
    expect(await f.worker.tick()).toBe(false);
    await f.controller.tickRuns();
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do" });
    expect(calls).toBe(1);
  });

  it("a running run is stopped by the close: lease_lost on its next heartbeat, outcome not stored, run acknowledged", async () => {
    let f!: F;
    f = await factory(new FakeRunner({
      triage: async () => {
        await intake(f, closed());
        f.clock.advance(config.heartbeat_ms);
        await waitFor(() => f.workerLog.lines.some((l) => l.msg === "lease lost; aborting run"), "the heartbeat to fail");
        return { output: triageSpec };
      },
    }));
    await intake(f, requested);
    expect(await f.worker.tick()).toBe(true);
    const [run] = await f.store.listRuns((await item(f)).id);
    expect(run).toMatchObject({ status: "cancelled", outcome: null, lease: null });
    expect(f.workerLog.lines.map((l) => l.msg)).toContain("lease lost before completion; outcome dropped");

    await f.controller.tickRuns();
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", tier: null, done_criteria: null });
    expect((await f.store.getRun(run!.id))!.acknowledged_at).not.toBeNull();
    const reasons = (await f.store.listStateChanges((await item(f)).id)).map((c) => c.reason);
    expect(reasons).toEqual(["intake", "source_closed", "run_ignored"]);
    expect(f.source.comments).toEqual([]);
  });

  it("flow: a running implement run stopped by the close pushes nothing and posts no comment on the issue", async () => {
    let f!: F;
    let commentsAtClose = -1;
    let ctx!: ToolCallContext;
    const gh: { remote: string[]; broker: RecordingBroker }[] = [];
    f = await factory(
      new FakeRunner({
        triage: () => ({ output: triageSpec }),
        implement: async () => {
          const running = (await f.store.listRuns((await item(f)).id)).find((r) => r.kind === "implement")!;
          ctx = { run_id: running.id, work_item_id: running.work_item_id, lease_token: running.lease!.token };
          await intake(f, closed());
          commentsAtClose = f.source.comments.length;
          return { output: { summary: "s", next_steps: "n" } };
        },
      }),
      (store, clock) => {
        const b = githubBroker(store, clock);
        gh.push(b);
        return b.broker;
      },
    );
    await intake(f, requested);
    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();
    await intake(f, { kind: "spec_approved", source: src, comment_id: "100", approver: alice });
    expect(await item(f)).toMatchObject({ stage: "RUNNING" });

    expect(await f.worker.tick()).toBe(true);
    const { broker, remote } = gh[0]!;
    // Nothing the run did after the close reached GitHub: every tool call it made was refused.
    expect(broker.results.every((r) => !r.result.ok && r.result.error_code === "lease_lost")).toBe(true);
    expect(remote).toEqual([]);
    // The broker refuses the stopped run's push outright.
    const push = await broker.call(ctx, "github.push_branch", { workdir: "/wt/2", branch: `factory/${ctx.work_item_id}`, base_ref: "main" });
    expect(push).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(remote).toEqual([]);

    const implement = (await f.store.listRuns((await item(f)).id)).find((r) => r.kind === "implement")!;
    expect(implement).toMatchObject({ status: "cancelled", outcome: null });
    await f.controller.tickRuns();
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", pr_number: null });
    expect((await f.store.getRun(implement.id))!.acknowledged_at).not.toBeNull();
    expect(commentsAtClose).toBeGreaterThanOrEqual(0);
    expect(f.source.comments).toHaveLength(commentsAtClose);
    expect(f.source.prComments).toEqual([]);
  });

  it("the same close twice, in one poll, a later poll, or after a restart, writes one row and cancels nothing new", async () => {
    const f = await factory();
    await intake(f, requested);
    await intake(f, closed(), closed());
    await intake(f, closed());
    const restarted = f.makeController();
    f.source.queue.push(closed());
    await restarted.tickIntake();

    expect(await closes(f)).toHaveLength(1);
    const changes = await f.store.listStateChanges((await item(f)).id);
    expect(changes.map((c) => c.reason)).toEqual(["intake", "source_closed"]);
    expect((await f.store.listRuns((await item(f)).id)).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("the factory's own close (after /reject) is not recorded again when the issue then closes", async () => {
    const f = await factory();
    await intake(f, requested);
    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();
    await intake(f, { kind: "spec_rejected", source: src, comment_id: "100", approver: alice, reason: "no" });
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const before = await f.store.listStateChanges((await item(f)).id);

    await intake(f, closed(alice));
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect(await f.store.listStateChanges((await item(f)).id)).toEqual(before);
    expect(f.log.lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("with no closer, or a closer that maps to no user, records the system actor and warns", async () => {
    for (const closer of [null, { provider: "github" as const, subject: "404", login: "ghost" }]) {
      const f = await factory();
      await intake(f, requested);
      await intake(f, closed(closer));
      const rows = await closes(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor.kind).toBe("system");
      expect(f.log.lines.filter((l) => l.level === "warn").map((l) => l.msg)).toEqual([
        "source closed by an unknown user; recorded as the system actor",
      ]);
    }
  });

  it("closing an issue with no work item does nothing and raises no error", async () => {
    const f = await factory();
    await intake(f, closed());
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(f.log.lines.filter((l) => l.level !== "info")).toEqual([]);
    expect(f.source.comments).toEqual([]);
  });

  it("reopening the issue, or re-adding the label, starts no run and changes nothing", async () => {
    const f = await factory();
    await intake(f, requested);
    await intake(f, closed());
    await f.controller.tickRuns();
    const before = await f.store.listStateChanges((await item(f)).id);
    const runsBefore = await f.store.listRuns((await item(f)).id);

    // A reopened (or relabelled) issue shows up in the open-issue read again.
    await intake(f, requested);
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do" });
    expect(await f.store.listStateChanges((await item(f)).id)).toEqual(before);
    expect(await f.store.listRuns((await item(f)).id)).toEqual(runsBefore);
    expect(await f.worker.tick()).toBe(false);
  });

  it("a merge that closes its issue in the same poll is recorded as completed, not wont_do", async () => {
    const f = await factory();
    await intake(f, requested);
    const it = await item(f);
    // Put the item where a merged PR finds it.
    await f.store.transition({
      id: it.id, expected_version: it.version, actor: { kind: "system", id: "system:test" }, reason: "test",
      patch: { stage: "REVIEW", pr_number: 42, blocked_on: "human", blocked_reason: "merge_pending" },
    });
    await intake(
      f,
      { kind: "pr_merged", pr_number: 42, head_branch: `factory/${it.id}`, merge_sha: "m1", merger: alice },
      closed(alice),
    );
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await closes(f)).toEqual([]);
  });
});

describe("closing the source issue: close reason and the open PR", () => {
  /** An item in REVIEW waiting on the merge of PR 42. */
  async function withPr(f: F) {
    await intake(f, requested);
    const it = await item(f);
    await f.store.transition({
      id: it.id, expected_version: it.version, actor: { kind: "system", id: "system:test" }, reason: "test",
      patch: { stage: "REVIEW", pr_number: 42, blocked_on: "human", blocked_reason: "merge_pending" },
    });
    return it.id;
  }

  it("closed as completed: CLOSED / completed, no merge_sha, status done on the issue", async () => {
    const f = await factory();
    await intake(f, requested);
    await intake(f, closed(bob, "completed"));
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null, blocked_on: "none" });
    expect(f.source.statusLabels(src)).toEqual(["done"]);
    expect((await f.store.listRuns((await item(f)).id)).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("closed as not planned, or with no reason: CLOSED / wont_do, status rejected on the issue", async () => {
    for (const reason of ["not_planned", null] as const) {
      const f = await factory();
      await intake(f, requested);
      await intake(f, closed(bob, reason));
      expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", merge_sha: null });
      expect(f.source.statusLabels(src)).toEqual(["rejected"]);
    }
  });

  it("closes the item's open PR without merging it, with one comment naming the closer", async () => {
    const f = await factory();
    await withPr(f);
    await intake(f, closed(bob, "not_planned"));
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", blocked_on: "none", blocked_reason: null });
    expect(f.source.prStates.get(42)).toBe("closed");
    expect(f.source.prComments.map((c) => [c.pr_number, c.body])).toEqual([[42, "Closed because the issue was closed by @bob."]]);
    expect(f.source.statusLabels(src)).toEqual(["rejected"]);
    expect(f.source.statusLabels(src, 42)).toEqual(["rejected"]);
    expect(f.source.comments).toEqual([]);

    // The same close again, in later polls and sweeps: no second comment, nothing new written.
    const version = (await item(f)).version;
    await intake(f, closed(bob, "not_planned"));
    await f.controller.tickSourceCloses();
    expect(f.source.prComments).toHaveLength(1);
    expect((await item(f)).version).toBe(version);
  });

  it("with no closer, the PR comment says only that the issue was closed", async () => {
    const f = await factory();
    await withPr(f);
    await intake(f, closed(null, "completed"));
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null });
    expect(f.source.prComments.map((c) => c.body)).toEqual(["Closed because the issue was closed."]);
    expect(f.source.statusLabels(src)).toEqual(["done"]);
  });

  it("a PR already merged or closed is not closed again and gets no comment", async () => {
    for (const state of ["merged", "closed"] as const) {
      const f = await factory();
      await withPr(f);
      f.source.prStates.set(42, state);
      await intake(f, closed());
      expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", blocked_on: "none", blocked_reason: null });
      expect(f.source.prStates.get(42)).toBe(state);
      expect(f.source.prComments).toEqual([]);
    }
  });

  it("a failed PR close or comment leaves the item CLOSED, is logged, and a later tick retries it", async () => {
    for (const fail of ["close", "comment"] as const) {
      const f = await factory();
      await withPr(f);
      if (fail === "close") f.source.prCloseError = new Error("boom");
      else f.source.prCommentError = new Error("boom");
      await intake(f, closed(bob, "completed"));
      expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
      expect(f.source.prStates.get(42) ?? "open").toBe("open");
      expect(f.log.lines.filter((l) => l.level === "warn").map((l) => l.msg))
        .toContain("closing the PR after the source closed failed; retried on a later tick");

      f.source.prCloseError = null;
      f.source.prCommentError = null;
      await f.controller.tickSourceCloses();
      expect(f.source.prStates.get(42)).toBe("closed");
      expect(f.source.prComments.map((c) => c.body)).toEqual(["Closed because the issue was closed by @bob."]);
      expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null });
      const calls = f.source.prCloseCalls.length;
      await f.controller.tickSourceCloses();
      expect(f.source.prCloseCalls).toHaveLength(calls);
    }
  });

  it("the pr_closed event GitHub sends after the factory closes the PR does not change the close reason", async () => {
    for (const reason of ["completed", "not_planned"] as const) {
      const f = await factory();
      const id = await withPr(f);
      await intake(f, closed(bob, reason));
      const before = await item(f);
      await intake(f, { kind: "pr_closed", pr_number: 42, head_branch: `factory/${id}` });
      expect(await item(f)).toEqual(before);
      expect(before.close_reason).toBe(reason === "completed" ? "completed" : "wont_do");
    }
  });

  it("stops every running run of the item, of any kind, with the close", async () => {
    const f = await factory();
    const id = await withPr(f);
    const it = await item(f);
    await f.store.transition({
      id, expected_version: it.version, actor: { kind: "system", id: "system:test" }, reason: "test",
      patch: {}, enqueue: { kind: "update", idempotency_key: "u1" },
    });
    const update = (await f.store.claimRun({ worker_id: "w2" as WorkerId, kinds: ["update"], lease_ms: config.lease_ms }))!;
    expect(update.status).toBe("running");
    await intake(f, closed());
    expect(await f.store.getRun(update.id)).toMatchObject({ status: "cancelled", lease: null });
    expect(await f.store.heartbeat(update.id, update.lease!.token, config.lease_ms)).toEqual({ ok: false, reason: "lease_lost" });
  });
});
