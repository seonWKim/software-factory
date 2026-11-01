import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { Run, WorkItem, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, config as baseConfig, gates, issueRef, prompts, recordingLog, settingsWith, triageSpec,
} from "./helpers/fakes.js";

// Design §5 Restarts: automatic retry with backoff, the rate-limit pause, infra vs task budgets.

type Outcome = Partial<AgentRunResult> | (() => never);
const BASE = baseConfig.retry_base_ms;
const MAX = baseConfig.retry_max_ms;

async function factory(opts: {
  triage?: () => Outcome;
  implement?: () => Outcome;
  review?: () => Outcome;
  config?: Partial<FactoryConfig>;
  scanner?: EgressScanner;
}) {
  // spec_gate_min_tier 3: a tier-2 triage is auto-approved, so implement and review follow at once.
  const config: FactoryConfig = { ...baseConfig, dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 }, ...opts.config };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const call = (fn: (() => Outcome) | undefined, ok: Partial<AgentRunResult>) => () => {
    const r = fn?.() ?? ok;
    if (typeof r === "function") return r();
    return r;
  };
  const runner = new FakeRunner({
    triage: call(opts.triage, { output: triageSpec }),
    implement: call(opts.implement, { output: { summary: "s", next_steps: "n" } }),
    review: call(opts.review, { output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const log = recordingLog();
  const scanner = new PatternEgressScanner(async () => []);
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner: opts.scanner ?? scanner });
  const worker = (id: string) =>
    new Worker({
      id: id as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
  const w1 = worker("w1");
  const w2 = worker("w2");
  let n = 0;
  const submit = async () => {
    n++;
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  /** Workers take what they may claim now; the controller applies every outcome. */
  const step = async () => {
    while ((await w1.tick()) || (await w2.tick())) await controller.tickRuns();
    await controller.tickRuns();
  };
  const item = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const runs = async (it: WorkItem, kind?: Run["kind"]) => (await store.listRuns(it.id)).filter((r) => !kind || r.kind === kind);
  return { config, clock, store, source, runner, log, controller, w1, w2, submit, step, item, runs };
}

const failed = (): Outcome => ({ status: "failed", error: "boom", transcript: "agent said: the tests did not pass" });
const rateLimited = (reset_at?: string): Outcome => ({ status: "rate_limited", error: "usage limit", ...(reset_at ? { reset_at } : {}) });
const iso = (ms: number) => new Date(ms).toISOString();

describe("automatic retry", () => {
  it("triage, implement and review failures are each queued again with blocked_on none", async () => {
    for (const kind of ["triage", "implement", "review"] as const) {
      let fails = 1;
      const f = await factory({ [kind]: () => (fails-- > 0 ? failed() : undefined) } as never);
      const it0 = await f.submit();
      await f.step();
      const it1 = await f.item(it0);
      expect(it1.blocked_on).toBe("none");
      expect((await f.runs(it0, kind)).map((r) => r.status)).toEqual(["failed", "queued"]);
      f.clock.advance(BASE);
      await f.step();
      expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    }
  });

  it("the next attempt is not claimed 1 ms before failure + retry_base_ms × 2^(attempt−1), by either worker, and is claimed at it", async () => {
    const f = await factory({ triage: failed, config: { settings: settingsWith({ max_attempts: 5 }) } });
    const it0 = await f.submit();
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Claimed (by w1, then by w2) exactly at the earliest start.
      expect(await (attempt % 2 ? f.w1 : f.w2).tick()).toBe(true);
      const failedAt = f.clock.now().getTime();
      await f.controller.tickRuns();
      const wait = BASE * 2 ** (attempt - 1);
      expect((await f.runs(it0)).at(-1)).toMatchObject({ status: "queued", not_before: iso(failedAt + wait) });
      f.clock.advance(wait - 1);
      expect(await f.w1.tick()).toBe(false);
      expect(await f.w2.tick()).toBe(false);
      f.clock.advance(1);
    }
    expect(await f.runs(it0)).toHaveLength(4);
  });

  it("the wait never exceeds retry_max_ms", async () => {
    const f = await factory({ triage: failed, config: { settings: settingsWith({ max_attempts: 40 }) } });
    const it0 = await f.submit();
    for (let i = 0; i < 12; i++) {
      await f.step();
      f.clock.advance(MAX);
    }
    await f.step();
    const all = await f.runs(it0);
    expect(all.length).toBe(14);
    const last = all.at(-1)!;
    const prev = all.at(-2)!;
    expect(Date.parse(last.not_before!) - Date.parse(prev.finished_at!)).toBe(MAX);
    expect(Math.max(...all.slice(1).map((r, i) => Date.parse(r.not_before!) - Date.parse(all[i]!.finished_at!)))).toBe(MAX);
  });

  it("a run whose lease expired gets the same backoff before it is claimed again", async () => {
    const f = await factory({});
    const it0 = await f.submit();
    const run = (await f.store.claimRun({ worker_id: "gone" as WorkerId, kinds: ["triage"], lease_ms: f.config.lease_ms }))!;
    f.clock.advance(f.config.lease_ms + 1);
    await f.controller.tickReaper();
    const requeued = (await f.store.getRun(run.id))!;
    expect(requeued).toMatchObject({ status: "queued", not_before: iso(f.clock.now().getTime() + BASE) });
    f.clock.advance(BASE - 1);
    expect(await f.w2.tick()).toBe(false);
    f.clock.advance(1);
    expect(await f.w2.tick()).toBe(true);
    await f.controller.tickRuns();
    expect((await f.item(it0)).stage).toBe("RUNNING");
  });

  it("applying the same finished run twice creates one retry run", async () => {
    const f = await factory({ triage: failed });
    const it0 = await f.submit();
    await f.w1.tick();
    const [done] = await f.store.listUnacknowledgedRuns(10);
    await Promise.all([f.controller.applyRun(done!), f.controller.applyRun(done!)]);
    await f.controller.applyRun(done!);
    const all = await f.runs(it0);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.idempotency_key)).size).toBe(2);
    expect(all[1]!.idempotency_key).toBe(`${all[0]!.idempotency_key}:a1`);
  });
});

