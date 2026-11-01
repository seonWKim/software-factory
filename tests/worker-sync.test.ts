import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeAuth, FakeRunner, FakeSource, MemoryStorage, alice, cleanScanner, config, gates, issueRef, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Sync before push (design §4, decided 2026-11-01): an implement run merges the freshly fetched
// origin/<base> into its branch before the pre-push checks, and resolves a conflict in the same run.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const AGENT_ENV = {
  ...GIT_ENV,
  GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: AGENT_ENV }).trim();
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commitFile(repo: string, path: string, content: string, msg: string): string {
  write(repo, path, content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Records every exec, so tests can see the order of git commands and the test command. */
class RecordingSandbox extends NoOpSandbox {
  execs: string[] = [];
  override exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    this.execs.push(cmd.join(" "));
    return super.exec(h, cmd, o);
  }
}

/** Like the real broker's push_branch (never a force push), but to the local bare remote. */
class GitPushBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: Record<string, unknown> }[] = [];
  listTools(): ToolDescriptor[] {
    return [];
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const a = args as Record<string, unknown>;
    this.calls.push({ ctx, name, args: a });
    if (name === "github.push_branch") {
      const workdir = String(a.workdir);
      git(workdir, "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: {} };
    }
    if (name === "github.open_pr") return { ok: true, content: { number: 42 } };
    return { ok: true, content: {} };
  }
  names() {
    return this.calls.map((c) => c.name);
  }
  comments() {
    return this.calls.filter((c) => c.name === "github.comment").map((c) => c.args as { number: number; body: string; marker: string });
  }
}

const spec = {
  in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
  problem: "Change a",
  done_criteria: ["a changes"],
  desired_output: "a",
  scope: "src only",
  allowed_paths: ["src/"],
  files_to_change: ["src/a.txt"],
  tier: 2,
  tier_reason: "small",
};

type AgentStep = (workdir: string, spec: AgentRunSpec) => void;

/**
 * A bare origin with main (README, src/a.txt, docs/x.txt) and a factory checkout. The implementer edits
 * src/a.txt and commits; `moveMain` runs while it works, standing in for a merge to main mid-run. The
 * conflict step runs only when the worker asks for a conflict resolution.
 */
async function setup(opts: {
  moveMain?: (dev: string) => void;
  resolve?: AgentStep;
  testCommand?: string[];
  review?: () => "pass" | "bug";
  /** Move main during every implement run, not only the first. */
  moveEveryRun?: boolean;
} = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-sync-")));
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  commitFile(dev, "README.md", "hi\n", "init");
  commitFile(dev, "src/a.txt", "a\n", "add a");
  commitFile(dev, "docs/x.txt", "x\n", "add x");
  git(dev, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, repo);

  const cfg: FactoryConfig = {
    ...config,
    repo: { ...config.repo, path: repo, test_command: opts.testCommand ?? ["sh", "-c", "! grep -rq '<<<<<<<' src"] },
  };
  let implementCount = 0;
  const conflictSteps: AgentRunSpec[] = [];
  const reply = (): Partial<AgentRunResult> => ({ output: { summary: "changed a", next_steps: "none" } });
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      if (s.prompt.includes("## Merge conflicts")) {
        conflictSteps.push(s);
        opts.resolve?.(s.sandbox.workdir, s);
        return reply();
      }
      implementCount++;
      commitFile(s.sandbox.workdir, "src/a.txt", `a from the implementer, run ${implementCount}\n`, `implementer edits a (${implementCount})`);
      if (implementCount === 1 || opts.review || opts.moveEveryRun) opts.moveMain?.(dev);
      return reply();
    },
    review: () => ({ output: { verdict: opts.review?.() ?? "pass", tier: 2, findings: ["fix it"], summary: "s" } }),
  });
  const source = new FakeSource();
  const sandbox = new RecordingSandbox(join(repo, ".worktrees"));
  const broker = new GitPushBroker();
  const storage = new MemoryStorage();
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage, clock, config: cfg,
    prompts: { triage: "T", implement: "I", review: "R" }, log: silent, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(5);
  /** Takes the issue in and approves the spec, so one implement run executes. */
  const approveAndImplement = async (): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "500", approver: alice });
    await step();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  const remote = (ref: string) => git(origin, "rev-parse", ref);
  const remoteHas = (ref: string) => {
    try {
      remote(ref);
      return true;
    } catch {
      return false;
    }
  };
  /** Whether `sha` is in the history of origin's `ref`. */
  const contains = (ref: string, sha: string) => {
    try {
      git(origin, "merge-base", "--is-ancestor", sha, ref);
      return true;
    } catch {
      return false;
    }
  };
  const implementRuns = async (id: string) => (await store.listRuns(id as WorkItem["id"])).filter((r) => r.kind === "implement");
  return {
    store, storage, source, sandbox, broker, runner, controller, worker, clock, step, approveAndImplement, dev, origin, root,
    remote, remoteHas, contains, implementRuns, conflictSteps, cfg,
  };
}

