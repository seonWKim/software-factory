import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import type { Run, WorkerId, WorkItem } from "../src/core/types.js";
import { CHEAP_CHECK, Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { PrCheck } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Cheap checks before the reviewer agent (issue #223): an empty diff or a branch already on base blocks on a
// human with empty_diff; an unchanged head keeps the last verdict; the PR's CI results go in the review prompt.

/** A sandbox whose branch diff against base can be emptied. */
class DiffSandbox extends FakeSandbox {
  emptyDiff = false;
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    if (this.emptyDiff && cmd[0] === "git" && cmd[1] === "diff" && cmd[2] === "origin/main...HEAD") {
      this.gitCalls.push(cmd.slice(1).join(" "));
      return { exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false };
    }
    return super.exec(h, cmd, o);
  }
}

/** A forge that also lists each check and its result; null: the source has no check list. */
class ChecksSource extends FakeSource {
  list: PrCheck[] = [];
  listCalls: number[] = [];
  async prCheckList(pr_number: number): Promise<PrCheck[]> {
    this.listCalls.push(pr_number);
    return this.list;
  }
}

type Answer = Record<string, unknown>;
const pass = (): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine" });

async function factory(opts: { reviews?: (Answer | null)[]; cfg?: Partial<FactoryConfig> } = {}) {
  const cfg: FactoryConfig = { ...config, ...opts.cfg };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new ChecksSource();
  const sandbox = new DiffSandbox();
  const broker = new FakeBroker();
  const reviews = [...(opts.reviews ?? [])];
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: reviews.length ? reviews.shift() : pass() }),
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(223);
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  /** Intake, /approve: the implement run and the first review follow. */
  const start = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "301", approver: alice });
    await step();
    return item();
  };
  const runs = async (kind?: Run["kind"]) => (await store.listRuns((await item()).id)).filter((r) => !kind || r.kind === kind);
  const reviewSpecs = () => runner.specs.filter((s) => s.role === "review");
  const reviewComments = () => broker.calls.filter((c) => c.name === "github.comment" && String((c.args as { marker: string }).marker).includes("factory:review:"));
  /** Queues one more review run on the item, as a session finish or resolve does, unblocking it first. */
  const queueReview = async (key: string) => {
    const it = await item();
    const r = await store.transition({
      id: it.id, expected_version: it.version, patch: { stage: "REVIEW", blocked_on: "none", blocked_reason: null },
      actor: { kind: "system", id: "system:test" }, reason: "test_review", enqueue: { kind: "review", idempotency_key: key },
    });
    expect(r.ok).toBe(true);
    await step();
  };
  return { store, source, sandbox, broker, runner, controller, worker, clock, step, start, item, runs, reviewSpecs, reviewComments, queueReview };
}

const emptyDiffComments = (source: FakeSource) => source.comments.filter((c) => c.marker.includes("factory:empty-diff:"));

describe("review cheap checks: nothing to review", () => {
  it("an empty diff against base makes no agent call and blocks on a human with empty_diff", async () => {
    const f = await factory();
    f.sandbox.emptyDiff = true;
    const it = await f.start();
    expect(f.reviewSpecs()).toEqual([]);
    expect(f.reviewComments()).toEqual([]);
    expect(it.blocked_on).toBe("human");
    expect(it.blocked_reason).toBe("empty_diff");
    const review = (await f.runs("review")).at(-1)!;
    expect(review.outcome?.status).toBe("succeeded");
    if (review.outcome?.status === "succeeded") {
      expect(review.outcome.data[CHEAP_CHECK]).toBe("empty_diff");
      expect(review.outcome.data.empty_diff).toBe("empty_diff");
    }
    expect(emptyDiffComments(f.source)).toHaveLength(1);
    expect(emptyDiffComments(f.source)[0]!.body).toContain("is empty");
  });

  it("a branch with no commits ahead of base (already merged) makes no agent call and blocks with empty_diff", async () => {
    const f = await factory();
    f.sandbox.revLists["rev-list origin/main..HEAD"] = [];
    const it = await f.start();
    expect(f.reviewSpecs()).toEqual([]);
    expect(it.blocked_on).toBe("human");
    expect(it.blocked_reason).toBe("empty_diff");
    const review = (await f.runs("review")).at(-1)!;
    if (review.outcome?.status === "succeeded") expect(review.outcome.data.empty_diff).toBe("no_commits_ahead");
    expect(f.sandbox.gitCalls).not.toContain("diff origin/main...HEAD");
    expect(emptyDiffComments(f.source)).toHaveLength(1);
    expect(emptyDiffComments(f.source)[0]!.body).toContain("no commits ahead of `main`");
  });

  it("posts the empty_diff comment once: neither a re-apply nor a repeated run posts it again", async () => {
    const f = await factory();
    f.sandbox.emptyDiff = true;
    await f.start();
    const first = (await f.runs("review")).at(-1)!;
    await f.controller.applyRun(first);
    await f.queueReview("again:review");
    expect((await f.runs("review")).length).toBeGreaterThan(1);
    expect((await f.item()).blocked_reason).toBe("empty_diff");
    expect(emptyDiffComments(f.source)).toHaveLength(1);
    expect(f.reviewSpecs()).toEqual([]);
  });
});

