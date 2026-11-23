import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { SPLIT_APPROVED } from "../src/core/split.js";
import type { RunOutcome, SourceRef, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSlackPollSource, FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent, slackRef, triageSpec } from "./helpers/fakes/config.js";
import { newStore, w1 } from "./helpers/store.js";

// Goal lines of a split (design 04-split-specs, 2026-11-22): triage's optional goal_done_when, read only on a split
// spec, is stored on the parent's split_approved detail as a JSON array in order and listed in the split comment
// after the phases. Each goal phase that closes completed with a merge sha gets one judge run (phase 2 of the goal
// split, 2026-11-23), whose verdict releases the next phase, closes the goal or stops it for the owner.

const DAY = 24 * 60 * 60 * 1000;
const GOAL = ["the whole flow works end to end", "the docs describe it", "a third line keeps its place"];

const phase = (n: number) => ({ title: `Part ${n}`, problem: `Problem of part ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] });
const bigSpec = (extra: Record<string, unknown> = {}) => ({ ...triageSpec, estimated_lines: 2600, estimated_files: 30, phases: [phase(1), phase(2)], ...extra });
const triaged = (spec: unknown): RunOutcome => ({ status: "succeeded", summary: "s", data: { spec } });

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const intake = async (n: number): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "Big change", body: "do it all" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  const finishTriage = async (outcome: RunOutcome) => {
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    await store.completeRun(run!.id, run!.lease!.token, outcome);
    await controller.tickRuns();
  };
  const approve = async (src: SourceRef) => {
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "500", approver: alice });
    await controller.tickIntake();
  };
  const splitApproved = async (it: WorkItem) => (await store.listStateChanges(it.id)).find((c) => c.reason === SPLIT_APPROVED);
  const splitComment = (src: SourceRef) => source.comments.find((c) => c.source.id === src.id && c.body.startsWith("The split spec was approved"));
  return { store, source, clock, controller, intake, finishTriage, approve, splitApproved, splitComment };
}

/** The lines' positions in `body`, each after the one before it and after `after`. */
function expectInOrder(body: string, after: string, lines: readonly string[]) {
  let at = body.indexOf(after);
  expect(at).toBeGreaterThanOrEqual(0);
  for (const l of lines) {
    const next = body.indexOf(l, at);
    expect(next, l).toBeGreaterThan(at);
    at = next;
  }
}

describe("goal lines of a split spec", () => {
  it("are stored on split_approved as a JSON array in order, and listed in the split comment after the phases", async () => {
    const f = await setup();
    const parent = await f.intake(300);
    await f.finishTriage(triaged(bigSpec({ goal_done_when: GOAL })));
    await f.approve(issueRef(300));

    const approved = await f.splitApproved(parent);
    expect(approved).toBeDefined();
    expect(JSON.parse(String(approved!.detail!.goal_done_when))).toEqual(GOAL);
    expect(JSON.parse(String(approved!.detail!.sub_issues))).toEqual(f.source.subIssues.map((s) => s.ref.id));

    const body = f.splitComment(issueRef(300))!.body;
    const lastPhase = f.source.subIssues.at(-1)!.ref.link;
    expectInOrder(body, lastPhase, GOAL.map((g) => `- ${g}`));
  });

  it("a split without goal lines records and says nothing about a goal", async () => {
    const f = await setup();
    const parent = await f.intake(301);
    await f.finishTriage(triaged(bigSpec()));
    await f.approve(issueRef(301));
    expect((await f.splitApproved(parent))!.detail).not.toHaveProperty("goal_done_when");
    expect(f.splitComment(issueRef(301))!.body).not.toContain("The whole split is done when");
  });

  it("goal lines with no phases are an invalid answer: retried, no spec shown", async () => {
    const f = await setup();
    const item = await f.intake(302);
    await f.finishTriage(triaged({ ...triageSpec, goal_done_when: GOAL }));
    expect(f.source.comments.some((c) => c.marker.startsWith("<!-- factory:spec:"))).toBe(false);
    expect((await f.store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "run_retry_scheduled", detail: { error_code: "invalid_output" } });
  });

  it("a split filed as local tasks stores the goal lines and lists them after the local tasks", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const slack = new FakeSlackPollSource();
    Object.defineProperty(slack, "fileSubIssue", { value: undefined });
    const controller = new ControllerRole({ store, sources: [slack, new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const requester = { provider: "slack", subject: "1" } as const;
    slack.queue.push({ kind: "item_requested", source: slackRef(1), requester, title: "Big change", body: "do it all" });
    await controller.tickIntake();
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    await store.completeRun(run!.id, run!.lease!.token, triaged(bigSpec({ goal_done_when: GOAL })));
    await controller.tickRuns();
    slack.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: "600", approver: requester });
    await controller.tickIntake();
    await controller.tickOutbox();

    const parent = (await store.getWorkItemBySource("slack_thread", slackRef(1).id))!;
    const approved = (await store.listStateChanges(parent.id)).find((c) => c.reason === SPLIT_APPROVED)!;
    expect(JSON.parse(String(approved.detail!.goal_done_when))).toEqual(GOAL);
    const line = slack.comments.find((c) => c.source.id === slackRef(1).id && c.body.includes("as local tasks"))!.body;
    expectInOrder(line, `local:${slackRef(1).id}-phase-2`, GOAL.map((g) => `- ${g}`));
  });
});

const system = { kind: "system", id: "test" } as const;
const judged = (verdict: unknown): RunOutcome => ({ status: "succeeded", summary: "judge done", data: { verdict } });

/** A goal split (issue `n`, two phases unless `phases` says) approved and filed, with helpers to close phases and finish judge runs. */
async function goalSplit(n: number, opts: { goal?: string[] | null; phases?: number } = {}) {
  const f = await setup();
  const parent = await f.intake(n);
  const goal = opts.goal === undefined ? GOAL : opts.goal;
  const count = opts.phases ?? 2;
  await f.finishTriage(triaged(bigSpec({ phases: Array.from({ length: count }, (_, i) => phase(i + 1)), ...(goal ? { goal_done_when: goal } : {}) })));
  await f.approve(issueRef(n));
  const get = async (it: WorkItem) => (await f.store.getWorkItem(it.id))!;
  const phases = await Promise.all(f.source.subIssues.map(async (s) => (await f.store.getWorkItemBySource(s.ref.type, s.ref.id))!));
  /** Closes phase `p` in the store as its merge would. */
  const close = async (p: WorkItem, merge_sha: string | null) => {
    const cur = await get(p);
    const r = await f.store.transition({
      id: cur.id, expected_version: cur.version, actor: system, reason: "setup",
      patch: { stage: "CLOSED", close_reason: "completed", merge_sha, blocked_on: "none", blocked_reason: null },
    });
    expect(r.ok).toBe(true);
  };
  const judgeRuns = async () => (await f.store.listRuns(parent.id)).filter((r) => r.kind === "judge");
  /** Claims the queued judge run and completes it with `outcome`, then applies it. */
  const finishJudge = async (outcome: RunOutcome) => {
    const run = await f.store.claimRun({ worker_id: w1, kinds: ["judge"], lease_ms: 60_000 });
    expect(run).not.toBeNull();
    await f.store.completeRun(run!.id, run!.lease!.token, outcome);
    await f.controller.tickRuns();
    return run!;
  };
  const verdicts = async () => (await f.store.listStateChanges(parent.id)).filter((c) => c.reason === "judge_verdict");
  const goalQuestions = () => f.source.comments.filter((c) => c.source.id === issueRef(n).id && c.marker.includes(`goal-question:${parent.id}`));
  const closeComment = () => f.source.comments.find((c) => c.source.id === issueRef(n).id && c.body.startsWith("Closed because"));
  return { ...f, parent, phases, get, close, judgeRuns, finishJudge, verdicts, goalQuestions, closeComment };
}

describe("the judge of a goal split", () => {
  it("queues one judge run per merged phase, keyed judge:<parent>:<phase>, and a next verdict releases the next phase", async () => {
    const g = await goalSplit(310);
    const [p1, p2] = g.phases;
    const rows = (await g.store.listPhases(g.parent.id)).map((p) => p.id);
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    await g.controller.tickPhases();
    const runs = await g.judgeRuns();
    expect(runs.map((r) => r.idempotency_key)).toEqual([`judge:${g.parent.id}:1`]);
    expect(runs[0]!.input?.judge).toMatchObject({ phase: 1, goal_done_when: GOAL, merge_sha: "sha-1", title: p1!.title, phases: g.phases.map((p) => p.title) });
    // Phase 2 waits for the verdict on a goal split.
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "upstream" });

    await g.finishJudge(judged({ verdict: "next", reason: "phase 1 did its part" }));
    await g.controller.tickPhases();
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect((await g.verdicts()).at(-1)!.detail).toMatchObject({ phase: 1, verdict: "next", reason: "phase 1 did its part", applied: "next" });
    expect((await g.store.listPhases(g.parent.id)).map((p) => p.id)).toEqual(rows);
    // A later pass queues nothing more for phase 1.
    await g.controller.tickPhases();
    expect((await g.judgeRuns()).map((r) => r.idempotency_key)).toEqual([`judge:${g.parent.id}:1`]);
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream" });
  });

  it("done on the last recorded phase closes the goal completed, and its close comment says the goal's lines were met", async () => {
    const g = await goalSplit(311);
    const [p1, p2] = g.phases;
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    await g.finishJudge(judged({ verdict: "next", reason: "on to phase 2" }));
    await g.controller.tickPhases();
    await g.close(p2!, "sha-2");
    await g.controller.tickPhases();
    // Every phase closed, but the goal waits for the judge of its last phase.
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream" });
    expect((await g.judgeRuns()).map((r) => r.idempotency_key)).toEqual([`judge:${g.parent.id}:1`, `judge:${g.parent.id}:2`]);

    await g.finishJudge(judged({ verdict: "done", reason: "every goal line holds" }));
    await g.controller.tickPhases();
    await g.controller.tickOutbox();
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "sha-2" });
    expect(g.closeComment()!.body).toContain("the goal's lines met");
    const v = (await g.get(g.parent)).version;
    await g.controller.tickPhases();
    await g.controller.tickRuns();
    expect((await g.get(g.parent)).version).toBe(v);
  });

  it("done on a phase that is not the last is treated as next: the goal does not close early", async () => {
    const g = await goalSplit(312);
    const [p1, p2] = g.phases;
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    await g.finishJudge(judged({ verdict: "done", reason: "looks done already" }));
    await g.controller.tickPhases();
    expect((await g.verdicts()).at(-1)!.detail).toMatchObject({ phase: 1, verdict: "done", applied: "next" });
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none" });
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream" });
  });

  it("fix on a phase stops the goal for the owner with one comment, keeps the fix on the change, adds no phase and closes nothing", async () => {
    const g = await goalSplit(313);
    const [p1, p2] = g.phases;
    const rows = (await g.store.listPhases(g.parent.id)).map((p) => p.id);
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    const fix = { title: "Wire the flow", problem: "the flow stops at step 2", done_criteria: ["the flow runs end to end"], allowed_paths: ["src/flow/"] };
    await g.finishJudge(judged({ verdict: "fix", reason: "the first goal line does not hold", fix }));
    await g.controller.tickPhases();
    await g.controller.tickRuns();
    await g.controller.tickOutbox();
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "goal_question" });
    expect((await g.verdicts()).at(-1)!.detail).toMatchObject({
      phase: 1, verdict: "fix", applied: "goal_question", fix_title: fix.title, fix_problem: fix.problem,
      fix_done_criteria: JSON.stringify(fix.done_criteria), fix_allowed_paths: JSON.stringify(fix.allowed_paths),
    });
    expect(g.goalQuestions()).toHaveLength(1);
    expect(g.goalQuestions()[0]!.body).toContain("the first goal line does not hold");
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "upstream" });
    expect((await g.store.listPhases(g.parent.id)).map((p) => p.id)).toEqual(rows);
  });

  it("ask on a phase, and next on the last recorded phase, stop the goal for the owner", async () => {
    const a = await goalSplit(314);
    await a.close(a.phases[0]!, "sha-1");
    await a.controller.tickPhases();
    await a.finishJudge(judged({ verdict: "ask", reason: "the goal lines contradict each other" }));
    await a.controller.tickOutbox();
    expect(await a.get(a.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_question" });
    expect(a.goalQuestions()).toHaveLength(1);

    const n = await goalSplit(315, { phases: 2 });
    await n.close(n.phases[0]!, "sha-1");
    await n.controller.tickPhases();
    await n.finishJudge(judged({ verdict: "next", reason: "go on" }));
    await n.controller.tickPhases();
    await n.close(n.phases[1]!, "sha-2");
    await n.controller.tickPhases();
    await n.finishJudge(judged({ verdict: "next", reason: "more is needed" }));
    await n.controller.tickPhases();
    await n.controller.tickOutbox();
    expect(await n.get(n.parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "goal_question" });
    expect(n.goalQuestions()).toHaveLength(1);
    expect(n.closeComment()).toBeUndefined();
  });

  it("an invalid answer is retried as an invalid triage answer is, and the phase stays closed", async () => {
    const g = await goalSplit(316);
    await g.close(g.phases[0]!, "sha-1");
    await g.controller.tickPhases();
    await g.finishJudge(judged({ verdict: "fix", reason: "no fields" }));
    expect((await g.store.listStateChanges(g.parent.id)).at(-1)).toMatchObject({ reason: "run_retry_scheduled", detail: { error_code: "invalid_output" } });
    const keys = (await g.judgeRuns()).map((r) => r.idempotency_key);
    expect(keys).toContain(`judge:${g.parent.id}:1:a1`);
    expect((await g.judgeRuns()).find((r) => r.idempotency_key.endsWith(":a1"))!.input?.judge).toMatchObject({ phase: 1 });
    expect(await g.get(g.phases[0]!)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    // The retry is the phase's run: a later pass queues no other one.
    await g.controller.tickPhases();
    expect((await g.judgeRuns()).map((r) => r.idempotency_key)).toEqual(keys);
  });

  it("a split without goal lines runs no judge and closes as before", async () => {
    const g = await goalSplit(317, { goal: null });
    const [p1, p2] = g.phases;
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none" });
    await g.close(p2!, "sha-2");
    await g.controller.tickPhases();
    await g.controller.tickOutbox();
    expect(await g.judgeRuns()).toEqual([]);
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "sha-2" });
    expect(g.closeComment()!.body).not.toContain("goal");
  });

  it("a goal split with no prompts/judge.md (prompt_missing) runs no judge and closes as before", async () => {
    const g = await goalSplit(318);
    const [p1, p2] = g.phases;
    const missing: RunOutcome = { status: "failed", error_code: "prompt_missing", detail: "prompts/judge.md is missing", infra: false };
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    await g.finishJudge(missing);
    await g.controller.tickPhases();
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none" });
    await g.close(p2!, "sha-2");
    await g.controller.tickPhases();
    await g.finishJudge(missing);
    await g.controller.tickPhases();
    await g.controller.tickOutbox();
    expect(await g.verdicts()).toEqual([]);
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "sha-2" });
    expect(g.closeComment()!.body).not.toContain("goal");
  });
});