describe("infra vs task failures", () => {
  const cases: [string, () => Outcome, number][] = [
    ["lease loss", () => ({ status: "aborted" }), 1],
    ["timeout", () => ({ status: "timed_out" }), 1],
    ["exception", () => () => { throw new Error("worker crashed"); }, 1],
    ["agent error", failed, 0],
    ["invalid output", () => ({ output: { nope: true } }), 0],
  ];
  for (const [name, outcome, restarts] of cases) {
    it(`${name}: restart_count + ${restarts}`, async () => {
      const f = await factory({ triage: outcome });
      const it0 = await f.submit();
      await f.step();
      expect(await f.item(it0)).toMatchObject({ restart_count: restarts, blocked_on: "none" });
    });
  }

  it("no commits does not count as a restart", async () => {
    const f = await factory({});
    const it0 = await f.submit();
    // FakeSandbox commits are per worker sandbox; make both report none.
    for (const w of [f.w1, f.w2]) ((w as unknown as { d: { sandbox: FakeSandbox } }).d.sandbox).commits = [];
    await f.step();
    expect((await f.runs(it0, "implement"))[0]!.outcome).toMatchObject({ error_code: "no_commits" });
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", restart_count: 0, blocked_on: "none" });
  });

  it("task failures stop at max_attempts with blocked_reason max_attempts", async () => {
    const f = await factory({ implement: failed });
    const it0 = await f.submit();
    for (let i = 0; i < 5; i++) {
      await f.step();
      f.clock.advance(MAX);
    }
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts", restart_count: 0 });
    expect(await f.runs(it0, "implement")).toHaveLength(gates(f.config).max_attempts);
    const changes = (await f.store.listStateChanges(it0.id)).map((c) => c.reason);
    expect(changes.filter((r) => r === "run_retry_scheduled")).toHaveLength(2);
    expect(changes.at(-1)).toBe("max_attempts");
  });

  it("infra failures stop at max_restart with blocked_reason max_restart", async () => {
    const f = await factory({ review: () => ({ status: "timed_out" }), config: { settings: settingsWith({ max_attempts: 10 }), max_restart: 2 } });
    const it0 = await f.submit();
    for (let i = 0; i < 5; i++) {
      await f.step();
      f.clock.advance(MAX);
    }
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "max_restart", restart_count: 2 });
    expect(await f.runs(it0, "review")).toHaveLength(2);
  });
});

