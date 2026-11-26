import { describe, expect, it } from "vitest";
import type { Run, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import type { BaseChecks, PrChecks } from "../src/interfaces/forge.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, config, issueRef, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { RecordingGitHubClient } from "./helpers/github.js";
import { newStore } from "./helpers/store.js";

/** A forge whose base branch answers `base` (or throws `baseError`), counting every base read. */
class BaseForge extends FakeForge {
  base: BaseChecks | "pending-forever" = { state: "passed", head_sha: "b1" };
  baseError: Error | null = null;
  baseReads = 0;
  async baseChecks(): Promise<BaseChecks> {
    this.baseReads++;
    if (this.baseError) throw this.baseError;
    return this.base === "pending-forever" ? { state: "pending", head_sha: null } : this.base;
  }
}

/** A forge that can rerun a head's failed jobs and read their log (design 05-ci-gate), recording each call. */
class RerunForge extends BaseForge {
  reruns: string[] = [];
  rerunError: Error | null = null;
  logReads: string[] = [];
  log: string | Error = "";
  /** Per-commit logs, read before `log`. */
  logs: Record<string, string | Error> = {};
  async rerunFailedJobs(head_sha: string): Promise<void> {
    if (this.rerunError) throw this.rerunError;
    this.reruns.push(head_sha);
  }
  async failedJobLog(head_sha: string): Promise<string> {
    this.logReads.push(head_sha);
    const log = this.logs[head_sha] ?? this.log;
    if (log instanceof Error) throw log;
    return log;
  }
}

const failed = (...names: string[]): PrChecks => ({ state: "failed", failed: names });
const redBase = (...names: string[]): BaseChecks => ({ state: "failed", failed: names, head_sha: "b1" });

/** Controller and worker over one store, the forge's PR checks answering `checks`, oldest first, then `passed`. */
async function factory(checks: PrChecks[], opts: { noPush?: boolean; rerun?: boolean; head?: string; before?: (id: string, store: Awaited<ReturnType<typeof newStore>>["store"]) => Promise<void> } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const forge = opts.rerun ? new RerunForge(source, broker.calls) : new BaseForge(source, broker.calls);
  forge.checkResults = checks;
  const scanner = new PatternEgressScanner(async () => []);
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const controllerOver = (g: BaseForge) => new ControllerRole({ store, source, forge: g, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
  const controller = controllerOver(forge);
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent,
    scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  if (opts.noPush) {
    sandbox.commits = [];
    sandbox.revLists["rev-list --reverse --no-merges basesha..HEAD"] = ["c1"];
  }
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  /** Item `n` from its issue through triage, /approve, implement and review. */
  const toReview = async (n: number) => {
    const src = issueRef(n);
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    const id = (await store.getWorkItemBySource("github_issue", src.id))!.id;
    // The PR head stays put whatever the implement runs do, so a second review skips it as unchanged.
    if (opts.noPush) sandbox.branchHeads[`factory/${id}`] = "h1";
    if (opts.head) sandbox.branchHeads[`factory/${id}`] = opts.head;
    await opts.before?.(id, store);
    source.queue.push({ kind: "spec_approved", source: src, comment_id: `${n}00`, approver: alice });
    await step();
    return (await store.getWorkItem(id))!;
  };
  const implementRuns = async (id: string) => (await store.listRuns(id as never)).filter((r: Run) => r.kind === "implement");
  const item = async (id: string) => (await store.getWorkItem(id as never))!;
  /** Another controller over the same store (a restart, or a second replica), with its own forge. */
  const replica = () => {
    const g = new RerunForge(source, broker.calls);
    return { forge: g, controller: controllerOver(g) };
  };
  return { store, forge, controller, toReview, implementRuns, item, step, sandbox, replica, runner };
}

describe("CI gate: a failed check that is red on the base branch", () => {
  it("waits in REVIEW on `main is red: <test>` with no implement run and loop_count unchanged", async () => {
    const f = await factory([failed("test", "lint")]);
    f.forge.base = redBase("lint", "test", "other");
    const it0 = await f.toReview(1);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "main is red: test", loop_count: 0 });
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
    const last = (await f.store.listStateChanges(it0.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "main_red", detail: { failed_checks: JSON.stringify(["test", "lint"]) } });
    expect(last.changes).not.toHaveProperty("loop_count");

    // Still red on the next tick: nothing changes.
    f.forge.checkResults = [failed("test", "lint")];
    await f.controller.tickChecks();
    expect((await f.item(it0.id)).version).toBe(it0.version);
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
  });

  it("resumes through the normal failed-checks path once the base is green: loop_count + 1 and one implement run", async () => {
    const f = await factory([failed("test")]);
    f.forge.base = redBase("test");
    const waiting = await f.toReview(2);
    expect(waiting).toMatchObject({ blocked_reason: "main is red: test", loop_count: 0 });

    f.forge.base = { state: "passed", head_sha: "b2" };
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    const after = await f.item(waiting.id);
    expect(after).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: 1 });
    const runs = await f.implementRuns(waiting.id);
    expect(runs).toHaveLength(2);
    expect(runs.filter((r) => r.status === "queued")).toHaveLength(1);
    expect((await f.store.listStateChanges(waiting.id)).at(-1)).toMatchObject({ reason: "checks_failed", changes: { loop_count: { from: 0, to: 1 } } });
  });

  it("a base red for only some of the failed checks takes the normal loop path", async () => {
    const f = await factory([failed("test", "lint"), { state: "passed" }]);
    f.forge.base = redBase("test");
    const it0 = await f.toReview(3);
    const reasons = (await f.store.listStateChanges(it0.id)).map((c) => c.reason);
    expect(reasons).toContain("checks_failed");
    expect(reasons).not.toContain("main_red");
    expect(it0).toMatchObject({ blocked_reason: "merge_pending", loop_count: 1 });
    expect(await f.implementRuns(it0.id)).toHaveLength(2);
  });

  it.each([
    ["throws", (g: BaseForge) => { g.baseError = new Error("boom"); }],
    ["is pending", (g: BaseForge) => { g.base = "pending-forever"; }],
  ])("a base read that %s takes the normal loop path", async (_name, set) => {
    const f = await factory([failed("test"), { state: "passed" }]);
    set(f.forge);
    const it0 = await f.toReview(4);
    expect(f.forge.baseReads).toBeGreaterThanOrEqual(1);
    expect(it0).toMatchObject({ blocked_reason: "merge_pending", loop_count: 1 });
    expect((await f.store.listStateChanges(it0.id)).map((c) => c.reason)).toContain("checks_failed");
  });

  it("reads the base checks only when the PR checks failed", async () => {
    const f = await factory([{ state: "passed" }]);
    await f.toReview(5);
    expect(f.forge.baseReads).toBe(0);
  });

  it("one checks tick reads the base once for every item waiting on it", async () => {
    const f = await factory([failed("test"), failed("test"), failed("test")]);
    f.forge.base = redBase("test");
    const ids = [(await f.toReview(6)).id, (await f.toReview(7)).id, (await f.toReview(8)).id];
    for (const id of ids) expect(await f.item(id)).toMatchObject({ blocked_on: "ci", blocked_reason: "main is red: test" });

    f.forge.baseReads = 0;
    f.forge.checkResults = [failed("test"), failed("test"), failed("test")];
    await f.controller.tickChecks();
    expect(f.forge.checkCalls.slice(-3)).toEqual([42, 42, 42]);
    expect(f.forge.baseReads).toBe(1);
    // The next tick reads it again.
    f.forge.checkResults = [failed("test"), failed("test"), failed("test")];
    await f.controller.tickChecks();
    expect(f.forge.baseReads).toBe(2);
  });
});