describe("review cheap checks: unchanged head", () => {
  it("a review of the head the last succeeded review saw makes no agent call, posts no review, and keeps the verdict", async () => {
    const f = await factory();
    await f.start();
    expect(f.reviewSpecs()).toHaveLength(1);
    expect(f.reviewComments()).toHaveLength(1);
    const before = await f.item();
    expect(before.blocked_reason).toBe("merge_pending");

    await f.queueReview("same-head:review");
    expect(f.reviewSpecs()).toHaveLength(1);
    expect(f.reviewComments()).toHaveLength(1);
    const last = (await f.runs("review")).at(-1)!;
    expect(last.outcome?.status).toBe("succeeded");
    if (last.outcome?.status === "succeeded") {
      expect(last.outcome.data[CHEAP_CHECK]).toBe("unchanged_head");
      expect(last.outcome.data.review).toBeUndefined();
    }
    // The pass stands: back at the merge gate.
    expect((await f.item()).blocked_reason).toBe("merge_pending");
  });

  it("a new head gets a full review", async () => {
    const f = await factory();
    await f.start();
    f.sandbox.head = "newhead\n";
    await f.queueReview("new-head:review");
    expect(f.reviewSpecs()).toHaveLength(2);
    expect(f.reviewComments()).toHaveLength(2);
  });

  it("a failed review does not count as the last review", async () => {
    const f = await factory();
    // Not the review shape: the run fails with invalid_output, and a retry is queued on the same head.
    f.runner.script.review = () => ({ output: { nonsense: true } });
    await f.start();
    expect(f.reviewSpecs()).toHaveLength(1);
    expect((await f.runs("review")).map((r) => r.outcome?.status)).toContain("failed");

    f.runner.script.review = () => ({ output: pass() });
    f.clock.advance(24 * 3600_000);
    await f.step();
    expect(f.reviewSpecs()).toHaveLength(2);
    expect(f.reviewComments()).toHaveLength(1);
    expect((await f.item()).blocked_reason).toBe("merge_pending");
  });
});

describe("review prompt: CI results", () => {
  it("lists each check's name and result (passed, failed, pending)", async () => {
    const f = await factory();
    f.source.list = [
      { name: "test", result: "failed" },
      { name: "lint", result: "passed" },
      { name: "test-mysql", result: "pending" },
    ];
    await f.start();
    expect(f.source.listCalls).toContain(42);
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    const ci = prompt.indexOf("## CI results");
    const lines = ["- `test`: failed", "- `lint`: passed", "- `test-mysql`: pending"].map((l) => prompt.indexOf(l, ci));
    expect(lines.every((i) => i > ci)).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(ci).toBeLessThan(prompt.indexOf("## Diff"));
  });

  it("says no checks ran when the PR has none", async () => {
    const f = await factory();
    f.source.list = [];
    await f.start();
    const prompt = f.reviewSpecs()[0]!.prompt;
    expect(prompt).toContain("## CI results");
    expect(prompt).toContain("No checks ran on the PR's head commit.");
  });
});

describe("GitHubIssueSource.prCheckList", () => {
  class ChecksClient extends GitHubClient {
    runs: { name: string; status: string; conclusion: string | null }[] = [];
    statuses: { context: string; state: string }[] = [];
    constructor() {
      super({} as GitHubCredentials, "http://unused");
    }
    override async request<T>(method: string, path: string): Promise<T> {
      const bare = path.split("?")[0]!;
      if (method === "GET" && bare === "/repos/o/r/pulls/42") return { number: 42, head: { ref: "factory/wi_a", sha: "h1" } } as T;
      if (method === "GET" && bare === "/repos/o/r/commits/h1/check-runs") {
        return { total_count: this.runs.length, check_runs: path.includes("page=1") ? this.runs : [] } as T;
      }
      if (method === "GET" && bare === "/repos/o/r/commits/h1/status") return { statuses: this.statuses } as T;
      throw new Error(`unexpected ${method} ${path}`);
    }
  }

  it("gives each check run and commit status with its result, in prChecks' order", async () => {
    const client = new ChecksClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    expect(await source.prCheckList(42)).toEqual([]);
    client.runs = [
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "skipped" },
      { name: "test-mysql", status: "in_progress", conclusion: null },
    ];
    client.statuses = [{ context: "ci/legacy", state: "success" }, { context: "ci/old", state: "error" }];
    expect(await source.prCheckList(42)).toEqual([
      { name: "test", result: "failed" },
      { name: "lint", result: "passed" },
      { name: "test-mysql", result: "pending" },
      { name: "ci/legacy", result: "passed" },
      { name: "ci/old", result: "failed" },
    ]);
    expect(await source.prChecks(42)).toEqual({ state: "failed", failed: ["test", "ci/old"] });
  });
});