describe("the last-attempt comment", () => {
  it("says what failed in plain words, with the error code and the output tail", async () => {
    const f = await factory({ triage: failed });
    const it0 = await f.submit();
    for (let i = 0; i < 3; i++) {
      await f.step();
      f.clock.advance(MAX);
    }
    expect((await f.item(it0)).blocked_reason).toBe("max_attempts");
    expect(f.source.comments).toHaveLength(1);
    const body = f.source.comments[0]!.body;
    expect(body).toContain("The triage run failed 3 times");
    expect(body).toContain("`agent_failed`");
    expect(body).toContain("the agent exited with an error");
    expect(body).toContain("agent said: the tests did not pass");
    expect(body).toContain("`/retry`");
  });

  it("is not posted when the egress scanner blocks it; the item still blocks on a human", async () => {
    // The output tail holds a known secret value, so G5 blocks the whole comment.
    const f = await factory({ triage: failed, scanner: new PatternEgressScanner(async () => ["the tests did not pass"]) });
    const it0 = await f.submit();
    for (let i = 0; i < 3; i++) {
      await f.step();
      f.clock.advance(MAX);
    }
    expect(f.source.comments).toEqual([]);
    expect(await f.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
    expect(f.log.lines.some((l) => l.msg.includes("egress scan"))).toBe(true);
  });
});

describe("rate limits", () => {
  it("are not attempts and do not add to restart_count; the retry starts at the reset time", async () => {
    let limits = 5;
    const reset = () => iso(f.clock.now().getTime() + 10 * 60_000);
    const f = await factory({ triage: () => (limits-- > 0 ? rateLimited(reset()) : undefined) as Outcome, config: { settings: settingsWith({ max_attempts: 1 }) } });
    const it0 = await f.submit();
    for (let i = 0; i < 5; i++) {
      await f.step();
      const next = (await f.runs(it0)).at(-1)!;
      expect(next).toMatchObject({ status: "queued", not_before: iso(f.clock.now().getTime() + 10 * 60_000) });
      expect(await f.item(it0)).toMatchObject({ blocked_on: "none", restart_count: 0 });
      f.clock.advance(10 * 60_000);
    }
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", restart_count: 0 });
  });

  it("pause every claim, for every work item and worker, until the reset time, and log once when work resumes", async () => {
    let limited = true;
    const f = await factory({ triage: () => (limited ? rateLimited(iso(f.clock.now().getTime() + 5 * 60_000)) : undefined) as Outcome });
    const a = await f.submit();
    await f.w1.tick(); // a's triage hits the limit
    limited = false;
    const b = await f.submit(); // another work item, queued now with no wait of its own
    await f.controller.tickRuns();
    f.clock.advance(5 * 60_000 - 1);
    expect(await f.w1.tick()).toBe(false);
    expect(await f.w2.tick()).toBe(false);
    expect((await f.runs(b)).map((r) => r.status)).toEqual(["queued"]);
    f.clock.advance(1);
    expect(await f.w2.tick()).toBe(true);
    await f.step();
    expect((await f.item(a)).stage).toBe("REVIEW");
    expect((await f.item(b)).stage).toBe("REVIEW");
    const lines = f.log.lines.filter((l) => l.msg.startsWith("rate limited"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain(`work resumes at ${iso(Date.parse("2026-01-01T00:00:00.000Z") + 5 * 60_000)}`);
  });

  it("with no reset time, the pause lasts retry_max_ms", async () => {
    let limited = true;
    const f = await factory({ triage: () => (limited ? rateLimited() : undefined) as Outcome });
    const a = await f.submit();
    const start = f.clock.now().getTime();
    await f.w1.tick();
    limited = false;
    await f.controller.tickRuns();
    expect(await f.store.getClaimPause()).toBe(iso(start + MAX));
    expect((await f.runs(a)).at(-1)!.not_before).toBe(iso(start + MAX));
    f.clock.advance(MAX - 1);
    expect(await f.w1.tick()).toBe(false);
    expect(await f.w2.tick()).toBe(false);
    f.clock.advance(1);
    expect(await f.w2.tick()).toBe(true);
  });
});

describe("/retry", () => {
  it("on an item blocked at max_restart queues the run at once, ignoring any wait", async () => {
    let timeouts = 1;
    const f = await factory({ triage: () => (timeouts-- > 0 ? { status: "timed_out" } : undefined) as Outcome, config: { max_restart: 1 } });
    const it0 = await f.submit();
    await f.step();
    expect(await f.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_restart", restart_count: 1 });
    f.source.queue.push({ kind: "retry_requested", source: it0.source, comment_id: "900", requester: alice });
    await f.controller.tickIntake();
    const queued = (await f.runs(it0)).at(-1)!;
    expect(queued).toMatchObject({ status: "queued", not_before: null });
    expect(await f.item(it0)).toMatchObject({ blocked_on: "none", restart_count: 2 });
    await f.step();
    expect((await f.item(it0)).stage).toBe("REVIEW");
  });

  it("on an item waiting out a backoff (no failed run blocking it) is refused with the existing reason", async () => {
    const f = await factory({ triage: failed });
    const it0 = await f.submit();
    await f.step();
    f.source.queue.push({ kind: "retry_requested", source: it0.source, comment_id: "901", requester: alice });
    await f.controller.tickIntake();
    expect(f.source.comments.at(-1)!.body).toContain("there is no failed run to retry");
  });
});