describe("CI gate: failed checks on a review that skipped an unchanged head", () => {
  it("blocks on a human with unchanged_head, starts no run and leaves loop_count unchanged (base green)", async () => {
    const f = await factory([failed("test"), failed("test")], { noPush: true });
    const it0 = await f.toReview(9);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "unchanged_head", loop_count: 1 });
    const runs = await f.store.listRuns(it0.id);
    expect(runs.filter((r) => r.kind === "implement")).toHaveLength(2);
    expect(runs.filter((r) => r.status === "queued" || r.status === "running")).toEqual([]);
    const last = (await f.store.listStateChanges(it0.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "unchanged_head", detail: { unchanged_head: true } });
    expect(last.changes).not.toHaveProperty("loop_count");
    expect(f.forge.baseReads).toBeGreaterThanOrEqual(1);
  });
});

describe("Forge.baseChecks", () => {
  it("the local forge answers passed", async () => {
    expect(await new LocalForge("factory/").baseChecks()).toEqual({ state: "passed", head_sha: null });
  });

  /** Answers the base branch `main` at "b1", and b1's check runs and commit statuses. */
  class BaseClient extends RecordingGitHubClient {
    runs: { name: string; status: string; conclusion: string | null }[] = [];
    statuses: { context: string; state: string }[] = [];
    budgetLow = false;
    override lowBudget(): boolean {
      return this.budgetLow;
    }
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.calls.push({ method, path, body });
      const bare = path.split("?")[0]!;
      if (bare === "/repos/o/r/branches/main") return { name: "main", commit: { sha: "b1" } } as T;
      if (bare === "/repos/o/r/commits/b1/check-runs") return { total_count: this.runs.length, check_runs: this.runs } as T;
      if (bare === "/repos/o/r/commits/b1/status") return { statuses: this.statuses } as T;
      throw new Error(`unexpected ${method} ${path}`);
    }
  }
  const noWrites = { postComment: async () => ({ url: null }), setStatus: async () => undefined };
  const make = () => {
    const client = new BaseClient();
    return { client, forge: new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", noWrites) };
  };

  it("GitHub reads the base head's check runs and statuses, summed up as prChecks are", async () => {
    const { client, forge } = make();
    client.runs = [{ name: "test", status: "completed", conclusion: "failure" }, { name: "ok", status: "completed", conclusion: "success" }];
    client.statuses = [{ context: "ci/legacy", state: "error" }];
    expect(await forge.baseChecks()).toEqual({ state: "failed", failed: ["test", "ci/legacy"], head_sha: "b1" });
    expect(client.calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/repos/o/r/branches/main"],
      ["GET", "/repos/o/r/commits/b1/check-runs?per_page=100&page=1"],
      ["GET", "/repos/o/r/commits/b1/status?per_page=100"],
    ]);
    client.runs = [{ name: "test", status: "in_progress", conclusion: null }];
    client.statuses = [];
    expect(await forge.baseChecks()).toEqual({ state: "pending", head_sha: "b1" });
    client.runs = [];
    expect(await forge.baseChecks()).toEqual({ state: "passed", head_sha: "b1" });
  });

  it("GitHub under the request budget: pending, with no read", async () => {
    const { client, forge } = make();
    client.budgetLow = true;
    expect(await forge.baseChecks()).toEqual({ state: "pending", head_sha: null });
    expect(client.calls).toEqual([]);
  });
});

