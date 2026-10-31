import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItemId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeAuth, FakeRunner, FakeSource, MemoryStorage, alice, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function commitFile(repo: string, path: string, content: string, msg: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", msg);
}

/** Records every exec, so tests can see the test command's argv and env. */
class RecordingSandbox extends NoOpSandbox {
  execs: { cmd: string[]; env: Readonly<Record<string, string>> }[] = [];
  override exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    this.execs.push({ cmd: [...cmd], env: o.env });
    return super.exec(h, cmd, o);
  }
}

/** Like the real broker's push_branch (never a force push), but to the local bare remote with no credential. */
class GitPushBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: Record<string, unknown> }[] = [];
  pushError: { error_code: string; message: string } | null = null;

  listTools(): ToolDescriptor[] {
    return [];
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const a = args as Record<string, unknown>;
    this.calls.push({ ctx, name, args: a });
    if (name === "github.push_branch") {
      if (this.pushError) return { ok: false, ...this.pushError };
      const workdir = String(a.workdir);
      git(workdir, "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: { sha: git(workdir, "rev-parse", "HEAD") } };
    }
    return { ok: true, content: {} };
  }
  pushes() {
    return this.calls.filter((c) => c.name === "github.push_branch");
  }
  comments() {
    return this.calls.filter((c) => c.name === "github.comment");
  }
}

type Scenario = "clean" | "conflict";

/**
 * A bare origin, a factory/<id> branch with one commit, and main advanced after it: a change to another
 * file ("clean") or to the same files ("conflict"). The item waits for a human merge of PR 42.
 */
async function setup(scenario: Scenario, opts: { testCommand?: string[] } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const created = (await store.createWorkItem(issue(7), system)).item;
  const moved = await store.transition({
    id: created.id,
    expected_version: created.version,
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 },
    actor: system,
    reason: "test_setup",
  });
  if (!moved.ok) throw new Error("setup transition failed");
  const id = created.id;
  const branch = `factory/${id}`;

  const root = mkdtempSync(join(tmpdir(), "sf-update-"));
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  git(dev, "config", "user.email", "t@example.com");
  git(dev, "config", "user.name", "t");
  commitFile(dev, "README.md", "hi\n", "init");
  commitFile(dev, "a.txt", "a\n", "a");
  commitFile(dev, "src/c.txt", "c\n", "c");
  git(dev, "push", "--quiet", "origin", "main");

  git(dev, "checkout", "--quiet", "-b", branch);
  if (scenario === "clean") commitFile(dev, "feature.txt", "feature\n", "feature");
  else {
    writeFileSync(join(dev, "a.txt"), "branch a\n");
    commitFile(dev, "src/c.txt", "branch c\n", "branch edits a and c");
  }
  git(dev, "push", "--quiet", "origin", branch);
  const branchSha = git(dev, "rev-parse", "HEAD");

  git(dev, "checkout", "--quiet", "main");
  if (scenario === "clean") commitFile(dev, "other.txt", "other\n", "main moves on");
  else {
    writeFileSync(join(dev, "a.txt"), "main a\n");
    commitFile(dev, "src/c.txt", "main c\n", "main edits a and c");
  }
  git(dev, "push", "--quiet", "origin", "main");
  const mainSha = git(dev, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", origin, repo);

  const cfg: FactoryConfig = {
    ...config,
    repo: { ...config.repo, path: repo, test_command: opts.testCommand ?? ["sh", "-c", "exit 0"] },
  };
  const source = new FakeSource();
  // Inside the checkout, as in production (.worktrees): NoOpSandbox.destroy runs `git worktree remove` from there.
  const sandbox = new RecordingSandbox(join(repo, ".worktrees"));
  const broker = new GitPushBroker();
  const runner = new FakeRunner({}); // no script: any agent start throws
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts: {
      triage: "T", implement: "I", review: "R",
    }, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const event = (head_sha = "h1", base_sha = "b1"): SourceEvent => ({
    kind: "pr_unmergeable", pr_number: 42, head_branch: branch, head_sha, base_sha,
  });
  const remoteSha = () => git(origin, "rev-parse", `refs/heads/${branch}`);
  const updateRuns = async () => (await store.listRuns(id)).filter((r) => r.kind === "update");
  const reasons = async () =>
    (await store.listStateChanges(id)).map((c) => c.reason).filter((r) => r.startsWith("update_") || r.startsWith("run_") || r === "retry_requested");
  return {
    store, source, sandbox, broker, runner, controller, worker, step, event, id: id as WorkItemId, branch,
    origin, branchSha, mainSha, remoteSha, updateRuns, reasons, toolEnv,
  };
}

