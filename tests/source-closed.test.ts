import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, recordingLog, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

/** FakeAuth, except that subject "404" maps to no user. */
class PartialAuth extends FakeAuth implements AuthProvider {
  override async resolve(identity: ExternalIdentity): Promise<Principal> {
    return identity.subject === "404" ? (null as unknown as Principal) : super.resolve(identity);
  }
}

async function factory(runner = new FakeRunner({ triage: () => ({ output: triageSpec }) })) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const log = recordingLog();
  const makeController = () => new Controller({ store, source, auth: new PartialAuth(), clock, config, log, scanner: cleanScanner });
  const controller = makeController();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  return { clock, store, source, log, controller, makeController, worker };
}

const src = issueRef(7);
const bob: ExternalIdentity = { provider: "github", subject: "2", login: "bob" };
const requested: SourceEvent = { kind: "item_requested", source: src, requester: alice, title: "CI gate", body: "please" };
const closed = (closer: ExternalIdentity | null = bob): SourceEvent => ({ kind: "source_closed", source: src, closer });

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

  it("a run in progress finishes, but its result is ignored: no transition, no comment, run acknowledged", async () => {
    let f!: F;
    f = await factory(new FakeRunner({
      triage: async () => {
        await intake(f, closed());
        return { output: triageSpec };
      },
    }));
    await intake(f, requested);
    expect(await f.worker.tick()).toBe(true);
    const [run] = await f.store.listRuns((await item(f)).id);
    expect(run!.status).toBe("succeeded");

    await f.controller.tickRuns();
    expect(await item(f)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do", tier: null, done_criteria: null });
    expect((await f.store.getRun(run!.id))!.acknowledged_at).not.toBeNull();
    const reasons = (await f.store.listStateChanges((await item(f)).id)).map((c) => c.reason);
    expect(reasons).toEqual(["intake", "source_closed", "run_ignored"]);
    expect(f.source.comments).toEqual([]);
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
