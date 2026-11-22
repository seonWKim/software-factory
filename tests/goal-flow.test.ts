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
// after the phases. No judge runs yet.

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
  return { store, source, intake, finishTriage, approve, splitApproved, splitComment };
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