describe("CI gate: a failed head's jobs are rerun once (design 05-ci-gate, Rerun once)", () => {
  const LOG = [
    "2026-11-18T08:00:01.0000000Z  FAIL  tests/updater.test.ts > updater > sweeps orphans",
    "2026-11-18T08:00:01.0000000Z AssertionError: expected 1 to be 2",
    " FAIL  tests/leak.test.ts > prints a token",
    `Error: token ghp_${"a".repeat(36)} leaked`,
  ].join("\n");
  const rerunForge = (f: { forge: BaseForge }) => f.forge as RerunForge;
  const reasons = async (f: Awaited<ReturnType<typeof factory>>, id: string) => (await f.store.listStateChanges(id as never)).map((c) => c.reason);
  const reruns = async (f: Awaited<ReturnType<typeof factory>>, id: string) =>
    (await f.store.listItemMessages(id as never)).filter((m) => m.marker.includes("factory:checks-rerun:"));

  it("a first failure on a head reruns its failed jobs once and waits on checks_rerun, with no implement run and one comment", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(20);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 0 });
    expect(rerunForge(f).reruns).toEqual(["h1"]);
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
    const last = (await f.store.listStateChanges(it0.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "checks_rerun", detail: { rerun_head: "h1", failed_checks: JSON.stringify(["test"]) } });
    expect(last.changes).not.toHaveProperty("loop_count");
    const comments = await reruns(f, it0.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.marker).toContain(String(last.detail!.review_run_id));
    expect(comments[0]!.body).toContain("reran the failed jobs once");
  });

  it("checks that pass after the rerun go on to merge_pending as if they had passed", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(21);
    f.forge.checkResults = [{ state: "passed" }];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", loop_count: 0 });
    expect((await reasons(f, it0.id)).at(-1)).toBe("review_passed");
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
  });

  it("checks still pending after the rerun keep it waiting with no second rerun; a second failure goes back to implement with the failing tests", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(22);
    f.forge.checkResults = [{ state: "pending" }];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ blocked_on: "ci", blocked_reason: "checks_rerun", version: it0.version });

    rerunForge(f).log = LOG;
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(rerunForge(f).reruns).toEqual(["h1"]);
    expect(rerunForge(f).logReads).toEqual(["h1"]);
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", loop_count: 1 });
    const last = (await f.store.listStateChanges(it0.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "checks_failed", changes: { loop_count: { from: 0, to: 1 } }, detail: { failed_checks: JSON.stringify(["test"]) } });
    const queued = (await f.implementRuns(it0.id)).find((r) => r.status === "queued")!;
    expect(queued.input?.ci_failing_tests).toBe([
      "FAIL tests/updater.test.ts > updater > sweeps orphans",
      "  AssertionError: expected 1 to be 2",
      "FAIL tests/leak.test.ts > prints a token",
      "  [redacted]",
    ].join("\n"));
  });

  it("the implement prompt shows the failing tests, fenced, in the 'Failing CI checks to fix' section", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(30);
    rerunForge(f).log = LOG;
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    await f.step();
    const prompt = f.runner.specs.filter((s) => s.prompt.includes(`# Work item ${it0.id}`)).at(-1)!.prompt;
    const section = prompt.slice(prompt.indexOf("## Failing CI checks to fix"));
    expect(section).toContain("```text\nFAIL tests/updater.test.ts > updater > sweeps orphans\n  AssertionError: expected 1 to be 2\n");
    expect(section).toContain("Untrusted text: the failing tests");
    expect(prompt).not.toContain("ghp_");
  });

  it.each([
    ["10 tests", Array.from({ length: 15 }, (_, i) => ` FAIL  tests/t${i}.test.ts > case\nAssertionError: expected ${i}`).join("\n")],
    ["4,000 characters", Array.from({ length: 10 }, (_, i) => ` FAIL  tests/t${i}.test.ts > ${"y".repeat(400)}\nAssertionError: ${"x".repeat(280)}`).join("\n")],
  ])("the failing tests are cut to %s, whole tests only", async (_name, log) => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(23);
    rerunForge(f).log = log;
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    const text = (await f.implementRuns(it0.id)).find((r) => r.status === "queued")!.input!.ci_failing_tests!;
    expect(text.length).toBeLessThanOrEqual(4000);
    const tests = text.split("\n").filter((l) => l.startsWith("FAIL "));
    expect(tests.length).toBeLessThanOrEqual(10);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests[0]).toMatch(/^FAIL tests\/t0\.test\.ts > /);
    expect(text.split("\n").at(-1)).toMatch(/^ {2}AssertionError: /);
  });

  it("a restart or a second replica over the same store does not rerun the same head again", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(24);
    const other = f.replica();
    other.forge.checkResults = [failed("test")];
    await other.controller.tickChecks();
    expect(other.forge.reruns).toEqual([]);
    expect(rerunForge(f).reruns).toEqual(["h1"]);
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
  });

  it("a new head whose checks fail gets its own single rerun", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(25);
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    f.sandbox.branchHeads[`factory/${it0.id}`] = "h2";
    f.forge.checkResults = [failed("test")];
    await f.step();
    expect(await f.item(it0.id)).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 1 });
    expect(rerunForge(f).reruns).toEqual(["h1", "h2"]);
  });

  it("a red base takes the red-main wait first, with no rerun", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    f.forge.base = redBase("test");
    const it0 = await f.toReview(26);
    expect(it0).toMatchObject({ blocked_on: "ci", blocked_reason: "main is red: test" });
    expect(rerunForge(f).reruns).toEqual([]);
  });

  it("a stored merge check that conflicts for the head takes the update-first path, with no rerun", async () => {
    const f = await factory([failed("test")], {
      rerun: true, head: "h1",
      before: (id, store) => store.recordMergeCheck({ work_item_id: id as never, mergeable: false, conflicts: ["src/a.ts"], head_sha: "h1", base_sha: "b1" }).then(() => undefined),
    });
    const it0 = await f.toReview(27);
    expect(await reasons(f, it0.id)).toContain("update_started");
    expect(await reasons(f, it0.id)).not.toContain("checks_rerun");
    expect(rerunForge(f).reruns).toEqual([]);
  });

  it.each([
    ["has no rerun or log call", { rerun: false }],
    ["throws on the rerun (e.g. a token without Actions write)", { rerun: true }],
  ])("a forge that %s keeps the path as before: checks_failed with the names only, no rerun recorded", async (_name, o) => {
    const f = await factory([failed("test")], { ...o, head: "h1" });
    if (f.forge instanceof RerunForge) f.forge.rerunError = new Error("403 Resource not accessible by integration");
    const it0 = await f.toReview(28);
    expect(it0).toMatchObject({ loop_count: 1 });
    expect(await f.implementRuns(it0.id)).toHaveLength(2);
    expect(await reasons(f, it0.id)).toContain("checks_failed");
    expect(await reasons(f, it0.id)).not.toContain("checks_rerun");
    expect((await f.implementRuns(it0.id)).every((r) => r.input?.ci_failing_tests === undefined)).toBe(true);
  });

  it("a log read that throws after the rerun (e.g. a token without Actions read) sends it back with the names only", async () => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(29);
    rerunForge(f).log = new Error("403 Resource not accessible by integration");
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    expect((await f.implementRuns(it0.id)).find((r) => r.status === "queued")!.input?.ci_failing_tests).toBeUndefined();
  });
});

