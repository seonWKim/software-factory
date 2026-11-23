import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { FactoryConfig } from "../src/core/config.js";
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

async function setup(cfg: Partial<FactoryConfig> = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: { ...config, ...cfg }, log: silent, scanner: cleanScanner });
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
const FIX = { title: "Wire the flow", problem: "the flow stops at step 2", done_criteria: ["the flow runs end to end"], allowed_paths: ["src/flow/"] };
const judged = (verdict: unknown): RunOutcome => ({ status: "succeeded", summary: "judge done", data: { verdict } });
/** The comments on goal split `g`'s own issue. */
const issueComments = (g: { parent: WorkItem; source: { comments: { source: { id: string }; marker: string }[] } }) =>
  g.source.comments.filter((c) => c.source.id === g.parent.source.id);

/** A goal split (issue `n`, two phases unless `phases` says) approved and filed, with helpers to close phases and finish judge runs. */
async function goalSplit(n: number, opts: { goal?: string[] | null; phases?: number; cfg?: Partial<FactoryConfig> } = {}) {
  const f = await setup(opts.cfg);
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
    f.clock.advance(DAY); // past a retry's backoff
    const run = await f.store.claimRun({ worker_id: w1, kinds: ["judge"], lease_ms: 60_000 });
    expect(run).not.toBeNull();
    await f.store.completeRun(run!.id, run!.lease!.token, outcome);
    await f.controller.tickRuns();
    return run!;
  };
  const verdicts = async () => (await f.store.listStateChanges(parent.id)).filter((c) => c.reason === "judge_verdict");
  const goalQuestions = () => f.source.comments.filter((c) => c.source.id === issueRef(n).id && c.marker.includes(`goal-question:${parent.id}`));
  const closeComment = () => f.source.comments.find((c) => c.source.id === issueRef(n).id && c.body.startsWith("Closed because"));
  /** The goal's comments whose marker starts with `factory:<prefix>:<parent id>`. */
  const marked = (prefix: string) => f.source.comments.filter((c) => c.source.id === issueRef(n).id && c.marker.includes(`${prefix}:${parent.id}`));
  /** The parent's recorded phases, in phase order: its approval's, then each goal_phase_added's. */
  const recorded = async () => {
    const changes = await f.store.listStateChanges(parent.id);
    const ids = [
      ...(JSON.parse(String(changes.find((c) => c.reason === SPLIT_APPROVED)!.detail!.sub_issues)) as string[]),
      ...changes.filter((c) => c.reason === "goal_phase_added").map((c) => String(c.detail!.sub_issue)),
    ];
    return Promise.all(ids.map(async (id) => (await f.store.listPhases(parent.id)).find((p) => p.source.id === id)!));
  };
  let comment = 900;
  /** A command on the goal's issue from alice under a new comment id. */
  const command = async (kind: "spec_approved" | "spec_rejected") => {
    const at = { source: issueRef(n), comment_id: String(++comment), approver: alice };
    f.source.queue.push(kind === "spec_approved" ? { kind, ...at } : { kind, ...at, reason: "not worth it" });
    await f.controller.tickIntake();
    await f.controller.tickOutbox();
  };
  /** Closes merged phase `p` (merge sha `sha`), queues its judge and applies `verdict`. */
  const judgePhase = async (p: WorkItem, sha: string, verdict: unknown) => {
    await close(p, sha);
    await f.controller.tickPhases();
    await finishJudge(judged(verdict));
    await f.controller.tickPhases();
    await f.controller.tickOutbox();
  };
  return { ...f, parent, phases, get, close, judgeRuns, finishJudge, verdicts, goalQuestions, closeComment, marked, recorded, command, judgePhase };
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

  it("fix on a phase files a fix phase under the goal: the next phase number, held after the phase before it, recorded with goal_phase_added", async () => {
    const g = await goalSplit(313);
    const [p1, p2] = g.phases;
    await g.judgePhase(p1!, "sha-1", { verdict: "fix", reason: "the first goal line does not hold", fix: FIX });
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: "phases_open" });
    const recorded = await g.recorded();
    expect(recorded.map((p) => p.id).slice(0, 2)).toEqual([p1!.id, p2!.id]);
    const added = recorded[2]!;
    expect(added).toMatchObject({ parent_id: g.parent.id, phase: 3, stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold" });
    expect(added.title).toContain(FIX.title);
    const change = (await g.store.listStateChanges(g.parent.id)).find((c) => c.reason === "goal_phase_added")!;
    expect(change.detail).toMatchObject({ phase: 1, verdict: "fix", applied: "fix", added_phase: 3, sub_issue: added.source.id, fix_title: FIX.title });
    expect(g.goalQuestions()).toEqual([]);
    // The fix phase is in the goal's thread, with the verdict.
    expect(g.marked("goal-phase")).toHaveLength(1);
    expect(g.marked("goal-phase")[0]!.body).toContain(FIX.title);
    expect(g.marked("goal-phase")[0]!.body).toContain("the first goal line does not hold");
    // The judge let the goal go on: phase 2 starts, and the fix phase waits for it.
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none" });
    expect(await g.get(added)).toMatchObject({ blocked_on: "upstream", blocked_reason: "phase_hold" });
    await g.judgePhase(p2!, "sha-2", { verdict: "next", reason: "phase 2 did its part" });
    expect(await g.get(added)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    await g.judgePhase(added, "sha-3", { verdict: "done", reason: "every goal line holds" });
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "sha-3" });
    // Each verdict is a message in the goal's thread.
    expect(g.marked("goal-verdict").length).toBeGreaterThanOrEqual(2);
  });

  it("a last phase that merges but misses a goal line gets a fix phase, not a closed goal", async () => {
    const g = await goalSplit(321);
    const [p1, p2] = g.phases;
    await g.judgePhase(p1!, "sha-1", { verdict: "next", reason: "on to phase 2" });
    await g.judgePhase(p2!, "sha-2", { verdict: "fix", reason: "the docs line does not hold", fix: FIX });
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: "phases_open" });
    expect(g.closeComment()).toBeUndefined();
    const added = (await g.recorded())[2]!;
    expect(added).toMatchObject({ phase: 3 });
    // Phase 2 merged and was judged: the fix phase starts.
    expect(await g.get(added)).toMatchObject({ blocked_on: "none", blocked_reason: null });
  });

  it("at the fix cap of 2 the goal waits for the owner with one comment; /approve files one more fix phase", async () => {
    const g = await goalSplit(322);
    await g.judgePhase(g.phases[0]!, "sha-1", { verdict: "next", reason: "go on" });
    await g.judgePhase(g.phases[1]!, "sha-2", { verdict: "fix", reason: "missing a", fix: { ...FIX, title: "Fix A" } });
    await g.judgePhase((await g.recorded())[2]!, "sha-3", { verdict: "fix", reason: "missing b", fix: { ...FIX, title: "Fix B" } });
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "upstream", blocked_reason: "phases_open" });
    await g.judgePhase((await g.recorded())[3]!, "sha-4", { verdict: "fix", reason: "missing c", fix: { ...FIX, title: "Fix C" } });
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "goal_limit" });
    expect(await g.recorded()).toHaveLength(4);
    expect(g.marked("goal-limit")).toHaveLength(1);
    const body = g.marked("goal-limit")[0]!.body;
    expect(body).toContain("2 fix phases");
    expect(body).toContain("cap of 2");
    expect(body).toContain("Fix C");
    expect((await g.verdicts()).at(-1)!.detail).toMatchObject({ phase: 4, verdict: "fix", applied: "goal_limit", fix_title: "Fix C" });

    await g.command("spec_approved");
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: "phases_open" });
    const recorded = await g.recorded();
    expect(recorded[4]).toMatchObject({ phase: 5 });
    expect(recorded[4]!.title).toContain("Fix C");
    expect(g.marked("goal-phase").map((c) => c.body).some((b) => b.includes("Fix C"))).toBe(true);
    // A second /approve has no question to answer.
    await g.command("spec_approved");
    expect(await g.recorded()).toHaveLength(5);
  });

  it("/reject at the fix cap closes the goal rejected", async () => {
    const g = await goalSplit(323);
    await g.judgePhase(g.phases[0]!, "sha-1", { verdict: "fix", reason: "a", fix: { ...FIX, title: "Fix A" } });
    await g.judgePhase(g.phases[1]!, "sha-2", { verdict: "fix", reason: "b", fix: { ...FIX, title: "Fix B" } });
    await g.judgePhase((await g.recorded())[2]!, "sha-3", { verdict: "fix", reason: "c", fix: { ...FIX, title: "Fix C" } });
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_limit" });
    await g.command("spec_rejected");
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });

  it("a goal question with a fix proposed: /approve files that fix phase from the verdict's fix fields", async () => {
    const g = await goalSplit(324);
    await g.judgePhase(g.phases[0]!, "sha-1", { verdict: "ask", reason: "the goal lines contradict each other" });
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_question" });
    // A question recorded with a fix (as before fix phases were filed) keeps its fix_* fields on the verdict.
    const cur = await g.get(g.parent);
    const fix = { fix_title: "Fix Q", fix_problem: "q", fix_done_criteria: JSON.stringify(["q works"]), fix_allowed_paths: JSON.stringify(["src/q/"]) };
    expect((await g.store.transition({
      id: cur.id, expected_version: cur.version, actor: system, reason: "judge_verdict", patch: {},
      detail: { phase: 1, verdict: "fix", reason: "q is missing", applied: "goal_question", ...fix },
    })).ok).toBe(true);
    await g.command("spec_approved");
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "upstream", blocked_reason: "phases_open" });
    const added = (await g.recorded())[2]!;
    expect(added).toMatchObject({ phase: 3 });
    expect(added.title).toContain("Fix Q");
  });

  it("a goal question with no fix: /approve releases the next held phase, and on the last phase is refused naming /reject", async () => {
    const g = await goalSplit(325);
    const [p1, p2] = g.phases;
    await g.judgePhase(p1!, "sha-1", { verdict: "ask", reason: "only the owner can say" });
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "upstream" });
    await g.command("spec_approved");
    await g.controller.tickPhases();
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "upstream", blocked_reason: "phases_open" });
    expect((await g.verdicts()).at(-1)!.detail).toMatchObject({ phase: 1, applied: "next" });
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "none" });

    await g.judgePhase(p2!, "sha-2", { verdict: "next", reason: "more is needed" });
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_question" });
    const before = g.source.comments.length;
    await g.command("spec_approved");
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_question" });
    expect(g.source.comments.slice(before).some((c) => c.body.includes("/reject"))).toBe(true);
    await g.command("spec_rejected");
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
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

  it("a judge that answers invalidly up to max_attempts stops the goal as a goal question, not as a dead run", async () => {
    const g = await goalSplit(319);
    const [p1, p2] = g.phases;
    await g.close(p1!, "sha-1");
    await g.controller.tickPhases();
    for (let n = 0; n < 3; n++) await g.finishJudge(judged({ verdict: "fix", reason: "x" }));
    await g.controller.tickPhases();
    await g.controller.tickOutbox();
    expect(await g.get(g.parent)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "goal_question" });
    expect((await g.store.listStateChanges(g.parent.id)).at(-1)).toMatchObject({ reason: "judge_failed", detail: { phase: 1, error_code: "invalid_output", limit: "max_attempts" } });
    expect(g.goalQuestions()).toHaveLength(1);
    expect(g.goalQuestions()[0]!.body).toContain("phase 1");
    expect(issueComments(g).filter((c) => c.marker.startsWith("run-failed:"))).toEqual([]);
    expect(await g.get(p2!)).toMatchObject({ blocked_on: "upstream" });
  });

  it("a judge run that fails the same way twice stops the goal as a goal question", async () => {
    const g = await goalSplit(320);
    await g.close(g.phases[0]!, "sha-1");
    await g.controller.tickPhases();
    for (let n = 0; n < 2; n++) await g.finishJudge({ status: "failed", error_code: "agent_failed", detail: "the agent broke", infra: false });
    await g.controller.tickOutbox();
    expect(await g.get(g.parent)).toMatchObject({ blocked_on: "human", blocked_reason: "goal_question" });
    expect((await g.store.listStateChanges(g.parent.id)).at(-1)).toMatchObject({ reason: "judge_failed", detail: { phase: 1, limit: "repeated_failure" } });
    expect(g.goalQuestions()).toHaveLength(1);
    expect(issueComments(g).filter((c) => c.marker.startsWith("run-failed:"))).toEqual([]);
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

describe("a goal split in auto mode", () => {
  it("three phases run to the end with zero asks when every decision has a default (phases_auto_approve on)", async () => {
    const g = await goalSplit(330, { phases: 3, cfg: { phases_auto_approve: true } });
    const verdicts = [{ verdict: "next", reason: "phase 1 did its part" }, { verdict: "next", reason: "phase 2 did its part" }, { verdict: "done", reason: "every goal line holds" }];
    for (const [i, p] of g.phases.entries()) {
      // The scripted triage answer for the phase: a spec with every decision on its default, approved by the parent's /approve.
      await g.finishTriage(triaged(triageSpec));
      expect(await g.get(p)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
      await g.judgePhase(p, `sha-${i + 1}`, verdicts[i]);
    }
    expect(await g.get(g.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "sha-3" });
    // Asks after the owner's /approve of the split: any change that left the goal or a phase waiting on a person.
    const after = (await g.splitApproved(g.parent))!.version;
    const asks: string[] = [];
    for (const it of [g.parent, ...g.phases]) {
      for (const c of await g.store.listStateChanges(it.id)) if (c.changes.blocked_on?.to === "human" && (it.id !== g.parent.id || c.version > after)) asks.push(`${it.id}:${c.reason}`);
    }
    expect(asks).toEqual([]);
    expect(g.goalQuestions()).toEqual([]);
  });
});
