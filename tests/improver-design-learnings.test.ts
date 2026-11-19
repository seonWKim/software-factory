// Design learnings through the controller and the improve run (design 07-design-learnings): a /revise or /reject with
// words, an explicit `changes` verdict with a reason, and a design-system review finding on an item whose change touches
// web/ each add one line; a redelivered command adds none. The improve run tags and counts the lines (two of one kind:
// one proposal due, both as evidence), and filing its report appends the new lines to design-system/learnings.md in one
// local commit through the outbound local target. A sandbox double holds the factory repo; no live model, no network.

import { describe, expect, it } from "vitest";
import { LEARNINGS_HEAD, LEARNINGS_PATH, learnDesign } from "../src/core/design-learnings.js";
import { enqueueImprove, runImprove } from "../src/core/improver.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeForge, FakeSource, MemoryStorage, alice, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";

const WRITER = "github:1" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };
const WEB = ["web/src/pages/tasks/", "src/ui/api.ts"];
const scanner = new PatternEgressScanner(async () => []);

/** The factory repo as the controller's sandbox: one local base, its files, branches made from it, merges in memory. */
function repoDouble() {
  const state = { base: "c0", files: {} as Record<string, string>, branches: new Map<string, { path: string; content: string }>(), commits: 0 };
  const sandbox = {
    localBranch: async () => state.base,
    localConflicts: async () => [],
    readLocalFile: async (s: { path: string }) => (s.path in state.files ? { commit: state.base, text: state.files[s.path]! } : null),
    commitNewBranch: async (s: { parent: string; branch: string; path: string; content: string }) => {
      if (state.branches.has(s.branch)) return { created: false, reason: "exists" };
      if (s.parent !== state.base) return { created: false, reason: "base_moved" };
      state.branches.set(s.branch, s);
      return { created: true, sha: `b${++state.commits}` };
    },
    mergeLocal: async (s: { branch: string; expected_base?: string }) => {
      const b = state.branches.get(s.branch);
      if (!b || s.expected_base !== state.base) return { merged: false, refused: "moved" };
      state.files[b.path] = b.content;
      state.base = `m${++state.commits}`;
      return { merged: true, sha: state.base, already: false, not_updated: [] };
    },
  };
  return { state, sandbox: sandbox as unknown as Sandbox };
}

async function harness() {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const repo = repoDouble();
  const controller = new ControllerRole({
    store, sources: [source], forge: new FakeForge(source), auth: new FakeAuth(), clock, config, log: silent, scanner, sandbox: repo.sandbox,
  });
  /** A work item in `patch` with `paths` as its allowed paths, whose `kind` run finished. */
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch, paths: string[], kind: "triage" | "review" = "triage"): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    await store.enqueueRun({ work_item_id: item.id, kind, idempotency_key: `${kind}:${item.id}` });
    const run = (await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "done", data: {} });
    await controller.tickRuns();
    const now = (await store.getWorkItem(item.id))!;
    const r = await store.transition({ id: item.id, expected_version: now.version, actor: system, reason: "setup", patch: { ...patch, tier: 2, allowed_paths: paths } });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  const send = async (e: SourceEvent) => {
    await controller.handleEvent(e);
    await controller.tickOutbox();
  };
  const lines = () => store.listDesignLearnings(PROJECT_KEY);
  return { store, clock, controller, repo, itemIn, send, lines };
}

const revise = (n: number, feedback: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "revise_requested", source: issueRef(n), comment_id, requester: alice, feedback });
const reject = (n: number, reason: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "spec_rejected", source: issueRef(n), comment_id, approver: alice, reason });
const verdict = (n: number, args: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "verdict_submitted", target: { kind: "issue", source: issueRef(n) }, comment_id, approver: alice, args });

