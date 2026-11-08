import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import { FakeGitHubClient, pipeline, runComments, waitFor } from "./helpers/fakes.js";

// The review run's cheap checks before any agent call, and the CI results in the review prompt (issue #223).

type Answer = Record<string, unknown>;
const pass = (): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine" });
const bug = (): Answer => ({ verdict: "bug", tier: 2, findings: [{ kind: "code", text: "off by one" }], summary: "found one" });

/** The whole loop on the shared fakes, with the review answers given in order (an Error: the runner throws). */
async function factory(reviews: (Answer | Error)[] = []) {
  const p = await pipeline();
  const answers = [...reviews];
  p.runner.script.review = () => {
    const next = answers.shift() ?? pass();
    if (next instanceof Error) throw next;
    return { output: next };
  };
  let it0: WorkItem | null = null;
  const item = async () => p.item(it0!);
  /** Moves the PR branch's pushed head (what the review reads as its head). */
  let head = "h1";
  const setHead = (sha: string) => {
    head = sha;
    if (it0) p.sandbox.branchHeads[`factory/${it0.id}`] = sha;
  };
  /** Intake, triage (auto-approved), the implement run, then the first review run. */
  const start = async () => {
    it0 = await p.submit();
    setHead(head);
    await p.step();
    return item();
  };
  /** Queues one more review run of the item (as a later push would), unblocked, and runs it. */
  const reviewAgain = async (key: string) => {
    const cur = await item();
    const r = await p.store.transition({
      id: cur.id, expected_version: cur.version, patch: { stage: "REVIEW", blocked_on: "none", blocked_reason: null },
      actor: { kind: "system", id: "system:test" }, reason: "test_requeue", enqueue: { kind: "review", idempotency_key: key },
    });
    expect(r.ok).toBe(true);
    await p.step();
  };
  const runs = async (kind?: "review" | "implement") => p.runs(await item(), kind);
  const reviewSpecs = () => p.runner.specs.filter((s) => s.role === "review");
  const reviewComments = async () => (await runComments(p.store, (await item()).id)).filter((c) => c.pr && c.marker.includes("factory:review:"));
  const messages = async (part: string) => (await p.store.listItemMessages((await item()).id)).filter((m) => m.marker.includes(part));
  return { ...p, start, item, setHead, reviewAgain, runs, reviewSpecs, reviewComments, messages };
}

describe("review cheap checks: empty diff and an already-merged branch", () => {
  it("an empty diff makes no agent call and blocks on a human with empty_diff, with one comment", async () => {
    const f = await factory();
    f.sandbox.diff = "";
    const it0 = await f.start();
    expect(f.reviewSpecs()).toHaveLength(0);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "empty_diff" });
    expect((await f.reviewComments())).toHaveLength(0);
    const posted = await f.messages("empty_diff");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("PR #42 has no changes against `main`");
    const review = (await f.runs("review"))[0]!;
    expect(review.outcome).toMatchObject({ status: "succeeded", data: { no_agent: "empty_diff", head_sha: "h1" } });
  });

  it("a branch with no commits ahead of the base makes no agent call and no diff, and blocks with empty_diff", async () => {
    const f = await factory();
    f.sandbox.revLists["rev-list --count origin/main..HEAD"] = ["0"];
    const it0 = await f.start();
    expect(f.reviewSpecs()).toHaveLength(0);
    expect(f.sandbox.gitCalls).toContain("rev-list --count origin/main..HEAD");
    expect(f.sandbox.gitCalls).not.toContain("diff origin/main...HEAD");
    expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "empty_diff" });
    expect(await f.messages("empty_diff")).toHaveLength(1);
  });

  it("a repeated empty_diff run for the same item posts no other comment, also at another head", async () => {
    const f = await factory();
    f.sandbox.diff = "";
    await f.start();
    const before = (await f.store.listItemMessages((await f.item()).id)).length;
    f.setHead("h2");
    await f.reviewAgain("again-1");
    const reviews = await f.runs("review");
    expect(reviews.map((r) => r.idempotency_key)).toContain("again-1");
    expect(reviews.every((r) => r.outcome?.status === "succeeded" && r.outcome.data.no_agent === "empty_diff")).toBe(true);
    expect((await f.item()).blocked_reason).toBe("empty_diff");
    expect(await f.messages("empty_diff")).toHaveLength(1);
    expect((await f.store.listItemMessages((await f.item()).id)).length).toBe(before);
    expect(f.reviewSpecs()).toHaveLength(0);
  });
});

