import { describe, expect, it } from "vitest";
import { commandState, commandsFor } from "../src/core/commands.js";
import { Controller } from "../src/core/controller.js";
import { IMPLEMENT_SCHEMA, NEEDS_HUMAN_MAX_CHARS, REVIEW_SCHEMA, parseImplement, parseReview } from "../src/core/outputs.js";
import { blockingRunKind, failureLine, repeatsLastFailure } from "../src/core/policy.js";
import { type Run, type WorkerId, type WorkItem, outcomeTokens } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, gates, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";

// The agent's needs_human answer and the repeated-failure rule (design §5 Restarts, decided 2026-11-07).

const ASK = { reason: "The push token has no write access to this repository.", question: "Can you grant the factory app write access?" };
const done = { output: { summary: "s", next_steps: "n" } };
const pass = { output: { verdict: "pass", tier: 2, findings: [], summary: "s" } };

async function factory(runner: FakeRunner, opts: { repeated?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const scanner = new PatternEgressScanner(async () => []);
  const controller = new Controller({
    store, source, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: opts.repeated ?? true,
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent, scanner,
    toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const next = () => String(9000 + ++n);
  /** A new item through triage and /approve; the implement run has run once. */
  const approved = async (issue: number): Promise<WorkItem> => {
    const src = issueRef(issue);
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: next(), approver: alice });
    await step();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  const item = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const runs = async (it: WorkItem, kind?: Run["kind"]) => (await store.listRuns(it.id)).filter((r) => !kind || r.kind === kind);
  const queued = async (it: WorkItem) => (await runs(it)).filter((r) => r.status === "queued");
  const asks = () => source.comments.filter((c) => c.marker.startsWith("<!-- factory:needs-human:"));
  const command = (it: WorkItem, e: Record<string, unknown>) =>
    source.queue.push({ source: it.source, comment_id: next(), requester: alice, approver: alice, ...e } as never);
  return { clock, store, source, sandbox, broker, controller, worker, step, approved, item, runs, queued, asks, command };
}

describe("needs_human output validation", () => {
  it("implement: with needs_human, summary and next_steps may be left out; without it, both are required as before", () => {
    expect(parseImplement({ needs_human: ASK })).toEqual({ ok: true, value: { summary: "", next_steps: "", needs_human: ASK } });
    expect(parseImplement({ summary: "s", next_steps: "n", needs_human: ASK })).toMatchObject({ ok: true, value: { summary: "s", needs_human: ASK } });
    expect(parseImplement({ summary: "s", next_steps: "n" })).toEqual({ ok: true, value: { summary: "s", next_steps: "n" } });
    expect(parseImplement({ summary: "s" }).ok).toBe(false);
    expect(parseImplement({ summary: "s", next_steps: "n", needs_human: null })).toEqual({ ok: true, value: { summary: "s", next_steps: "n" } });
  });

  it("a missing, empty or over-500-character reason or question is invalid", () => {
    const long = "x".repeat(NEEDS_HUMAN_MAX_CHARS + 1);
    for (const bad of [{ reason: "r" }, { question: "q" }, { reason: "", question: "q" }, { reason: "r", question: "  " }, { reason: long, question: "q" }, { reason: "r", question: long }, "help"]) {
      expect(parseImplement({ summary: "s", next_steps: "n", needs_human: bad }).ok).toBe(false);
      expect(parseReview({ ...pass.output, needs_human: bad }).ok).toBe(false);
    }
    expect(parseImplement({ needs_human: { reason: "x".repeat(NEEDS_HUMAN_MAX_CHARS), question: "q" } }).ok).toBe(true);
  });

  it("review: needs_human is optional next to the usual fields", () => {
    expect(parseReview({ ...pass.output, needs_human: ASK })).toMatchObject({ ok: true, value: { verdict: "pass", needs_human: ASK } });
    expect(parseReview(pass.output)).toEqual({ ok: true, value: pass.output });
  });

  it("the implement and review schemas offer needs_human { reason, question }", () => {
    for (const schema of [IMPLEMENT_SCHEMA, REVIEW_SCHEMA]) {
      expect(schema.properties.needs_human).toMatchObject({ required: ["reason", "question"], additionalProperties: false });
    }
    expect(REVIEW_SCHEMA.required).toEqual(["verdict", "tier", "findings", "summary"]);
  });
});

describe("an implement run that returns needs_human", () => {
  it("blocks on a human with agent_needs_human, queues nothing, pushes nothing, opens no PR, and adds its tokens", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => ({ output: { needs_human: ASK } }) }));
    const it0 = await f.approved(1);
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human", pr_number: null });
    expect(await f.queued(it0)).toEqual([]);
    expect(await f.runs(it0, "implement")).toHaveLength(1);
    expect(f.broker.calls.map((c) => c.name)).not.toContain("github.push_branch");
    expect(f.broker.calls.map((c) => c.name)).not.toContain("github.open_pr");
    // The run's tokens count, as for any finished run.
    const total = (await f.runs(it0)).reduce((sum, r) => sum + outcomeTokens(r.outcome), 0);
    expect(total).toBeGreaterThan(0);
    expect((await f.item(it0)).token_cost).toBe(total);
    const changes = await f.store.listStateChanges(it0.id);
    expect(changes.at(-1)).toMatchObject({ reason: "agent_needs_human", detail: { run_kind: "implement" } });
  });

  it("posts one comment with the reason, the question and the footer listing /retry, /revise and /reject", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => ({ output: { needs_human: ASK } }) }));
    const it0 = await f.approved(2);
    expect(f.asks()).toHaveLength(1);
    const body = f.asks()[0]!.body;
    expect(body).toContain(`> ${ASK.reason}`);
    expect(body).toContain(`> ${ASK.question}`);
    expect(body).toContain("Commands you can reply with now:");
    for (const c of ["`/retry`", "`/revise <feedback>`", "`/reject <reason>`"]) expect(body).toContain(c);
    expect(body).not.toContain("`/resolve");
    expect((await f.item(it0)).failure_comment_url).toBe(f.asks()[0]!.url);
  });

  it("applying the same finished run twice posts one comment and queues nothing", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => ({ output: { needs_human: ASK } }) }));
    const it0 = await f.approved(3);
    const run = (await f.runs(it0, "implement"))[0]!;
    const before = await f.item(it0);
    await f.controller.applyRun(run);
    await f.controller.applyRun({ ...run, acknowledged_at: null });
    expect(f.asks()).toHaveLength(1);
    expect(await f.queued(it0)).toEqual([]);
    expect(await f.item(it0)).toMatchObject({ version: before.version, token_cost: before.token_cost });
  });

  it("/retry queues a new implement run and clears the block; the run goes on to review", async () => {
    let ask = true;
    const f = await factory(new FakeRunner({
      triage: () => ({ output: triageSpec }), implement: () => (ask ? { output: { needs_human: ASK } } : done), review: () => pass,
    }));
    const it0 = await f.approved(4);
    ask = false;
    f.command(it0, { kind: "retry_requested" });
    await f.controller.tickIntake();
    const retried = await f.item(it0);
    expect(retried).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: 1 });
    expect((await f.queued(it0)).map((r) => r.kind)).toEqual(["implement"]);
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: 42 });
  });

  it("/revise <feedback> starts a new triage with the feedback; /reject <reason> closes the item", async () => {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => ({ output: { needs_human: ASK } }) }));
    const a = await f.approved(5);
    f.command(a, { kind: "revise_requested", feedback: "use the existing token" });
    await f.controller.tickIntake();
    expect(await f.item(a)).toMatchObject({ stage: "NEW", blocked_on: "none", spec_feedback: "use the existing token", revision_count: 1 });
    expect((await f.queued(a)).map((r) => r.kind)).toEqual(["triage"]);

    const b = await f.approved(6);
    f.command(b, { kind: "spec_rejected", reason: "not now" });
    await f.controller.tickIntake();
    expect(await f.item(b)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect(f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:refused:"))).toEqual([]);
  });

  it("a needs_human answer with an over-long question is invalid output and retried like any other", async () => {
    const f = await factory(new FakeRunner({
      triage: () => ({ output: triageSpec }),
      implement: () => ({ output: { needs_human: { reason: "r", question: "q".repeat(NEEDS_HUMAN_MAX_CHARS + 1) } } }),
    }));
    const it0 = await f.approved(7);
    const [run, retry] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "invalid_output", infra: false });
    expect(retry).toMatchObject({ status: "queued" });
    expect(await f.item(it0)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(f.asks()).toEqual([]);
  });
});