describe("update run: pr_unmergeable", () => {
  it("enqueues exactly one update run with the event's key, however often the event arrives", async () => {
    const f = await setup("clean");
    f.source.queue.push(f.event(), f.event());
    await f.controller.tickIntake();
    f.source.queue.push(f.event());
    await f.controller.tickIntake();

    const runs = await f.updateRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.idempotency_key).toBe(`${f.id}:update:42:h1:b1`);
    expect((await f.store.listStateChanges(f.id)).filter((c) => c.reason === "update_started")).toHaveLength(1);
    const item = (await f.store.getWorkItem(f.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });

    // Delivered again after the run finished: still one run, one update_started.
    await f.step();
    f.source.queue.push(f.event());
    await f.step();
    expect(await f.updateRuns()).toHaveLength(1);
    expect((await f.store.listStateChanges(f.id)).filter((c) => c.reason === "update_started")).toHaveLength(1);
  });

  it("does nothing for an item that is not waiting for a merge of that PR", async () => {
    const f = await setup("clean");
    const cases = [
      { stage: "REVIEW", blocked_on: "none", blocked_reason: null, pr_number: 42 },
      { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", pr_number: 42 },
      { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 41 },
      { stage: "RUNNING", blocked_on: "none", blocked_reason: null, pr_number: 42 },
      { stage: "CLOSED", blocked_on: "none", blocked_reason: null, pr_number: 42 },
    ] as const;
    for (const patch of cases) {
      const it0 = (await f.store.getWorkItem(f.id))!;
      const r = await f.store.transition({ id: f.id, expected_version: it0.version, patch, actor: system, reason: "test_setup" });
      if (!r.ok) throw new Error("transition failed");
      f.source.queue.push(f.event());
      await f.controller.tickIntake();
      expect((await f.store.getWorkItem(f.id))!.version, JSON.stringify(patch)).toBe(r.item.version);
    }
    expect(await f.updateRuns()).toHaveLength(0);
  });
});

