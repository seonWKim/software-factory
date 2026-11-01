import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { Logger } from "../src/core/log.js";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, config, issueRef, mallory, prompts, recordingLog, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";

async function factory(runner: FakeRunner, knownSecrets: string[] = [], log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const storage = new MemoryStorage();
  const scanner = new PatternEgressScanner(async () => knownSecrets);
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage, clock, config, prompts, log: silent,
    scanner,
    toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  return { clock, store, source, sandbox, broker, storage, controller, worker, step };
}

const review = (verdict: "pass" | "bug", tier = 2) => () => ({
  output: { verdict, tier, findings: verdict === "bug" ? ["off-by-one in gate"] : [], summary: "s" },
});

describe("one issue to one merged PR", () => {
  it("runs triage → human spec gate → implement → review loop → human merge, with a full trail", async () => {
    let reviews = 0;
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "added gate", next_steps: "none" } }),
      review: (s) => review(reviews++ === 0 ? "bug" : "pass")(),
    });
    const f = await factory(runner);
    const src = issueRef(7);

    f.source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "CI gate", body: "please" });
    await f.step();
    let item = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    expect(item).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 });
    expect(f.source.comments[0]!.body).toContain("Reply `/approve`");
    expect(f.source.comments[0]!.body).toContain(
      "### Files\nAllowed to change:\n- `.github/workflows/`\n\nExpected to change:\n- `.github/workflows/scope.yml`",
    );
    expect(f.source.comments[0]!.body).not.toContain("Please check");

    // An unauthorized approval is ignored.
    f.source.queue.push({ kind: "spec_approved", source: src, comment_id: "101", approver: mallory });
    await f.step();
    expect((await f.store.getWorkItem(item.id))!.stage).toBe("READY");

    f.source.queue.push({ kind: "spec_approved", source: src, comment_id: "102", approver: alice });
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, loop_count: 1 });

    // Second implement run saw the reviewer's findings; reviewer prompt had no implementer transcript.
    const implementSpecs = runner.specs.filter((s) => s.role === "implement");
    expect(implementSpecs).toHaveLength(2);
    expect(implementSpecs[1]!.prompt).toContain("off-by-one in gate");
    expect(implementSpecs[0]!.writable_paths).toEqual(["/repo/.git"]);
    expect(f.broker.calls.filter((c) => c.name === "github.comment")).toHaveLength(2);
    expect(f.source.comments.at(-1)!.body).toContain("human merge is required");

    f.source.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${item.id}`, merge_sha: "m1", merger: alice });
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });

    const trail = (await f.store.listStateChanges(item.id)).map((c) => c.reason);
    expect(trail).toEqual([
      "intake", "triaged", "spec_approved", "implemented", "review_bug", "implemented", "review_passed", "pr_merged",
    ]);
    const approval = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: "github:1" });
    const merge = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "pr_merged")!;
    expect(merge.actor).toEqual({ kind: "user", id: "github:1" });
    expect(item.token_cost).toBe(15 * 5);
    expect(await f.store.listHandoffs(item.id)).toHaveLength(2);
    expect(f.sandbox.destroyed).toBe(f.sandbox.created.length);
  });

  it("duplicate intake events create one work item and one triage run", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }) }));
    const e = { kind: "item_requested" as const, source: issueRef(1), requester: alice, title: "t", body: "b" };
    f.source.queue.push(e, e);
    await f.controller.tickIntake();
    f.source.queue.push(e);
    await f.controller.tickIntake();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#1"))!;
    expect(await f.store.listRuns(item.id)).toHaveLength(1);
  });

  it("raises the tier to the floor and never lowers it at review", async () => {
    const runner = new FakeRunner({
      triage: () => ({
        output: { ...triageSpec, allowed_paths: ["src/impl/broker/"], files_to_change: ["src/impl/broker/"], tier: 1 },
      }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: review("pass", 1),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(2), requester: alice, title: "t", body: "b" });
    await f.step();
    expect(f.source.comments[0]!.body).toContain(
      "### Please check\n- Tier raised from 1 to 4 because a path is under a floor.",
    );
    f.source.queue.push({ kind: "spec_approved", source: issueRef(2), comment_id: "103", approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#2"))!;
    expect(item.tier).toBe(4);
  });

  it("stops at max_loops and hands the item to a human", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
      review: review("bug"),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(3), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(3), comment_id: "104", approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#3"))!;
    expect(item).toMatchObject({ blocked_on: "human", blocked_reason: "max_loops", loop_count: 2 });
    expect(runner.specs.filter((s) => s.role === "implement")).toHaveLength(3);
  });

  it("a failed triage run is queued again by the factory after a backoff, with no /retry, and the item stays unblocked", async () => {
    let fail = true;
    const runner = new FakeRunner({
      triage: () => (fail ? { status: "failed", error: "boom" } : { output: triageSpec }),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(4), requester: alice, title: "t", body: "b" });
    await f.step();
    let item = (await f.store.getWorkItemBySource("github_issue", "o/r#4"))!;
    expect(item).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null, restart_count: 0 });
    const runs = await f.store.listRuns(item.id);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["triage", "failed"], ["triage", "queued"]]);
    expect(runs[1]!.not_before).toBe(new Date(f.clock.now().getTime() + config.retry_base_ms).toISOString());
    expect(f.source.comments).toEqual([]);

    fail = false;
    f.clock.advance(config.retry_base_ms);
    await f.step();
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "READY", restart_count: 0, blocked_reason: "spec_pending" });
  });

  it("after max_attempts a failed run blocks on a human; /retry re-runs it at once with restart_count + 1", async () => {
    let fail = true;
    const runner = new FakeRunner({
      triage: () => (fail ? { status: "failed", error: "boom" } : { output: triageSpec }),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(14), requester: alice, title: "t", body: "b" });
    await f.step();
    f.clock.advance(config.retry_max_ms);
    await f.step();
    f.clock.advance(config.retry_max_ms);
    await f.step();
    let item = (await f.store.getWorkItemBySource("github_issue", "o/r#14"))!;
    expect(item).toMatchObject({ stage: "NEW", blocked_on: "human", blocked_reason: "max_attempts" });
    expect(runner.specs).toHaveLength(config.max_attempts);

    fail = false;
    f.source.queue.push({ kind: "retry_requested", source: issueRef(14), comment_id: "105", requester: alice });
    await f.step(); // no clock advance: the human's retry does not wait
    item = (await f.store.getWorkItem(item.id))!;
    expect(item).toMatchObject({ stage: "READY", restart_count: 1, blocked_reason: "spec_pending" });
  });

  it("a triage output that lists a file outside allowed_paths fails the run and posts no spec", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: { ...triageSpec, files_to_change: [".github/workflows/scope.yml", "src/core/gate.ts"] } }),
    });
    const f = await factory(runner);
    f.source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#9"))!;
    expect(item).toMatchObject({ blocked_on: "none", restart_count: 0 });
    const runs = await f.store.listRuns(item.id);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["triage", "failed"], ["triage", "queued"]]);
    expect(runs[0]!.outcome).toMatchObject({ error_code: "invalid_output", infra: false });
    expect(f.source.comments.some((c) => c.body.includes("## Factory spec"))).toBe(false);
  });

  it("an implementer that makes no commits fails the run", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    });
    const f = await factory(runner);
    f.sandbox.commits = [];
    f.source.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "106", approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#5"))!;
    // A task failure: retried after a backoff, and restart_count is not touched.
    expect(item).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 0 });
    const runs = (await f.store.listRuns(item.id)).filter((r) => r.kind === "implement");
    expect(runs.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(runs[0]!.outcome).toMatchObject({ error_code: "no_commits", infra: false });
    expect(f.broker.calls.some((c) => c.name === "github.push_branch")).toBe(false);
  });

  it("an implement run that changes a file outside allowed_paths fails with scope_violation before any push", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    });
    const f = await factory(runner);
    f.sandbox.changedFiles = [".github/workflows/scope.yml", "src/core/worker.ts", "package.json"];
    f.source.queue.push({ kind: "item_requested", source: issueRef(11), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(11), comment_id: "111", approver: alice });
    await f.step();

    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#11"))!;
    expect(item).toMatchObject({ blocked_on: "none", restart_count: 0 });
    const run = (await f.store.listRuns(item.id)).find((r) => r.kind === "implement")!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation", infra: false });
    if (run.outcome?.status !== "failed") return;
    expect(run.outcome.detail).toContain("src/core/worker.ts");
    expect(run.outcome.detail).toContain("package.json");
    expect(run.outcome.detail).not.toContain(".github/workflows/scope.yml");

    const names = f.broker.calls.map((c) => c.name);
    expect(names).not.toContain("github.push_branch");
    expect(names).not.toContain("github.open_pr");
    expect(await f.store.listHandoffs(item.id)).toEqual([]);

    const comments = f.broker.calls.filter((c) => c.name === "github.comment");
    expect(comments).toHaveLength(1);
    const args = comments[0]!.args as { number: number; body: string; marker: string };
    expect(args.number).toBe(11);
    expect(args.body).toContain("- `src/core/worker.ts`");
    expect(args.body).toContain("- `package.json`");
    expect(args.marker).toBe(`<!-- factory:scope:${run.id} -->`);

    // The diff was taken against the base SHA resolved before the agent ran, over the whole branch.
    const resolve = f.sandbox.gitCalls.indexOf("rev-parse --verify --end-of-options origin/main^{commit}");
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(f.sandbox.gitCalls).toContain("diff --name-only -z --no-renames basesha...HEAD");
  });

  it("a scope violation whose issue comment fails still fails the run with scope_violation", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    });
    const f = await factory(runner);
    const call = f.broker.call.bind(f.broker);
    f.broker.call = async (ctx, name, args) => {
      if (name === "github.comment") {
        f.broker.calls.push({ ctx, name, args });
        return { ok: false, error_code: "egress_blocked", message: "blocked" };
      }
      return call(ctx, name, args);
    };
    f.sandbox.changedFiles = ["src/core/worker.ts"];
    f.source.queue.push({ kind: "item_requested", source: issueRef(12), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(12), comment_id: "112", approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#12"))!;
    expect((await f.store.listRuns(item.id)).find((r) => r.kind === "implement")!.outcome).toMatchObject({ error_code: "scope_violation" });
    expect(f.broker.calls.some((c) => c.name === "github.comment")).toBe(true);
    expect(f.broker.calls.some((c) => c.name === "github.push_branch")).toBe(false);
  });

  it("a scope violation detail is truncated to the 500-char outcome limit", async () => {
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    });
    const f = await factory(runner);
    f.sandbox.changedFiles = Array.from({ length: 100 }, (_, i) => `outside/file-${i}.ts`);
    f.source.queue.push({ kind: "item_requested", source: issueRef(13), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_approved", source: issueRef(13), comment_id: "113", approver: alice });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#13"))!;
    const run = (await f.store.listRuns(item.id)).find((r) => r.kind === "implement")!;
    if (run.outcome?.status !== "failed") throw new Error("expected failure");
    expect(run.outcome.error_code).toBe("scope_violation");
    expect(run.outcome.detail.length).toBeLessThanOrEqual(500);
    const body = (f.broker.calls.find((c) => c.name === "github.comment")!.args as { body: string }).body;
    expect(body).toContain("outside/file-99.ts");
  });

  it("a host sleep mid-implement does not lose the run: the worker renews, the reaper waits", async () => {
    let f!: Awaited<ReturnType<typeof factory>>;
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: async (spec) => {
        // The laptop sleeps: wall time jumps past lease_ms. Both loops tick after waking;
        // the controller's reaper happens to tick first.
        f.clock.advance(config.lease_ms + 30_000);
        const woke = f.clock.now().getTime();
        await f.controller.tickReaper();
        await waitFor(async () => {
          const run = (await f.store.getRun(spec.run_id))!;
          return run.status === "running" && new Date(run.lease!.expires_at).getTime() === woke + config.lease_ms;
        }, "worker renewal after wake");
        await f.controller.tickReaper();
        return { output: { summary: "added gate", next_steps: "none" } };
      },
      review: review("pass"),
    });
    f = await factory(runner);
    const src = issueRef(8);
    const step = async () => {
      await f.controller.tickReaper();
      await f.step();
      await f.controller.tickReaper();
    };

    f.source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    f.source.queue.push({ kind: "spec_approved", source: src, comment_id: "107", approver: alice });
    await step();

    const item = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 });
    const runs = await f.store.listRuns(item.id);
    expect(runs.map((r) => r.kind)).toEqual(["triage", "implement", "review"]);
    expect(runs.every((r) => r.attempt === 1 && r.status === "succeeded")).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("lease_expired");
    expect(f.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr", "github.comment"]);
  });

  it("spec rejection closes the item", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }) }));
    f.source.queue.push({ kind: "item_requested", source: issueRef(6), requester: alice, title: "t", body: "b" });
    await f.step();
    f.source.queue.push({ kind: "spec_rejected", source: issueRef(6), comment_id: "108", approver: alice, reason: "no" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", "o/r#6"))!;
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });
});

describe("acknowledging commands and intake", () => {
  /** An item at the spec gate: intake + triage done. */
  async function atSpecGate(n: number, log?: Logger) {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }) }), [], log);
    const src = issueRef(n);
    f.source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    return { ...f, src, item };
  }
  const refusals = (f: { source: FakeSource }) => f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:refused:"));
  const reasons = async (f: Awaited<ReturnType<typeof atSpecGate>>) =>
    (await f.store.listStateChanges(f.item.id)).map((c) => c.reason);

  it("issue intake leaves 👀 on the issue", async () => {
    const f = await atSpecGate(20);
    expect(f.source.reactions).toEqual([{ source: f.src, comment_id: null }]);
  });

  it("/approve leaves exactly one 👀 on that comment after spec_approved", async () => {
    const f = await atSpecGate(21);
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "500", approver: alice });
    await f.controller.tickIntake();
    expect(f.source.reactions.filter((r) => r.comment_id === "500")).toHaveLength(1);
    expect((await f.store.getWorkItem(f.item.id))!.stage).toBe("RUNNING");
    expect(refusals(f)).toEqual([]);
  });

  it("the same command comment delivered again leaves one reaction, one transition and no refusal", async () => {
    const f = await atSpecGate(22);
    const e = { kind: "spec_approved" as const, source: f.src, comment_id: "501", approver: alice };
    f.source.queue.push(e);
    await f.controller.tickIntake();
    f.source.queue.push(e); // a later poll returns the last comment again (updated_at + since)
    await f.controller.tickIntake();
    f.source.queue.push(e, e); // and twice in one poll
    await f.controller.tickIntake();
    expect(f.source.reactions.filter((r) => r.comment_id === "501")).toHaveLength(1);
    expect((await reasons(f)).filter((r) => r === "spec_approved")).toHaveLength(1);
    expect(refusals(f)).toEqual([]);
  });

  it("/approve from a user without write permission leaves 👀 and one explanation, no transition", async () => {
    const f = await atSpecGate(23);
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "502", approver: mallory });
    await f.controller.tickIntake();
    expect(f.source.reactions.filter((r) => r.comment_id === "502")).toHaveLength(1);
    expect(refusals(f)).toHaveLength(1);
    expect(refusals(f)[0]).toMatchObject({ source: f.src, marker: "<!-- factory:refused:502 -->" });
    expect(refusals(f)[0]!.body).toContain("write permission");
    expect(await f.store.getWorkItem(f.item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("/approve on a RUNNING item leaves 👀 and one explanation", async () => {
    const f = await atSpecGate(24);
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "503", approver: alice });
    await f.controller.tickIntake();
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "504", approver: alice });
    await f.controller.tickIntake();
    expect(f.source.reactions.filter((r) => r.comment_id === "504")).toHaveLength(1);
    expect(refusals(f)).toHaveLength(1);
    expect(refusals(f)[0]!.marker).toBe("<!-- factory:refused:504 -->");
    expect(refusals(f)[0]!.body).toContain("RUNNING");
    expect((await reasons(f)).filter((r) => r === "spec_approved")).toHaveLength(1);
  });

  it("/approve on a CLOSED item and /retry with no failed run are refused with a reason", async () => {
    const f = await atSpecGate(25);
    f.source.queue.push({ kind: "retry_requested", source: f.src, comment_id: "505", requester: alice });
    await f.controller.tickIntake();
    f.source.queue.push({ kind: "spec_rejected", source: f.src, comment_id: "506", approver: alice, reason: "no" });
    await f.controller.tickIntake();
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "507", approver: alice });
    await f.controller.tickIntake();
    expect(refusals(f).map((c) => c.marker)).toEqual(["<!-- factory:refused:505 -->", "<!-- factory:refused:507 -->"]);
    expect(refusals(f)[0]!.body).toContain("no failed run");
    expect(refusals(f)[1]!.body).toContain("closed");
    expect(f.source.reactions.map((r) => r.comment_id)).toEqual([null, "505", "506", "507"]);
    expect(await f.store.getWorkItem(f.item.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });

  it("a command on an issue that is not a factory work item gets no reaction and no reply", async () => {
    const f = await factory(new FakeRunner({}));
    f.source.queue.push({ kind: "spec_approved", source: issueRef(26), comment_id: "508", approver: mallory });
    await f.controller.tickIntake();
    expect(f.source.reactions).toEqual([]);
    expect(f.source.comments).toEqual([]);
  });

  it("a reaction call that throws still applies the transition and logs a warning", async () => {
    const log = recordingLog();
    const f = await atSpecGate(27, log);
    f.source.reactionError = new Error("GitHub POST reactions → 502");
    f.source.queue.push({ kind: "spec_approved", source: f.src, comment_id: "509", approver: alice });
    f.source.queue.push({ kind: "item_requested", source: issueRef(28), requester: alice, title: "t", body: "b" });
    await f.controller.tickIntake();
    expect((await f.store.getWorkItem(f.item.id))!.stage).toBe("RUNNING");
    expect(await f.store.getWorkItemBySource("github_issue", issueRef(28).id)).not.toBeNull();
    const warns = log.lines.filter((l) => l.level === "warn" && l.msg === "mark seen failed");
    expect(warns).toHaveLength(2);
    expect(log.lines.some((l) => l.level === "error")).toBe(false);
  });
});
