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
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
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

const failed = (...names: string[]): PrChecks => ({ state: "failed", failed: names });
const redBase = (...names: string[]): BaseChecks => ({ state: "failed", failed: names, head_sha: "b1" });

/** Controller and worker over one store, the forge's PR checks answering `checks`, oldest first, then `passed`. */
async function factory(checks: PrChecks[], opts: { noPush?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const forge = new BaseForge(source, broker.calls);
  forge.checkResults = checks;
  const scanner = new PatternEgressScanner(async () => []);
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
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
    source.queue.push({ kind: "spec_approved", source: src, comment_id: `${n}00`, approver: alice });
    await step();
    return (await store.getWorkItem(id))!;
  };
  const implementRuns = async (id: string) => (await store.listRuns(id as never)).filter((r: Run) => r.kind === "implement");
  const item = async (id: string) => (await store.getWorkItem(id as never))!;
  return { store, forge, controller, toReview, implementRuns, item };
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