describe("update run: worker", () => {
  it("clean merge with passing tests: pushes the merge commit, comments, stays merge_pending", async () => {
    const f = await setup("clean");
    f.source.queue.push(f.event());
    await f.step();

    const head = f.remoteSha();
    expect(head).not.toBe(f.branchSha);
    expect(git(f.origin, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([f.branchSha, f.mainSha]);

    expect(f.broker.pushes()).toHaveLength(1);
    const [run] = await f.updateRuns();
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(run!.acknowledged_at).not.toBeNull();
    const comments = f.broker.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args).toMatchObject({ number: 42, marker: `<!-- factory:update:${run!.id} -->` });
    expect(String(comments[0]!.args.body)).toContain("updated with main");

    expect((await f.store.getWorkItem(f.id))!).toMatchObject({
      stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending",
    });
    expect(await f.reasons()).toEqual(["update_started", "update_pushed"]);
    const actors = (await f.store.listStateChanges(f.id)).filter((c) => c.reason.startsWith("update_")).map((c) => c.actor.id);
    expect(actors).toEqual(["system:controller", "system:controller"]);

    // No agent; the test command ran in the worktree with the worker's toolEnv and no token.
    expect(f.runner.specs).toHaveLength(0);
    const tests = f.sandbox.execs.filter((e) => e.cmd.join(" ") === "sh -c exit 0");
    expect(tests).toHaveLength(1);
    expect(tests[0]!.env).toEqual(f.toolEnv);
    expect(Object.keys(tests[0]!.env)).not.toContain("GITHUB_TOKEN");
  });

  it("conflict: no push, merge_conflict_pending, and a comment listing every conflicting file", async () => {
    const f = await setup("conflict");
    f.source.queue.push(f.event());
    await f.step();

    expect(f.remoteSha()).toBe(f.branchSha);
    expect(f.broker.pushes()).toHaveLength(0);
    expect((await f.store.getWorkItem(f.id))!).toMatchObject({
      stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending",
    });
    const [run] = await f.updateRuns();
    const comments = f.broker.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args.marker).toBe(`<!-- factory:update:${run!.id} -->`);
    const files = String(comments[0]!.args.body).split("\n").flatMap((l) => /^- `(.+)`$/.exec(l)?.[1] ?? []);
    expect(files).toEqual(["a.txt", "src/c.txt"]);
    expect(await f.reasons()).toEqual(["update_started", "update_conflict"]);
    expect(f.runner.specs).toHaveLength(0);
  });

  it("clean merge but failing tests: no push, merge_conflict_pending, comment says the tests failed", async () => {
    const f = await setup("clean", { testCommand: ["sh", "-c", "exit 1"] });
    f.source.queue.push(f.event());
    await f.step();

    expect(f.remoteSha()).toBe(f.branchSha);
    expect(f.broker.pushes()).toHaveLength(0);
    expect((await f.store.getWorkItem(f.id))!).toMatchObject({
      stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending",
    });
    const [run] = await f.updateRuns();
    const comments = f.broker.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args.marker).toBe(`<!-- factory:update:${run!.id} -->`);
    const body = String(comments[0]!.args.body);
    expect(body).toContain("tests failed on the updated branch");
    expect(body.toLowerCase()).not.toContain("conflict");
    expect(await f.reasons()).toEqual(["update_started", "update_tests_failed"]);
  });

  it("base already in the branch (after our own push): pushes nothing, posts nothing, stays merge_pending", async () => {
    const f = await setup("clean");
    f.source.queue.push(f.event());
    await f.step();
    const pushed = f.remoteSha();
    expect(f.broker.pushes()).toHaveLength(1);
    expect(f.broker.comments()).toHaveLength(1);

    // GitHub has not recomputed mergeability yet and reports our new head as unmergeable.
    f.source.queue.push(f.event("h2", "b1"));
    await f.step();

    const runs = await f.updateRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.outcome).toMatchObject({ status: "succeeded", data: { result: "up_to_date" } });
    expect(f.broker.pushes()).toHaveLength(1);
    expect(f.broker.comments()).toHaveLength(1);
    expect(f.remoteSha()).toBe(pushed);
    expect((await f.store.getWorkItem(f.id))!).toMatchObject({
      stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending",
    });
  });

  it("push error: run fails, run_failed:update:<code>; /retry re-enqueues an update run that then pushes", async () => {
    const f = await setup("clean");
    f.broker.pushError = { error_code: "push_failed", message: "remote rejected" };
    f.source.queue.push(f.event());
    await f.step();

    let runs = await f.updateRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toMatchObject({ status: "failed", error_code: "push_failed" });
    let item = (await f.store.getWorkItem(f.id))!;
    expect(item).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:update:push_failed", restart_count: 0 });
    expect(f.remoteSha()).toBe(f.branchSha);

    f.broker.pushError = null;
    f.source.queue.push({ kind: "retry_requested", source: item.source, comment_id: "900", requester: alice });
    await f.step();

    runs = await f.updateRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.idempotency_key).toBe(`${f.id}:update:l0:r1`);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    item = (await f.store.getWorkItem(f.id))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", restart_count: 1 });
    expect(f.remoteSha()).not.toBe(f.branchSha);
    expect(await f.reasons()).toEqual(["update_started", "run_failed", "retry_requested", "update_pushed"]);
  });

  it("origin unreachable: run fails with a git error and blocks on a human", async () => {
    const f = await setup("clean");
    rmSync(f.origin, { recursive: true, force: true });
    f.source.queue.push(f.event());
    await f.step();

    const [run] = await f.updateRuns();
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "git_failed" });
    expect((await f.store.getWorkItem(f.id))!).toMatchObject({
      stage: "REVIEW", blocked_on: "human", blocked_reason: "run_failed:update:git_failed",
    });
    expect(f.broker.pushes()).toHaveLength(0);
  });
});

describe("repo.test_command config", () => {
  const REAL = JSON.parse(readFileSync(resolve("factory.config.json"), "utf8")) as Record<string, unknown> & {
    repo: Record<string, unknown>;
  };

  function root(cfg: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-cfg-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...cfg, store: { type: "sqlite" }, state_dir: "state" }));
    return dir;
  }
  const withTestCommand = (value: unknown) => ({ ...REAL, repo: { ...REAL.repo, test_command: value } });
  const withoutTestCommand = () => {
    const { test_command: _, ...repo } = REAL.repo;
    return { ...REAL, repo };
  };

  it("the checked-in config sets [\"npm\",\"test\"]", async () => {
    expect(REAL.repo.test_command).toEqual(["npm", "test"]);
    expect((await loadConfig(root(REAL), { platform: "linux" })).config.repo.test_command).toEqual(["npm", "test"]);
  });

  it("defaults to [\"npm\",\"test\"] when the key is absent, and passes a set value through", async () => {
    expect((await loadConfig(root(withoutTestCommand()), { platform: "linux" })).config.repo.test_command).toEqual(["npm", "test"]);
    expect((await loadConfig(root(withTestCommand(["make", "check"])), { platform: "linux" })).config.repo.test_command).toEqual([
      "make", "check",
    ]);
  });

  it("rejects an empty array or a non-string entry at startup", async () => {
    for (const bad of [[], ["npm", 1], "npm test", [""]]) {
      await expect(loadConfig(root(withTestCommand(bad)), { platform: "linux" }), JSON.stringify(bad)).rejects.toThrow(
        /repo\.test_command/,
      );
    }
  });
});
