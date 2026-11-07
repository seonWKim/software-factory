import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { Run, WorkerId, WorkItem } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { PrCheckResult } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// The review run's cheap checks before any agent call, and the CI results in the review prompt (issue #223).

type Answer = Record<string, unknown>;
const pass = (): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine" });
const bug = (): Answer => ({ verdict: "bug", tier: 2, findings: [{ kind: "code", text: "off by one" }], summary: "found one" });

/** A FakeSandbox whose PR head, commit count ahead of the base and diff the test sets. */
class ReviewSandbox extends FakeSandbox {
  /** What `git rev-parse origin/<PR branch>` prints; null: the ref does not resolve. */
  prHead: string | null = "h1";
  /** What `git rev-list --count origin/main..HEAD` prints. */
  ahead = "1";
  /** What `git diff origin/main...HEAD` prints. */
  reviewDiff = "+ a change\n";
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const args = cmd.slice(1).join(" ");
    const res = (exit_code: number, stdout = ""): ExecResult => ({ exit_code, signal: null, stdout, stderr: "", timed_out: false });
    if (cmd[0] === "git" && args.startsWith("rev-parse origin/factory/")) {
      this.gitCalls.push(args);
      return this.prHead === null ? res(128) : res(0, `${this.prHead}\n`);
    }
    if (cmd[0] === "git" && args === "rev-list --count origin/main..HEAD") {
      this.gitCalls.push(args);
      return res(0, `${this.ahead}\n`);
    }
    if (cmd[0] === "git" && args === "diff origin/main...HEAD") {
      this.gitCalls.push(args);
      return res(0, this.reviewDiff);
    }
    return super.exec(h, cmd, o);
  }
}

/** A FakeSource that also answers each check's result. */
class ChecksSource extends FakeSource {
  results: PrCheckResult[] = [];
  resultCalls: number[] = [];
  async prCheckResults(pr_number: number): Promise<PrCheckResult[]> {
    this.resultCalls.push(pr_number);
    return this.results;
  }
}

async function factory(opts: { reviews?: (Answer | Error)[]; source?: FakeSource } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = opts.source ?? new FakeSource();
  const sandbox = new ReviewSandbox();
  const broker = new FakeBroker();
  const reviews = [...(opts.reviews ?? [])];
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => {
      const next = reviews.shift() ?? pass();
      if (next instanceof Error) throw next;
      return { output: next };
    },
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(223);
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  /** Intake, /approve: the implement run, then the first review run. */
  const start = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await step();
    return item();
  };
  /** Queues one more review run of the item (as a later push or a re-queue would), unblocked, and runs it. */
  const reviewAgain = async (key: string) => {
    const it0 = await item();
    const r = await store.transition({
      id: it0.id, expected_version: it0.version, patch: { stage: "REVIEW", blocked_on: "none", blocked_reason: null },
      actor: { kind: "system", id: "system:test" }, reason: "test_requeue", enqueue: { kind: "review", idempotency_key: key },
    });
    expect(r.ok).toBe(true);
    await step();
  };
  const runs = async (kind?: Run["kind"]) => (await store.listRuns((await item()).id)).filter((r) => !kind || r.kind === kind);
  const reviewSpecs = () => runner.specs.filter((s) => s.role === "review");
  const reviewComments = () =>
    broker.calls.filter((c) => c.name === "github.comment" && String((c.args as { marker: string }).marker).includes("factory:review:"));
  const messages = async (part: string) => (await store.listItemMessages((await item()).id)).filter((m) => m.marker.includes(part));
  return { store, source, sandbox, broker, runner, clock, step, start, item, reviewAgain, runs, reviewSpecs, reviewComments, messages };
}

