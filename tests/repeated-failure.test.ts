import { describe, expect, it } from "vitest";
import { commandState, commandsFor } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { repeatsFastInfraFailure } from "../src/core/policy.js";
import type { Run, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { badgesOf, levelOf } from "../src/ui/priority.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";

// Design §5 Restarts (issue #216): an infra failure that repeats the step's previous run (same infra code, same
// detail, both runs finished within 60 s of their start) blocks at once with `repeated_failure`, no retry queued.

const done = { output: { summary: "s", next_steps: "n" } };
const pass = { output: { verdict: "pass", tier: 2, findings: [], summary: "s" } };
const timedOut = (error: string, transcript = "the last output line"): Partial<AgentRunResult> => ({ status: "timed_out", error, transcript });

/** Flags any comment that contains `SECRETX`, as a leak scanner would. */
const flagging: EgressScanner = {
  scan: async (_c, text) => (text.includes("SECRETX") ? { clean: false, findings: [{ rule: "test" }] } : { clean: true, findings: [] }) as never,
};

async function factory(implement: (n: number) => Partial<AgentRunResult>, opts: { scanner?: EgressScanner; slowMs?: number } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  let n = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => {
      if (opts.slowMs) clock.advance(opts.slowMs);
      return implement(n++);
    },
    review: () => pass,
  });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: opts.scanner ?? cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config, prompts,
    log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let c = 0;
  const next = () => String(9000 + ++c);
  const src = issueRef(7);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
  await step();
  source.queue.push({ kind: "spec_approved", source: src, comment_id: next(), approver: alice });
  await step();
  const it0 = (await store.getWorkItemBySource("github_issue", src.id))!;
  const item = async () => (await store.getWorkItem(it0.id))!;
  const runs = async (kind?: Run["kind"]) => (await store.listRuns(it0.id)).filter((r) => !kind || r.kind === kind);
  const queued = async () => (await runs()).filter((r) => r.status === "queued");
  const comments = () => source.comments.filter((x) => x.body.includes("the same infrastructure failure twice"));
  const retry = () => source.queue.push({ kind: "retry_requested", source: src, comment_id: next(), requester: alice } as never);
  /** Lets the queued retry's backoff pass, then runs it. */
  const again = async () => {
    clock.advance(config.retry_max_ms);
    await step();
  };
  return { clock, store, controller, step, again, item, runs, queued, comments, retry, it0 };
}

describe("the repeated infra failure block", () => {
  it("two identical fast infra failures: the second blocks with repeated_failure, restart_count +1, no retry queued", async () => {
    const f = await factory(() => timedOut("the agent ran out of time"));
    expect(await f.item()).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 1 });
    expect((await f.queued()).map((r) => r.kind)).toEqual(["implement"]);
    await f.again();
    expect(await f.item()).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "repeated_failure", restart_count: 2 });
    expect(await f.runs("implement")).toHaveLength(2);
    expect(await f.queued()).toEqual([]);
    expect((await f.store.listStateChanges(f.it0.id)).at(-1)).toMatchObject({ reason: "repeated_failure" });

    // One comment: the code, the detail and the output tail of the last run.
    expect(f.comments()).toHaveLength(1);
    const body = f.comments()[0]!.body;
    expect(body).toContain("`agent_timed_out`");
    expect(body).toContain("the agent ran out of time");
    expect(body).toContain("the last output line");
    expect(body).toContain("`/retry`");
    // Applying the same run again changes nothing and posts nothing new.
    await f.controller.applyRun((await f.runs("implement")).at(-1)!);
    expect(f.comments()).toHaveLength(1);
    expect(await f.queued()).toEqual([]);
  });

  it("a different detail retries as before", async () => {
    const f = await factory((n) => timedOut(`attempt ${n}`));
    await f.again();
    expect(await f.item()).toMatchObject({ blocked_on: "none", restart_count: 2 });
    expect((await f.queued()).map((r) => r.kind)).toEqual(["implement"]);
    expect(f.comments()).toHaveLength(0);
  });

  it("a run that took 60 seconds or more retries as before, up to max_restart", async () => {
    const f = await factory(() => timedOut("the agent ran out of time"), { slowMs: 60_000 });
    await f.again();
    expect(await f.item()).toMatchObject({ blocked_on: "none", restart_count: 2 });
    expect((await f.queued()).map((r) => r.kind)).toEqual(["implement"]);
    await f.again();
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "max_restart" });
    expect(f.comments()).toHaveLength(0);
  });

  it("the detail is dropped from the comment when the egress scan flags it; the item still blocks", async () => {
    const f = await factory(() => timedOut("token SECRETX leaked", "tail without it"), { scanner: flagging });
    await f.again();
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "repeated_failure" });
    expect(f.comments()).toHaveLength(1);
    expect(f.comments()[0]!.body).not.toContain("SECRETX");
    expect(f.comments()[0]!.body).toContain("`agent_timed_out`");
    expect(f.comments()[0]!.body).toContain("tail without it");
  });

  it("/retry is accepted and starts the step afresh; the status page lists it under failed", async () => {
    let n = 0;
    const f = await factory(() => (n++ < 2 ? timedOut("same") : done));
    await f.again();
    const blocked = await f.item();
    expect(blocked).toMatchObject({ blocked_reason: "repeated_failure", restart_count: 2 });
    expect(commandsFor(commandState(blocked, "implement")).map((c) => c.name)).toContain("retry");

    const input = { ...blocked, since: blocked.updated_at, run: null, dependents: 0, waiting_on: 0 };
    const now = f.clock.now();
    expect(badgesOf(input, levelOf(input, now, config.lease_ms), now, config.lease_ms)).toEqual(["failed"]);

    f.retry();
    await f.step();
    expect(await f.item()).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", restart_count: 3 });
  });
});

