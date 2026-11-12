import { describe, expect, it } from "vitest";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { Run, StateChange, Tier, WorkItem } from "../src/core/types.js";
import type { Worker } from "../src/worker/runner.js";
import type { RunCall } from "../src/worker/run-kind.js";
import { answersDetail, type DecisionAnswer } from "../src/shared/command-notes.js";
import { renderRevision, renderWorkItem } from "../src/worker/support.js";
import triage from "../src/worker/runs/triage/triage.run.js";
import { alice, issueRef, pipeline, triageSpec } from "./helpers/fakes.js";

// Owner answers (design 04-agents.md): the answers stored on an approval bind every later spec of the item and its
// phases. The triage prompt carries them, and the controller holds a spec that drops one for `/approve`.

const ANSWERS: DecisionAnswer[] = [
  { question: "Which events does the calendar list?", answer: "Upcoming 7 days", accepted_default: false },
  { question: "Show the last sync?", answer: "yes", accepted_default: true },
];
const HEAD = "## Owner answers (binding)";
const change = (reason: string, detail: Record<string, unknown> | null = null) => ({ reason, detail }) as unknown as StateChange;

/** A fake worker whose store holds `changes` by item ID and whose agent returns the clean spec, recording each prompt and read. */
function fakeWorker(changes: Record<string, StateChange[]>) {
  const prompts: string[] = [];
  const reads: string[] = [];
  const w = {
    d: { store: { listStateChanges: async (id: string) => (reads.push(id), changes[id] ?? []) } },
    withIndex: async (prompt: string) => prompt,
    agent: async (_r: Run, _i: WorkItem, _h: unknown, _s: AbortSignal, role: { prompt: string }) => {
      prompts.push(role.prompt);
      return { output: { ...triageSpec, decisions: [] }, transcript: "t" } as unknown as AgentRunResult;
    },
  } as unknown as Worker;
  return { w, prompts, reads };
}

const ITEM = {
  id: "wi_1", source: { link: "https://example.test/1" }, problem: "Show the calendar.", issue_text: "Show the calendar's events.",
  revision_count: 0, spec_feedback: null, parent_id: null, allowed_paths: [], done_criteria: [], tier: 2, title: "Calendar",
} as unknown as WorkItem;