describe("CI gate: checks that were only cancelled rerun and never count a loop (design 05-ci-gate, Cancelled checks)", () => {
  const cancelled = (...names: string[]): PrChecks => ({ state: "failed", failed: names, cancelled: names });
  const rerunForge = (f: { forge: BaseForge }) => f.forge as RerunForge;
  const reasons = async (f: Awaited<ReturnType<typeof factory>>, id: string) => (await f.store.listStateChanges(id as never)).map((c) => c.reason);

  it("a cancelled check reruns its jobs and waits on checks_rerun; cancelled again it reruns again, with loop_count 0 and no implement run", async () => {
    const f = await factory([cancelled("responsive")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(40);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 0 });
    expect((await f.store.listStateChanges(it0.id)).at(-1)).toMatchObject({ reason: "checks_rerun", detail: { rerun_head: "h1", cancelled: true } });

    f.forge.checkResults = [cancelled("responsive")];
    await f.controller.tickChecks();
    expect(rerunForge(f).reruns).toEqual(["h1", "h1"]);
    expect(await f.item(it0.id)).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 0 });
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
    expect(await reasons(f, it0.id)).not.toContain("checks_failed");
  });

  it("after 3 cancelled reruns of a head it waits on checks_pending with one ci_rerun_failed alert, never max_loops", async () => {
    const f = await factory([cancelled("responsive")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(41);
    for (let i = 0; i < 4; i++) {
      f.forge.checkResults = [cancelled("responsive")];
      await f.controller.tickChecks();
    }
    expect(rerunForge(f).reruns).toEqual(["h1", "h1", "h1"]);
    expect(await f.item(it0.id)).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_pending", loop_count: 0 });
    expect(await reasons(f, it0.id)).not.toContain("max_loops");
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
    const alerts = await f.store.listAlerts({ limit: 10 });
    expect(alerts).toEqual([expect.objectContaining({ pattern: "ci_rerun_failed", pattern_key: `ci_rerun_failed:${it0.id}:h1`, count: 3 })]);
  });

  it("a rerun that throws (the workflow run not finished yet) waits on checks_pending with an alert, then reruns on a later tick", async () => {
    const f = await factory([cancelled("responsive")], { rerun: true, head: "h1" });
    rerunForge(f).rerunError = new Error("no failed GitHub Actions run on h1");
    const it0 = await f.toReview(42);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "checks_pending", loop_count: 0 });
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
    expect(await reasons(f, it0.id)).not.toContain("checks_failed");
    const [alert] = await f.store.listAlerts({ limit: 10 });
    expect(alert).toMatchObject({ pattern: "ci_rerun_failed", error_code: "ci_rerun_failed" });
    expect(alert!.detail).toContain("no failed GitHub Actions run on h1");

    rerunForge(f).rerunError = null;
    f.forge.checkResults = [cancelled("responsive")];
    await f.controller.tickChecks();
    expect(rerunForge(f).reruns).toEqual(["h1"]);
    expect(await f.item(it0.id)).toMatchObject({ blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 0 });
  });

  it("a real failure after a cancelled rerun still gets its own rerun once, then goes back to implement as before", async () => {
    const f = await factory([cancelled("responsive")], { rerun: true, head: "h1" });
    const it0 = await f.toReview(43);
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(rerunForge(f).reruns).toEqual(["h1", "h1"]);
    expect(await f.item(it0.id)).toMatchObject({ blocked_reason: "checks_rerun", loop_count: 0 });
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(rerunForge(f).reruns).toEqual(["h1", "h1"]);
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
  });

  it("cancelled and failed checks together take the failed path: rerun once, then a loop", async () => {
    const f = await factory([{ state: "failed", failed: ["test", "responsive"], cancelled: ["responsive"] }], { rerun: true, head: "h1" });
    const it0 = await f.toReview(44);
    expect((await f.store.listStateChanges(it0.id)).at(-1)!.detail).not.toHaveProperty("cancelled");
    f.forge.checkResults = [{ state: "failed", failed: ["test", "responsive"], cancelled: ["responsive"] }];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
  });
});