describe("repeatsFastInfraFailure", () => {
  const t0 = Date.parse("2026-11-07T00:00:00.000Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const run = (id: string, outcome: Record<string, unknown> | null, start = 0, took = 1): Pick<Run, "id" | "outcome" | "started_at" | "finished_at"> =>
    ({ id, outcome, started_at: at(start), finished_at: at(start + took) }) as never;
  const infra = (code = "git_failed", detail = "git merge: boom") => ({ status: "failed", error_code: code, detail, infra: true });

  it("needs the previous run of the step to fail with the same infra code and detail, both within 60 s", () => {
    const a = run("1", infra(), 0);
    const b = run("2", infra(), 100);
    expect(repeatsFastInfraFailure([a, b], b)).toBe(true);
    expect(repeatsFastInfraFailure([b], b)).toBe(false);
    expect(repeatsFastInfraFailure([a, run("2", infra("git_failed", "other"), 100)], run("2", infra("git_failed", "other"), 100))).toBe(false);
    expect(repeatsFastInfraFailure([a, run("2", infra("exception"), 100)], run("2", infra("exception"), 100))).toBe(false);
    const slow = run("1", infra(), 0, 60);
    expect(repeatsFastInfraFailure([slow, b], b)).toBe(false);
    const slowB = run("2", infra(), 100, 60);
    expect(repeatsFastInfraFailure([a, slowB], slowB)).toBe(false);
    expect(repeatsFastInfraFailure([a, run("2", infra(), 100, 59.999)], run("2", infra(), 100, 59.999))).toBe(true);
  });

  it("only infra failures: task failures, rate limits, stalls and preflight_access never trigger it", () => {
    const task = { status: "failed", error_code: "push_failed", detail: "d", infra: false };
    expect(repeatsFastInfraFailure([run("1", task), run("2", task)], run("2", task))).toBe(false);
    for (const code of ["rate_limited", "agent_stalled", "preflight_access"]) {
      const o = { status: "failed", error_code: code, detail: "d", infra: true };
      expect(repeatsFastInfraFailure([run("1", o), run("2", o)], run("2", o))).toBe(false);
    }
    // The previous run of the step must be the infra failure itself, not an older one.
    const between = run("2", task, 50);
    const c = run("3", infra(), 100);
    expect(repeatsFastInfraFailure([run("1", infra()), between, c], c)).toBe(false);
  });

  it("an empty detail is not compared: it says nothing about the cause", () => {
    const a = run("1", infra("agent_timed_out", ""), 0);
    const b = run("2", infra("agent_timed_out", ""), 100);
    expect(repeatsFastInfraFailure([a, b], b)).toBe(false);
  });

  it("a run with no start time is not compared", () => {
    const a = { ...run("1", infra()), started_at: null };
    const b = run("2", infra(), 100);
    expect(repeatsFastInfraFailure([a, b], b)).toBe(false);
  });
});