async function prompt(item: WorkItem, changes: Record<string, StateChange[]>) {
  const { w, prompts, reads } = fakeWorker(changes);
  const call = {
    run: { id: "run_1" } as Run, item, signal: new AbortController().signal, model: "cheap", handle: {},
    step: async (_id: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as RunCall;
  await triage.execute(w, call);
  return { text: prompts[0]!, reads };
}

const approved = { wi_1: [change("triaged"), change("spec_approved", answersDetail(ANSWERS))] };

describe("the triage prompt with stored owner answers", () => {
  it("a spec conflict revision gets the section above the request, each answer verbatim", async () => {
    const item = { ...ITEM, revision_count: 1, spec_feedback: "The implementer could not meet a done criterion inside the spec:\n\nneeds web/x.tsx" };
    const { text } = await prompt(item, approved);
    expect(text).toContain(HEAD);
    expect(text).toContain("Answer: Upcoming 7 days (not the default)");
    expect(text).toContain("overrides the request's wording");
    expect(text.indexOf(HEAD)).toBeLessThan(text.indexOf("## Original issue"));
  });

  it("a /revise gets the section above the request", async () => {
    const item = { ...ITEM, revision_count: 2, spec_feedback: "Keep the list short." };
    const { text } = await prompt(item, approved);
    expect(text.indexOf(HEAD)).toBeGreaterThan(-1);
    expect(text.indexOf(HEAD)).toBeLessThan(text.indexOf("## Original issue"));
    expect(text).toContain("Upcoming 7 days");
  });

  it("a re-triage gets the section above the request", async () => {
    const { text } = await prompt(ITEM, approved);
    expect(text.indexOf(HEAD)).toBeGreaterThan(-1);
    expect(text.indexOf(HEAD)).toBeLessThan(text.indexOf("## Problem"));
    expect(text).toContain("Upcoming 7 days");
  });

  it("a split's phase gets its parent's split answers", async () => {
    const phase = { ...ITEM, id: "wi_2", parent_id: "wi_p" } as unknown as WorkItem;
    const { text, reads } = await prompt(phase, { wi_p: [change("split_approved", { phases: 2, ...answersDetail(ANSWERS) })] });
    expect(reads).toEqual(["wi_2", "wi_p"]);
    expect(text.indexOf(HEAD)).toBeLessThan(text.indexOf("## Problem"));
    expect(text).toContain("Upcoming 7 days");
  });

  it("with no stored answers the prompt is the same as before", async () => {
    expect((await prompt(ITEM, {})).text).toBe(renderWorkItem(ITEM, { includeSpec: false }));
    const revision = { ...ITEM, revision_count: 1, spec_feedback: "x" };
    expect((await prompt(revision, { wi_1: [change("spec_approved", { note: "n" })] })).text).toBe(renderRevision(revision));
  });
});

const DECISION = { question: ANSWERS[0]!.question, reason: "It sets the range.", options: ["Upcoming 7 days", "Today"], default: "Today", owner_only: false };
const CONFLICT = { summary: "", next_steps: "", spec_conflict: "criterion 1 needs web/calendar.tsx" };

/** A request value each spec keeps but the first, so the first spec waits for `/approve` at any tier (a tier is never lowered). */
const VALUE = "calendar-v2";

/**
 * A pipeline item whose first spec drops the request's value, so it waits for `/approve`, with one decision,
 * approved with `1: Upcoming 7 days`; the implementer then returns a spec conflict, and the revision's triage
 * answers `revised` (tier 1, keeping the value). `gate`: the spec gate's lowest tier; `standing`: turn on spec-t1.
 */
async function rewritten(revised: Record<string, unknown>, o: { gate?: Tier; standing?: boolean } = {}) {
  let implemented = 0;
  const f = await pipeline({
    implement: () => ({ output: implemented++ === 0 ? CONFLICT : { summary: "s", next_steps: "n" } }),
    config: { dials: { spec_gate_min_tier: o.gate ?? 3, auto_merge_max_tier: 0 } },
  });
  f.sandbox.commits = [];
  const specs = [
    { ...triageSpec, tier: 1, decisions: [DECISION] },
    { ...triageSpec, tier: 1, decisions: [], desired_output: `Uses \`${VALUE}\`.`, ...revised },
  ];
  f.runner.script.triage = () => ({ output: specs.length > 1 ? specs.shift() : specs[0] });
  f.source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "Calendar", body: `Use \`${VALUE}\`.` });
  await f.controller.tickIntake();
  const it = (await f.store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  await f.step();
  expect(await f.item(it)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  if (o.standing) {
    f.source.queue.push({ kind: "standing_requested", source: it.source, comment_id: "s1", requester: alice, args: "accept spec-t1" });
    await f.controller.tickIntake();
  }
  f.source.queue.push({ kind: "spec_approved", source: it.source, comment_id: "c1", approver: alice, note: "1: Upcoming 7 days" });
  await f.controller.tickIntake();
  await f.step();
  const triagePrompts = f.runner.specs.filter((s: AgentRunSpec) => s.role === "triage").map((s) => s.prompt);
  const specComment = f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:spec")).at(-1)?.body ?? "";
  return { f, item: await f.item(it), triagePrompts, specComment };
}

describe("a re-written spec that drops an owner answer", () => {
  it("the conflict revision's prompt holds the answers, and a spec that drops one waits for /approve with the missing line", async () => {
    // Tier 1 is under the spec gate (3): without the hold it would start on its own.
    const { f, item, triagePrompts, specComment } = await rewritten({ problem: "Show today's events." });
    expect(triagePrompts).toHaveLength(2);
    expect(triagePrompts[0]).not.toContain(HEAD);
    expect(triagePrompts[1]).toContain(HEAD);
    expect(triagePrompts[1]).toContain("Upcoming 7 days");
    expect(item).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", revision_count: 1 });
    expect(f.agentCalls("implement")).toBe(1);
    expect(specComment).toContain("### Owner answers missing in the spec");
    expect(specComment).toContain("Owner answer missing: 1: Upcoming 7 days");
    expect(specComment).not.toContain("### Values from the request missing in the spec");
    expect(specComment).toContain("waits for `/approve`, with no automatic or standing approval: the spec drops an owner answer (decision 1)");

    f.source.queue.push({ kind: "spec_approved", source: item.source, comment_id: "c2", approver: alice, note: "" });
    await f.controller.tickIntake();
    await f.step();
    expect(f.agentCalls("implement")).toBe(2);
  });

  it("a spec that keeps the answer verbatim, in any letter case and spacing, starts as before", async () => {
    const { f, item, specComment } = await rewritten({ problem: "Show the UPCOMING  7\ndays of events." });
    expect(item.blocked_reason).not.toBe("spec_pending");
    expect(f.agentCalls("implement")).toBe(2);
    expect(specComment).not.toContain("Owner answer missing");
  });

  it("an answer only offered again as a decision's option does not count as kept", async () => {
    const { item, specComment } = await rewritten({ decisions: [DECISION] });
    expect(item.blocked_reason).toBe("spec_pending");
    expect(specComment).toContain("Owner answer missing: 1: Upcoming 7 days");
  });

  it("a standing rule does not approve it, and does approve the spec that keeps it", async () => {
    // The spec gate at every tier, so the tier 1 revision would be the standing rule's.
    const dropped = await rewritten({ problem: "Show today's events." }, { gate: 1, standing: true });
    expect(dropped.item).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(dropped.specComment).toContain("Owner answer missing: 1: Upcoming 7 days");
    const kept = await rewritten({ problem: "Show the Upcoming 7 days." }, { gate: 1, standing: true });
    expect(kept.item.blocked_reason).not.toBe("spec_pending");
    expect((await kept.f.store.listStateChanges(kept.item.id)).map((c) => c.reason)).toContain("standing_approved");
  });
});