/** Answers the tagging call by the words it carries. */
function tagger(kinds: Record<string, string>): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      const hit = Object.keys(kinds).find((w) => req.messages[0]!.content.includes(w));
      return { text: hit ? kinds[hit]! : "other", stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

describe("capture through the controller", () => {
  it("a /revise and a /reject with words on an item that touches web/ each add one line; a redelivery adds none", async () => {
    const h = await harness();
    const a = await h.itemIn(issueRef(1), SPEC_PENDING, WEB);
    const b = await h.itemIn(issueRef(2), SPEC_PENDING, WEB);
    await h.send(revise(1, "the checkbox is too big"));
    await h.send(revise(1, "the checkbox is too big"));
    await h.send(reject(2, "why show IDs?"));
    const got = await h.lines();
    expect(got.map((l) => [l.work_item_id, l.source, l.words, l.page])).toEqual([
      [a.id, "pushback", "the checkbox is too big", "tasks"],
      [b.id, "pushback", "why show IDs?", "tasks"],
    ]);
    expect(got.every((l) => l.at === h.clock.now().toISOString())).toBe(true);
  });

  it("a correction on an item that does not touch web/ adds no line", async () => {
    const h = await harness();
    await h.itemIn(issueRef(1), SPEC_PENDING, ["src/core/"]);
    await h.send(revise(1, "the checkbox is too big"));
    expect(await h.lines()).toEqual([]);
  });

  it("an explicit `changes` verdict with a reason adds one line; a redelivered verdict adds none", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(3), MERGE_PENDING, WEB, "review");
    await h.send(verdict(3, "changes minor put the chips under the title"));
    await h.send(verdict(3, "changes minor put the chips under the title"));
    expect((await h.lines()).map((l) => [l.work_item_id, l.source, l.words])).toEqual([[it1.id, "verdict", "put the chips under the title"]]);
  });

  it("a design-system finding of a finished review run adds one line with the same fields; other findings add none", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(4), { stage: "REVIEW", blocked_on: "none", blocked_reason: null, change_ref: "42" }, WEB);
    await h.store.enqueueRun({ work_item_id: it1.id, kind: "review", idempotency_key: `review2:${it1.id}` });
    const run = (await h.store.claimRun({ worker_id: w1, kinds: ["review"], lease_ms: 60_000 }))!;
    const review = {
      verdict: "bug", tier: 2, summary: "s",
      findings: [{ kind: "code", text: "breaks decision rule 2 of design-system/patterns.md: one value behind a disclosure" }, { kind: "code", text: "an off-by-one" }],
    };
    await h.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { review } });
    await h.controller.tickRuns();
    await h.controller.tickRuns();
    expect((await h.lines()).map((l) => [l.work_item_id, l.source, l.capture_key, l.page])).toEqual([[it1.id, "review", `review:${run.id}:0`, "tasks"]]);
  });
});

describe("the improve run: counting and the batched commit", () => {
  it("two lines of one kind make one proposal due with both as evidence; a one-off kind makes none", async () => {
    const h = await harness();
    for (const [n, words] of [[1, "the checkbox is too big"], [2, "the icon is too big"], [3, "why show IDs?"]] as const) {
      await h.itemIn(issueRef(n), SPEC_PENDING, WEB);
      await h.send(revise(n, words));
    }
    const [l1, l2] = await h.lines();
    const llm = tagger({ "too big": "control_size", "show IDs": "shown_data" });
    const r = await learnDesign({ store: h.store, llm }, PROJECT_KEY);
    expect(r).toEqual({ tagged: 3, due: [{ kind: "control_size", evidence: [l1!.id, l2!.id] }] });
    // Tagged once: the next run asks nothing and still counts one proposal of the kind.
    expect(await learnDesign({ store: h.store, llm }, PROJECT_KEY)).toEqual({ tagged: 0, due: r.due });
    expect(llm.calls).toHaveLength(3);
  });

  it("filing an improve run's report appends the new lines to design-system/learnings.md in one local commit; the next run adds only newer lines", async () => {
    const h = await harness();
    await h.itemIn(issueRef(1), SPEC_PENDING, WEB);
    await h.send(revise(1, "the checkbox is too big"));
    const improve = async () => {
      const { run } = await enqueueImprove(h, PROJECT_KEY, "manual");
      const claimed = (await h.store.claimRun({ worker_id: w1, kinds: ["improve"], lease_ms: 60_000 }))!;
      const report = await runImprove({ store: h.store, storage: new MemoryStorage(), scanner }, claimed, { project: PROJECT_KEY });
      await h.store.completeRun(claimed.id, claimed.lease!.token, { status: "succeeded", summary: "improve", data: { report_id: report.id } });
      await h.controller.tickRuns();
      await h.controller.tickOutbox();
      h.clock.advance(60_000);
      return run;
    };
    const first = await improve();
    const [l1] = await h.lines();
    const file1 = h.repo.state.files[LEARNINGS_PATH]!;
    expect(file1.startsWith(LEARNINGS_HEAD)).toBe(true);
    expect(file1).toContain(`- ${l1!.id} · `);
    expect(file1).toContain("owner: the checkbox is too big");
    expect((await h.lines()).map((l) => l.batch)).toEqual([first.id]);

    await h.itemIn(issueRef(2), SPEC_PENDING, WEB);
    await h.send(revise(2, "why show IDs?"));
    await improve();
    const file2 = h.repo.state.files[LEARNINGS_PATH]!;
    expect(file2.slice(0, file1.length)).toBe(file1);
    expect(file2.slice(file1.length).split("\n").filter(Boolean)).toHaveLength(1);
    expect(file2).toContain("owner: why show IDs?");

    // A run with nothing new commits nothing.
    const commits = h.repo.state.commits;
    await improve();
    expect(h.repo.state.commits).toBe(commits);
  });
});