describe("review cheap checks: unchanged head", () => {
  it("a review at the head of the last verdict makes no agent call, posts no review and keeps the item's state", async () => {
    const f = await factory([pass()]);
    const it0 = await f.start();
    expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "merge_pending" });
    expect(f.reviewSpecs()).toHaveLength(1);
    expect((await f.reviewComments())).toHaveLength(1);
    expect((await f.runs("review"))[0]!.outcome).toMatchObject({ status: "succeeded", data: { head_sha: "h1" } });

    // Requeued unblocked: the unchanged head leaves that state as it is (no verdict replay).
    await f.reviewAgain("again-1");
    const after = await f.item();
    const messages = (await f.store.listItemMessages(after.id)).length;
    expect(f.reviewSpecs()).toHaveLength(1);
    expect((await f.reviewComments())).toHaveLength(1);
    expect(after).toMatchObject({ stage: "REVIEW", blocked_on: "none", blocked_reason: null });
    const again = (await f.runs("review")).find((r) => r.idempotency_key === "again-1")!;
    expect(again.outcome).toMatchObject({ status: "succeeded", data: { no_agent: "unchanged_head", head_sha: "h1" } });
    expect(again.acknowledged_at).not.toBeNull();
    // A third run at the same head still matches the verdict review, not the no-agent one.
    await f.reviewAgain("again-2");
    expect(f.reviewSpecs()).toHaveLength(1);
    expect((await f.store.listItemMessages(after.id)).length).toBe(messages);
  });

  it("a new head gets a full review", async () => {
    const f = await factory([pass(), pass()]);
    await f.start();
    f.setHead("h2");
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
    expect((await f.reviewComments())).toHaveLength(2);
  });

  it("a PR head that cannot be read never matches: the review calls the agent", async () => {
    const f = await factory([pass(), pass()]);
    await f.start();
    f.sandbox.branchHeads = {};
    await f.reviewAgain("again-1");
    await f.reviewAgain("again-2");
    expect(f.reviewSpecs()).toHaveLength(3);
  });

  it("an unchanged head after a bug verdict runs no agent and leaves the item where it is", async () => {
    const f = await factory([bug()]);
    // The fake implementer moves no head, so the review after the loop sees the head the bug verdict was for.
    await f.start();
    expect(f.reviewSpecs()).toHaveLength(1);
    expect((await f.reviewComments())).toHaveLength(1);
    const reviews = await f.runs("review");
    expect(reviews.map((r) => r.outcome?.status === "succeeded" && r.outcome.data.no_agent)).toEqual([undefined, "unchanged_head"]);
    expect(await f.item()).toMatchObject({ stage: "REVIEW", loop_count: 1, blocked_on: "none" });
  });

  it("a failed review does not count: the retry at the same head calls the agent", async () => {
    const f = await factory([new Error("runner crashed"), pass()]);
    await f.start();
    expect((await f.runs("review"))[0]!.outcome?.status).toBe("failed");
    f.clock.advance(f.config.retry_base_ms * 4);
    await f.step();
    expect(f.reviewSpecs()).toHaveLength(2);
    expect((await f.reviewComments())).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_reason: "merge_pending" });
  });

  it("a needs_human review does not count: a later review at the same head calls the agent", async () => {
    const f = await factory([{ ...pass(), needs_human: { reason: "no access", question: "grant it?" } }, pass()]);
    await f.start();
    expect((await f.item()).blocked_on).toBe("human");
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
    expect((await f.reviewComments())).toHaveLength(1);
  });

  it("an egress-blocked review does not count: a later review at the same head calls the agent", async () => {
    const f = await factory([{ ...bug(), findings: [{ kind: "code", text: `${"AKIA"}${"ABCDEFGHIJKLMNOP"} leaked` }] }, pass()]);
    await f.start();
    expect((await f.item()).blocked_reason).toBe("run_failed:review:egress_blocked");
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
  });

  it("a verdict stored before head SHAs were recorded never matches (no backfill)", async () => {
    const f = await factory([pass(), pass()]);
    const it0 = await f.start();
    // A later verdict review in the shape stored before this change: no head_sha in its outcome.
    const { run } = await f.store.enqueueRun({ work_item_id: it0.id, kind: "review", idempotency_key: "old" });
    const claimed = await f.store.claimRun({ worker_id: "old-worker" as WorkerId, kinds: ["review"], lease_ms: f.config.lease_ms });
    expect(claimed?.id).toBe(run.id);
    expect((await f.store.completeRun(run.id, claimed!.lease!.token, { status: "succeeded", summary: "", data: { review: pass() } })).ok).toBe(true);
    await f.step();
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
    expect((await f.store.getRun(run.id))!.outcome).toEqual({ status: "succeeded", summary: "", data: { review: pass() } });
  });

  it("a paused review that resumes its session is not skipped, even at the last verdict's head", async () => {
    const f = await factory([pass()]);
    await f.start();
    expect(f.reviewSpecs()).toHaveLength(1);
    // The next review starts at a new head and is paused mid-run, its session kept on this host.
    Object.assign(f.runner, { hasSession: async () => true });
    let held = false;
    f.runner.script.review = async (spec) => {
      if (!spec.session?.resume) {
        held = true;
        await new Promise<void>((resolve) => spec.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "aborted", last_note: "next: read the diff" };
      }
      return { output: pass() };
    };
    f.setHead("h2");
    const cur = await f.item();
    await f.store.transition({
      id: cur.id, expected_version: cur.version, patch: { blocked_on: "none", blocked_reason: null },
      actor: { kind: "system", id: "system:test" }, reason: "test_requeue", enqueue: { kind: "review", idempotency_key: "paused" },
    });
    const tick = f.w1.tick();
    await waitFor(() => held, "the review to start");
    await f.store.pauseWorkers({ count: 1 }, "github:1");
    f.clock.advance(f.config.tick_ms);
    await tick;
    const paused = (await f.runs("review")).find((r) => r.idempotency_key === "paused")!;
    expect(paused).toMatchObject({ status: "queued" });
    expect(paused.resume).not.toBeNull();

    // Back at the head the last verdict was for: the resumed session still runs.
    f.setHead("h1");
    await f.store.resumeWorkers();
    await f.step();
    expect(f.reviewSpecs()).toHaveLength(3);
    expect(f.reviewSpecs().at(-1)!.session?.resume).toBe(true);
    const done = (await f.store.getRun(paused.id))!;
    expect(done.outcome).toMatchObject({ status: "succeeded", data: { head_sha: "h1" } });
    expect(done.outcome?.status === "succeeded" && done.outcome.data.no_agent).toBeUndefined();
  });
});