let mainEdits = 0;
const MAIN_EDITS_A = (dev: string) => {
  git(dev, "pull", "--quiet", "--ff-only", "origin", "main");
  commitFile(dev, "src/a.txt", `a from main ${++mainEdits}\n`, "main edits a");
  git(dev, "push", "--quiet", "origin", "main");
};

const resolveA: AgentStep = (wd) => {
  write(wd, "src/a.txt", "a merged\n");
  git(wd, "add", "--", "src/a.txt");
};

describe("implement run: sync with base before push", () => {
  it("main moved with no conflict: the pushed branch contains the new base commit and merges cleanly", async () => {
    let mainSha = "";
    const f = await setup({
      moveMain: (dev) => {
        git(dev, "pull", "--quiet", "--ff-only", "origin", "main");
        mainSha = commitFile(dev, "docs/x.txt", "x from main\n", "main edits x");
        git(dev, "push", "--quiet", "origin", "main");
      },
    });
    const item = await f.approveAndImplement();
    const branch = `refs/heads/factory/${item.id}`;

    expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    expect(f.contains(branch, mainSha)).toBe(true);
    // Mergeable: main is already in the branch, so merging the PR into main is a fast-forward.
    expect(f.contains(branch, f.remote("refs/heads/main"))).toBe(true);
    const merge = git(f.origin, "log", "-1", "--format=%P %s", branch);
    expect(merge.split(" ")).toContain(mainSha); // a merge commit, not a rebase
    expect(merge).toContain(`Merge origin/main`);
    // docs/x.txt changed only on main: the scope gate does not count it (src/ is the only allowed path).
    expect(f.broker.names()).toEqual(["github.push_branch", "github.open_pr", "github.comment"]);
    expect(f.conflictSteps).toHaveLength(0);
    // The base commit the merge and the gates used is the one fetched after the implementer exited.
    expect(f.sandbox.execs).toContain(`git diff --name-only -z --no-renames ${mainSha}...HEAD`);
    expect(f.sandbox.execs).toContain(`git diff --numstat -z -M ${mainSha}...HEAD`);
    const handoffs = await f.store.listHandoffs(item.id);
    expect(handoffs.map((h) => h.worked_on)).toEqual(["implementer edits a (1)", expect.stringContaining("Merge origin/main")]);
  });

  it("main did not move: no merge commit, the branch is pushed as the implementer left it", async () => {
    const f = await setup();
    const item = await f.approveAndImplement();
    const branch = `refs/heads/factory/${item.id}`;
    expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    expect(git(f.origin, "log", "-1", "--format=%s", branch)).toBe("implementer edits a (1)");
    expect(f.sandbox.execs.some((c) => c.includes(" merge --no-ff"))).toBe(false);
  });

  it("a conflict is resolved by the agent in the same run; the merge commit is pushed and the pre-push checks run after it", async () => {
    const f = await setup({ moveMain: MAIN_EDITS_A, resolve: resolveA });
    const item = await f.approveAndImplement();
    const branch = `refs/heads/factory/${item.id}`;
    const mainSha = f.remote("refs/heads/main");

    expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    expect(f.conflictSteps).toHaveLength(1);
    const prompt = f.conflictSteps[0]!.prompt;
    expect(prompt).toContain("- `src/a.txt`");
    expect(prompt).toContain(`${mainSha.slice(0, 8)} main edits a`);
    expect(prompt).not.toContain("add x"); // only base commits since the fork that touched the conflicting files
    // Only the run's own git folder (#94): never the factory repo's .git.
    const writable = f.conflictSteps[0]!.writable_paths;
    expect(writable).toHaveLength(1);
    expect(writable[0]).toMatch(/[/]\.worktrees[/]sbx_[^/]+[/]\.git$/);

    const head = git(f.origin, "log", "-1", "--format=%P%n%s", branch).split("\n");
    expect(head[0]!.split(" ")).toContain(mainSha);
    expect(head[1]).toContain("Merge origin/main");
    expect(git(f.origin, "show", `${branch}:src/a.txt`)).toBe("a merged");

    // Order: merge → agent → test command → merge commit → scope gate → size gate → push.
    const ex = f.sandbox.execs;
    const at = (p: string) => ex.findIndex((c) => c.startsWith(p));
    expect(at("git -c core.hooksPath=/dev/null merge --no-ff")).toBeGreaterThan(at("git fetch"));
    expect(at("sh -c")).toBeGreaterThan(at("git -c core.hooksPath=/dev/null merge --no-ff"));
    expect(at("git -c core.hooksPath=/dev/null commit --no-edit")).toBeGreaterThan(at("sh -c"));
    expect(at(`git diff --name-only -z --no-renames ${mainSha}...HEAD`)).toBeGreaterThan(at("git -c core.hooksPath=/dev/null commit"));
    expect(at(`git diff --numstat -z -M ${mainSha}...HEAD`)).toBeGreaterThan(at("git diff --name-only -z --no-renames"));
    expect(f.broker.names()).toEqual(["github.push_branch", "github.open_pr", "github.comment"]);
    expect(await f.store.listHandoffs(item.id)).toHaveLength(2);
    // Two agent steps, two transcripts: the conflict step does not overwrite the first.
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded" });
    expect((await f.storage.list(`transcripts/${item.id}/${run.id}`)).sort()).toEqual([
      `transcripts/${item.id}/${run.id}.json`,
      `transcripts/${item.id}/${run.id}.merge.json`,
    ]);
  });

  it("conflicts left after the agent's step fail the run with merge_conflict: nothing pushed, no handoffs, a comment on the issue", async () => {
    const f = await setup({ moveMain: MAIN_EDITS_A, resolve: () => undefined });
    const item = await f.approveAndImplement();

    const runs = await f.implementRuns(item.id);
    expect(runs[0]!.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict", infra: false });
    expect(runs.map((r) => r.status)).toEqual(["failed", "queued"]); // a task failure: retried after backoff
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 0 });
    expect(f.broker.names()).not.toContain("github.push_branch");
    expect(f.broker.names()).not.toContain("github.open_pr");
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(await f.store.listHandoffs(item.id)).toEqual([]);

    const [c] = f.broker.comments();
    expect(c!.number).toBe(5);
    expect(c!.marker).toBe(`<!-- factory:merge-conflict:${runs[0]!.id} -->`);
    expect(c!.body).toContain("- `src/a.txt`");
    expect(c!.body).toContain("Nothing was pushed");
  });

  it("tests failing after the resolution fail the run with merge_conflict and push nothing", async () => {
    const f = await setup({ moveMain: MAIN_EDITS_A, resolve: resolveA, testCommand: ["sh", "-c", "exit 3"] });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict", infra: false });
    if (run.outcome?.status === "failed") expect(run.outcome.detail).toContain("tests failed");
    expect(f.conflictSteps).toHaveLength(1);
    expect(f.broker.names()).not.toContain("github.push_branch");
    expect(await f.store.listHandoffs(item.id)).toEqual([]);
    expect(f.broker.comments()[0]!.body).toContain("Nothing was pushed");
  });

  it("a resolution left unstaged (markers staged, clean file in the working tree) fails with merge_conflict and pushes nothing", async () => {
    const f = await setup({
      moveMain: MAIN_EDITS_A,
      resolve: (wd) => {
        git(wd, "add", "--", "src/a.txt"); // stages the file with its conflict markers
        write(wd, "src/a.txt", "a merged\n"); // fixed in the working tree only
      },
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict", infra: false });
    if (run.outcome?.status === "failed") expect(run.outcome.detail).toContain("not staged");
    expect(f.sandbox.execs.some((c) => c.startsWith("sh -c"))).toBe(false); // tests never ran on an unstaged tree
    expect(f.broker.names()).not.toContain("github.push_branch");
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(await f.store.listHandoffs(item.id)).toEqual([]);
    expect(f.broker.comments()[0]!.body).toContain("Nothing was pushed");
  });

  it("an agent that commits the markers itself and fixes only the working tree fails with merge_conflict", async () => {
    const f = await setup({
      moveMain: MAIN_EDITS_A,
      resolve: (wd) => {
        git(wd, "add", "--", "src/a.txt");
        git(wd, "-c", "user.name=a", "-c", "user.email=a@example.com", "commit", "--quiet", "--no-edit");
        write(wd, "src/a.txt", "a merged\n");
      },
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict", infra: false });
    expect(f.broker.names()).not.toContain("github.push_branch");
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
  });

  it("merge_conflict counts toward max_attempts and the last-attempt comment names the code with its label", async () => {
    const f = await setup({ moveMain: MAIN_EDITS_A, resolve: () => undefined, moveEveryRun: true });
    const item = await f.approveAndImplement();
    for (let i = 1; i < gates(f.cfg).max_attempts; i++) {
      f.clock.advance(f.cfg.retry_max_ms);
      await f.step();
    }
    const runs = await f.implementRuns(item.id);
    expect(runs.map((r) => r.outcome?.status === "failed" && r.outcome.error_code)).toEqual(
      Array(gates(f.cfg).max_attempts).fill("merge_conflict"),
    );
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
    const last = f.source.comments.at(-1)!.body;
    expect(last).toContain("`merge_conflict`: the branch conflicts with the base branch and the conflict could not be resolved");
  });

  it("a resolution that touches a non-conflicting file outside allowed_paths is stopped by the scope gate", async () => {
    const f = await setup({
      moveMain: MAIN_EDITS_A,
      resolve: (wd, s) => {
        resolveA(wd, s);
        write(wd, "outside.txt", "sneaked in\n");
        git(wd, "add", "--", "outside.txt");
      },
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation", infra: false });
    if (run.outcome?.status === "failed") {
      expect(run.outcome.detail).toContain("outside.txt");
      expect(run.outcome.detail).not.toContain("src/a.txt");
    }
    expect(f.broker.names()).not.toContain("github.push_branch");
    expect(await f.store.listHandoffs(item.id)).toEqual([]);
    expect(f.broker.comments()[0]!.marker).toBe(`<!-- factory:scope:${run.id} -->`);
  });

  it("a review-fix push on an open PR syncs with base first", async () => {
    let reviews = 0;
    const mains: string[] = [];
    const f = await setup({
      review: () => (reviews++ === 0 ? "bug" : "pass"),
      moveMain: (dev) => {
        git(dev, "pull", "--quiet", "--ff-only", "origin", "main");
        mains.push(commitFile(dev, `docs/m${mains.length}.txt`, "m\n", `main moves ${mains.length}`));
        git(dev, "push", "--quiet", "origin", "main");
      },
    });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: 42 });
    expect(mains).toHaveLength(2); // main moved during the first implement and during the review fix
    const branch = `refs/heads/factory/${item.id}`;
    expect(f.contains(branch, mains[1]!)).toBe(true);
    expect(git(f.origin, "log", "-1", "--format=%s", branch)).toContain("Merge origin/main");
    expect(f.broker.names().filter((n) => n === "github.push_branch")).toHaveLength(2);
  });
});