describe("a review run that returns needs_human", () => {
  it("blocks the item the same way, posts no review, and /retry runs review again", async () => {
    let ask = true;
    const f = await factory(new FakeRunner({
      triage: () => ({ output: triageSpec }), implement: () => done,
      review: () => (ask ? { output: { ...pass.output, needs_human: ASK } } : pass),
    }));
    const it0 = await f.approved(8);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "agent_needs_human", pr_number: 42 });
    expect(await f.queued(it0)).toEqual([]);
    expect(f.broker.calls.some((c) => JSON.stringify(c.args).includes("factory:review:"))).toBe(false);
    expect(f.asks()).toHaveLength(1);
    expect(f.asks()[0]!.body).toContain("The review run stopped");
    expect(f.asks()[0]!.body).toContain("`/retry`");

    ask = false;
    f.command(it0, { kind: "retry_requested" });
    await f.controller.tickIntake();
    expect((await f.queued(it0)).map((r) => r.kind)).toEqual(["review"]);
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    expect(await f.runs(it0, "review")).toHaveLength(2);
  });
});

describe("the repeated-failure rule", () => {
  const preflight = (message: string) => ({ ok: false as const, error_code: "preflight_failed", message });

  async function failing(responses: ReturnType<typeof preflight>[], opts: { repeated?: boolean } = {}) {
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => done, review: () => pass }), opts);
    f.broker.responses["github.preflight"] = [...responses];
    const it0 = await f.approved(20 + responses.length);
    for (let i = 0; i < 4; i++) {
      f.clock.advance(config.retry_max_ms);
      await f.step();
    }
    return { ...f, it0 };
  }

  it("two task failures in a row with the same code and detail line: the second blocks with repeated_failure, one comment, no third run", async () => {
    const f = await failing([preflight("push_access: no"), preflight("push_access: no\nsecond line differs")]);
    expect(await f.item(f.it0)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "repeated_failure" });
    expect(await f.runs(f.it0, "implement")).toHaveLength(2);
    expect(await f.queued(f.it0)).toEqual([]);
    const comments = f.source.comments.filter((c) => c.body.includes("failed twice in a row"));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("`preflight_failed`");
    expect(comments[0]!.body).toContain("push_access: no");
    for (const c of ["`/retry`", "`/revise <feedback>`", "`/reject <reason>`"]) expect(comments[0]!.body).toContain(c);
    expect((await f.store.listStateChanges(f.it0.id)).at(-1)).toMatchObject({ reason: "repeated_failure" });
  });

  it("the same code with a different detail line retries as before, up to max_attempts", async () => {
    const f = await failing([preflight("push_access: no"), preflight("pr_api: no"), preflight("push_access: no")]);
    expect(await f.item(f.it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
    expect(await f.runs(f.it0, "implement")).toHaveLength(gates().max_attempts);
  });

  it("is off unless the controller turns it on: identical failures use every attempt", async () => {
    const f = await failing([preflight("push_access: no"), preflight("push_access: no"), preflight("push_access: no")], { repeated: false });
    expect(await f.item(f.it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
  });

  it("infra failures and rate-limit pauses do not count", async () => {
    let n = 0;
    const statuses: Partial<AgentRunResult>[] = [
      { status: "timed_out" }, { status: "timed_out" }, { status: "rate_limited", error: "limit" }, { status: "rate_limited", error: "limit" },
    ];
    const f = await factory(new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => statuses[n++] ?? done, review: () => pass }));
    const it0 = await f.approved(30);
    for (let i = 0; i < 6; i++) {
      f.clock.advance(config.retry_max_ms * 2);
      await f.step();
    }
    expect(n).toBeGreaterThanOrEqual(statuses.length);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect((await f.store.listStateChanges(it0.id)).map((c) => c.reason)).not.toContain("repeated_failure");
  });

  it("/retry on repeated_failure queues a new run of that step with a fresh attempt budget", async () => {
    const f = await failing([preflight("push_access: no"), preflight("push_access: no"), preflight("base_fetch: no")]);
    expect(await f.item(f.it0)).toMatchObject({ blocked_reason: "repeated_failure" });
    f.command(f.it0, { kind: "retry_requested" });
    await f.step();
    // The new step failed once (base_fetch) and is retried: a fresh budget, not a block.
    expect(await f.item(f.it0)).toMatchObject({ blocked_on: "none", restart_count: 1 });
    const runs = await f.runs(f.it0, "implement");
    expect(runs).toHaveLength(4);
    expect(runs.at(-1)!.status).toBe("queued");
    f.clock.advance(config.retry_max_ms);
    await f.step();
    expect(await f.item(f.it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });
});

describe("policy helpers", () => {
  const failed = (id: string, error_code: string, detail: string, infra = false): Run =>
    ({ id, kind: "implement", outcome: { status: "failed", error_code, detail, infra } }) as unknown as Run;

  it("failureLine keeps the first line, up to 200 characters", () => {
    expect(failureLine("a\nb")).toBe("a");
    expect(failureLine("x".repeat(300))).toHaveLength(200);
  });

  it("repeatsLastFailure compares code and detail line with the previous task failure, skipping infra and rate limits", () => {
    const a = failed("1", "preflight_failed", "push_access: no");
    const b = failed("2", "preflight_failed", "push_access: no");
    expect(repeatsLastFailure([a, b], b)).toBe(true);
    expect(repeatsLastFailure([a], a)).toBe(false);
    expect(repeatsLastFailure([a, failed("2", "preflight_failed", "pr_api: no")], failed("2", "preflight_failed", "pr_api: no"))).toBe(false);
    expect(repeatsLastFailure([a, failed("2", "push_failed", "push_access: no")], failed("2", "push_failed", "push_access: no"))).toBe(false);
    const infra1 = failed("1", "agent_timed_out", "t", true);
    const infra2 = failed("2", "agent_timed_out", "t", true);
    expect(repeatsLastFailure([infra1, infra2], infra2)).toBe(false);
    const rl1 = failed("1", "rate_limited", "limit");
    const rl2 = failed("2", "rate_limited", "limit");
    expect(repeatsLastFailure([rl1, rl2], rl2)).toBe(false);
  });

  it("blockingRunKind reads the run that asked, or the last failed run", () => {
    const asked = { kind: "resolve", outcome: { status: "succeeded", summary: "", data: { needs_human: ASK } } } as unknown as Run;
    const ok = { kind: "review", outcome: { status: "succeeded", summary: "", data: {} } } as unknown as Run;
    expect(blockingRunKind("agent_needs_human", [asked, ok])).toBe("resolve");
    expect(blockingRunKind("repeated_failure", [failed("1", "x", "y"), ok])).toBe("implement");
    expect(blockingRunKind("max_attempts", [asked])).toBeUndefined();
  });

  it("the footer at agent_needs_human lists /resolve only when a resolve run asked", () => {
    const it0 = { stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human", pr_number: 42 } as const;
    const names = (k?: Run["kind"]) => commandsFor(commandState(it0, k)).map((c) => c.name);
    expect(names("resolve")).toEqual(expect.arrayContaining(["reject", "revise", "retry", "resolve"]));
    expect(names("implement")).not.toContain("resolve");
    expect(names()).not.toContain("resolve");
  });
});