describe("review prompt: CI results", () => {
  it("lists each check's name and result, read through the forge when the review is queued", async () => {
    const f = await factory();
    f.forge.checkList = [
      { name: "test", result: "failed" },
      { name: "typecheck", result: "passed" },
      { name: "test-mysql", result: "pending" },
    ];
    await f.start();
    expect(f.forge.checkResultCalls).toEqual([42]);
    const review = (await f.runs("review"))[0]!;
    expect(review.input?.ci_checks).toEqual(f.forge.checkList);
    const prompt = f.reviewSpecs()[0]!.prompt;
    const at = prompt.indexOf("## CI results");
    expect(at).toBeGreaterThan(-1);
    expect(prompt).toContain("Untrusted text: the check names");
    const lines = ["- test: failed", "- typecheck: passed", "- test-mysql: pending"].map((l) => prompt.indexOf(l));
    expect(lines.every((i) => i > at)).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(at).toBeLessThan(prompt.indexOf("## Diff"));
  });

  it("says that no checks ran when the PR has none", async () => {
    const f = await factory();
    await f.start();
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    expect(prompt).toContain("No CI checks ran on the head commit");
  });

  it("a failed read says the CI results could not be read, and the review still runs", async () => {
    const f = await factory();
    f.forge.checkListError = new Error("forge down");
    await f.start();
    expect(f.reviewSpecs()).toHaveLength(1);
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    expect(prompt).toContain("The CI results could not be read for this review.");
    expect((await f.runs("review"))[0]!.input?.ci_checks).toBeNull();
    expect(f.log.lines.some((l) => l.msg === "reading PR check results failed")).toBe(true);
  });
});

describe("GitHubForge.prCheckResults", () => {
  const make = () => {
    const client = new FakeGitHubClient();
    client.pullHeads.set(42, "h1");
    const noWrites = { postComment: async () => ({ url: null }), setStatus: async () => undefined };
    return { client, forge: new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", noWrites) };
  };

  it("names every check run and status with its result, and prChecks sums up the same read", async () => {
    const { client, forge } = make();
    client.checkRuns.set("h1", [
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "skipped" },
      { name: "test-mysql", status: "in_progress", conclusion: null },
    ]);
    client.statuses.set("h1", [{ context: "ci/legacy", state: "error" }, { context: "ci/ok", state: "success" }, { context: "ci/wait", state: "pending" }]);
    expect(await forge.prCheckResults(42)).toEqual([
      { name: "test", result: "failed" },
      { name: "lint", result: "passed" },
      { name: "test-mysql", result: "pending" },
      { name: "ci/legacy", result: "failed" },
      { name: "ci/ok", result: "passed" },
      { name: "ci/wait", result: "pending" },
    ]);
    expect(await forge.prChecks(42)).toEqual({ state: "failed", failed: ["test", "ci/legacy"] });
    expect(client.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("is empty when no check ran, which prChecks reads as passed", async () => {
    const { forge } = make();
    expect(await forge.prCheckResults(42)).toEqual([]);
    expect(await forge.prChecks(42)).toEqual({ state: "passed" });
  });
});

describe("prompts/review.md", () => {
  const text = readFileSync("prompts/review.md", "utf8");

  it("tells the reviewer to read the CI results and to run tests only to confirm a specific finding", () => {
    expect(text).toMatch(/Read the "CI results" section/);
    expect(text).toMatch(/Run tests only to confirm a specific finding/);
    expect(text).not.toMatch(/Write acceptance tests of your own/);
  });

  it("puts notes that are not findings in the summary", () => {
    expect(text).toMatch(/a note that is not one \(for example "needs a human merge", "not a defect"[^)]*\) goes in `summary`, not in findings/);
  });
});