describe("review cheap checks: empty diff and an already-merged branch", () => {
  it("an empty diff makes no agent call and blocks on a human with empty_diff, with one comment", async () => {
    const f = await factory();
    f.sandbox.reviewDiff = "";
    const it0 = await f.start();
    expect(f.reviewSpecs()).toHaveLength(0);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "empty_diff" });
    expect(f.reviewComments()).toHaveLength(0);
    const posted = await f.messages("empty_diff");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("PR #42 has no changes against `main`");
    const review = (await f.runs("review"))[0]!;
    expect(review.outcome).toMatchObject({ status: "succeeded", data: { no_agent: "empty_diff", head_sha: "h1" } });
  });

  it("a branch with no commits ahead of the base makes no agent call and no diff, and blocks with empty_diff", async () => {
    const f = await factory();
    f.sandbox.ahead = "0";
    const it0 = await f.start();
    expect(f.reviewSpecs()).toHaveLength(0);
    expect(f.sandbox.gitCalls).not.toContain("diff origin/main...HEAD");
    expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "empty_diff" });
    expect(await f.messages("empty_diff")).toHaveLength(1);
  });

  it("a repeated empty_diff run at the same head posts no second comment", async () => {
    const f = await factory();
    f.sandbox.ahead = "0";
    await f.start();
    await f.reviewAgain("again-1");
    const reviews = await f.runs("review");
    expect(reviews.map((r) => r.idempotency_key)).toContain("again-1");
    expect(reviews.every((r) => r.outcome?.status === "succeeded" && r.outcome.data.no_agent === "empty_diff")).toBe(true);
    expect((await f.item()).blocked_reason).toBe("empty_diff");
    expect(await f.messages("empty_diff")).toHaveLength(1);
    expect(f.source.comments.filter((c) => c.marker.includes("empty_diff"))).toHaveLength(1);
    expect(f.reviewSpecs()).toHaveLength(0);
  });
});

describe("review cheap checks: unchanged head", () => {
  it("a review at the head of the last succeeded review makes no agent call, posts no review, and the verdict stands", async () => {
    const f = await factory({ reviews: [pass()] });
    const it0 = await f.start();
    expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "merge_pending" });
    expect(f.reviewSpecs()).toHaveLength(1);
    expect(f.reviewComments()).toHaveLength(1);
    const mergeComments = (await f.messages("factory:merge:")).length;

    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(1);
    expect(f.reviewComments()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "merge_pending" });
    expect((await f.messages("factory:merge:")).length).toBe(mergeComments);
    const [first, second] = await f.runs("review");
    expect(second!.outcome).toMatchObject({
      status: "succeeded", data: { no_agent: "unchanged_head", head_sha: "h1", reused_review: first!.id },
    });
  });

  it("a new head gets a full review", async () => {
    const f = await factory({ reviews: [pass(), pass()] });
    await f.start();
    f.sandbox.prHead = "h2";
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
    expect(f.reviewComments()).toHaveLength(2);
  });

  it("an unchanged bug verdict stands: it loops back to implement without a new review comment", async () => {
    const f = await factory({ reviews: [bug()] });
    // The fake implementer adds no commit, so the PR head stays h1: every later review keeps the bug verdict
    // without an agent call, and the loops run up to max_loops.
    await f.start();
    expect((await f.runs("implement")).length).toBeGreaterThanOrEqual(2);
    expect(f.reviewSpecs()).toHaveLength(1);
    expect(f.reviewComments()).toHaveLength(1);
    const reused = (await f.runs("review")).filter((r) => r.outcome?.status === "succeeded" && r.outcome.data.no_agent === "unchanged_head");
    expect(reused.length).toBeGreaterThanOrEqual(1);
    expect((await f.item()).blocked_reason).toBe("max_loops");
  });

  it("a failed review does not count as the last review: the retry at the same head calls the agent", async () => {
    const f = await factory({ reviews: [new Error("runner crashed"), pass()] });
    await f.start();
    const failed = (await f.runs("review"))[0]!;
    expect(failed.outcome?.status).toBe("failed");
    f.clock.advance(config.retry_base_ms * 4);
    await f.step();
    expect(f.reviewSpecs()).toHaveLength(2);
    expect(f.reviewComments()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_reason: "merge_pending" });
  });

  it("a PR head that cannot be read never matches: the review calls the agent", async () => {
    const f = await factory({ reviews: [pass(), pass()] });
    f.sandbox.prHead = null;
    await f.start();
    await f.reviewAgain("again-1");
    expect(f.reviewSpecs()).toHaveLength(2);
  });
});