describe("CI gate: red main decided per failing test (design 05-ci-gate, Red main)", () => {
  const MAIN_TEST = "tests/ui-health-page.test.tsx > health page > renders";
  const OWN_TEST = "tests/own.test.ts > own > breaks";
  const logOf = (...tests: string[]) => tests.map((t) => ` FAIL  ${t}\nAssertionError: expected 1 to be 2`).join("\n");
  /** A PR at head h1 failing `test`, on a base b1 whose `test` fails with MAIN_TEST. */
  const redMain = async (prTests: string[], n: number) => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const g = f.forge as RerunForge;
    g.base = redBase("test");
    g.logs = { h1: logOf(...prTests), b1: logOf(MAIN_TEST) };
    const it0 = await f.toReview(n);
    return { f, g, it0 };
  };
  const comments = async (f: Awaited<ReturnType<typeof factory>>, id: string, key: string) =>
    (await f.store.listItemMessages(id as never)).filter((m) => m.marker.includes(`factory:${key}:`));

  it("a PR whose only failing test also fails on main stays blocked on main, with no implement run queued", async () => {
    const { f, g, it0 } = await redMain([MAIN_TEST], 40);
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_on: "ci", blocked_reason: "main is red: test", loop_count: 0 });
    expect(g.logReads).toContain("h1");
    expect(g.logReads).toContain("b1");
    expect(g.reruns).toEqual([]);
    expect((await f.implementRuns(it0.id)).filter((r) => r.status === "queued")).toEqual([]);
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ blocked_reason: "main is red: test", version: it0.version });
    expect((await f.implementRuns(it0.id)).filter((r) => r.status === "queued")).toEqual([]);
  });

  it("after main goes green its checks re-run, and a pass moves it to merge", async () => {
    const { f, g, it0 } = await redMain([MAIN_TEST], 41);
    g.base = { state: "passed", head_sha: "b2" };
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ blocked_on: "ci", blocked_reason: "checks_rerun", loop_count: 0 });
    expect(g.reruns).toEqual(["h1"]);
    f.forge.checkResults = [{ state: "passed" }];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", loop_count: 0 });
    expect(await f.implementRuns(it0.id)).toHaveLength(1);
  });

  it("one main-red failure and one of its own: sent back naming only its own failure", async () => {
    const { f, it0 } = await redMain([MAIN_TEST, OWN_TEST], 42);
    expect(it0).toMatchObject({ blocked_reason: "checks_rerun" });
    f.forge.checkResults = [failed("test")];
    await f.controller.tickChecks();
    expect(await f.item(it0.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    const text = (await f.implementRuns(it0.id)).find((r) => r.status === "queued")!.input!.ci_failing_tests!;
    expect(text).toContain(`FAIL ${OWN_TEST}`);
    expect(text).not.toContain(MAIN_TEST);
    const [comment] = await comments(f, it0.id, "checks-failed");
    expect(comment!.body).toContain(OWN_TEST);
    expect(comment!.body).not.toContain(MAIN_TEST);
  });

  it.each([
    ["the PR log cannot be read", (g: RerunForge) => { g.logs.h1 = new Error("403"); }],
    ["the PR log names no test", (g: RerunForge) => { g.logs.h1 = "lint failed"; }],
    ["the base log cannot be read", (g: RerunForge) => { g.logs.b1 = new Error("403"); }],
    ["the base log names no test", (g: RerunForge) => { g.logs.b1 = "no tests here"; }],
  ])("when %s, the check names decide as before", async (_name, set) => {
    const f = await factory([failed("test")], { rerun: true, head: "h1" });
    const g = f.forge as RerunForge;
    g.base = redBase("test");
    g.logs = { h1: logOf(OWN_TEST), b1: logOf(MAIN_TEST) };
    set(g);
    const it0 = await f.toReview(43);
    expect(it0).toMatchObject({ blocked_on: "ci", blocked_reason: "main is red: test", loop_count: 0 });
    expect(g.reruns).toEqual([]);
  });

  it("one checks step reads main's failed job log at most once", async () => {
    const f = await factory([failed("test"), failed("test"), failed("test")], { rerun: true, head: "h1" });
    const g = f.forge as RerunForge;
    g.base = redBase("test");
    g.logs = { h1: logOf(MAIN_TEST), b1: logOf(MAIN_TEST) };
    const ids = [(await f.toReview(44)).id, (await f.toReview(45)).id, (await f.toReview(46)).id];
    for (const id of ids) expect(await f.item(id)).toMatchObject({ blocked_reason: "main is red: test" });
    g.logReads = [];
    f.forge.checkResults = [failed("test"), failed("test"), failed("test")];
    await f.controller.tickChecks();
    expect(g.logReads.filter((s) => s === "b1")).toEqual(["b1"]);
    expect(g.logReads.filter((s) => s === "h1").length).toBeGreaterThan(1);
  });
});