describe("review prompt: CI results", () => {
  it("lists each check's name and result", async () => {
    const source = new ChecksSource();
    source.results = [
      { name: "test", result: "failed" },
      { name: "typecheck", result: "passed" },
      { name: "test-mysql", result: "pending" },
    ];
    const f = await factory({ source });
    await f.start();
    expect(source.resultCalls).toEqual([42]);
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    const lines = ["- test: failed", "- typecheck: passed", "- test-mysql: pending"].map((l) => prompt.indexOf(l));
    expect(lines.every((i) => i > prompt.indexOf("## CI results"))).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(prompt.indexOf("## CI results")).toBeLessThan(prompt.indexOf("## Diff"));
  });

  it("says that no checks ran when the PR has none", async () => {
    const source = new ChecksSource();
    const f = await factory({ source });
    await f.start();
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    expect(prompt).toContain("No CI checks ran on the PR's head commit");
  });

  it("a source without per-check results also says that no checks ran", async () => {
    const f = await factory();
    await f.start();
    expect(f.reviewSpecs()[0]!.prompt).toContain("No CI checks ran on the PR's head commit");
  });

  it("a failed read says the results were not read", async () => {
    const source = new ChecksSource();
    source.prCheckResults = async () => {
      throw new Error("forge down");
    };
    const f = await factory({ source });
    await f.start();
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    expect(prompt).toContain("did not read the PR's CI results");
  });
});

describe("GitHubIssueSource.prCheckResults", () => {
  class ChecksClient extends GitHubClient {
    calls: string[] = [];
    runs: { name: string; status: string; conclusion: string | null }[] = [];
    statuses: { context: string; state: string }[] = [];
    constructor() {
      super({} as GitHubCredentials, "http://unused");
    }
    override async request<T>(method: string, path: string): Promise<T> {
      this.calls.push(`${method} ${path}`);
      const bare = path.split("?")[0]!;
      if (bare === "/repos/o/r/pulls/42") return { number: 42, head: { ref: "factory/wi_a", sha: "h1" } } as T;
      if (bare === "/repos/o/r/commits/h1/check-runs") return { total_count: this.runs.length, check_runs: this.runs } as T;
      if (bare === "/repos/o/r/commits/h1/status") return { statuses: this.statuses } as T;
      throw new Error(`unexpected ${method} ${path}`);
    }
  }
  const make = () => {
    const client = new ChecksClient();
    return { client, source: new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main") };
  };

  it("names every check run and status with its result, by the CI gate's rules", async () => {
    const { client, source } = make();
    client.runs = [
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "skipped" },
      { name: "test-mysql", status: "in_progress", conclusion: null },
    ];
    client.statuses = [{ context: "ci/legacy", state: "error" }, { context: "ci/ok", state: "success" }, { context: "ci/wait", state: "pending" }];
    expect(await source.prCheckResults(42)).toEqual([
      { name: "test", result: "failed" },
      { name: "lint", result: "passed" },
      { name: "test-mysql", result: "pending" },
      { name: "ci/legacy", result: "failed" },
      { name: "ci/ok", result: "passed" },
      { name: "ci/wait", result: "pending" },
    ]);
    expect(await source.prChecks(42)).toEqual({ state: "failed", failed: ["test", "ci/legacy"] });
  });

  it("is empty when no check ran", async () => {
    const { source } = make();
    expect(await source.prCheckResults(42)).toEqual([]);
  });
});

describe("prompts/review.md", () => {
  const text = readFileSync("prompts/review.md", "utf8");

  it("tells the reviewer to read the CI results and to run tests only to confirm a specific finding", () => {
    expect(text).toMatch(/Read the "CI results" section/);
    expect(text).toMatch(/Run tests only to confirm a specific finding/);
    expect(text).not.toMatch(/Run the tests \(`npm test`/);
  });

  it("puts notes that are not findings in the summary", () => {
    expect(text).toMatch(/a note that is not one \(for example "needs a human merge", "not a defect"[^)]*\) goes in `summary`, not in findings/);
  });
});
