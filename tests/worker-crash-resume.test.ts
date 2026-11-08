import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FAKE_GITHUB_TOOLS, FakeAuth, FakeRunner, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { BACKENDS } from "./helpers/store.js";

// RFC 0015 M6: a run killed mid-implement is taken over by another worker, which resumes after the run's last
// finished step. Worker 1 dies during its push (its push never returns and its clock never moves again, so its
// heartbeat never renews); the lease expires, the reaper requeues the run, and worker 2 claims it. The journal
// holds the finished agent step with a bundle of its commits: worker 2 restores them and pushes, and the agent
// runs once.

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@example.com", GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

function commitFile(repo: string, path: string, content: string, msg: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
}

/** Pushes to the local bare origin; `hang` makes a push never return (the worker's process died there). */
class Broker implements ToolBroker {
  readonly calls: { worker: string; name: string }[] = [];
  release: () => void = () => {};
  constructor(private readonly worker: string, private readonly hang: boolean) {}
  listTools(): ToolDescriptor[] {
    return [];
  }
  allTools(): ToolDescriptor[] {
    return [...FAKE_GITHUB_TOOLS];
  }
  async call(_ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (name === "github.preflight") return { ok: true, content: {} };
    this.calls.push({ worker: this.worker, name });
    const a = args as Record<string, unknown>;
    if (name === "github.push_branch") {
      if (this.hang) await new Promise<void>((r) => (this.release = r));
      git(String(a.workdir), "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: {} };
    }
    if (name === "github.open_pr") return { ok: true, content: { number: 42 } };
    return { ok: true, content: {} };
  }
}

const spec = {
  in_short: "AS-IS: a.\nTO-BE: b.", problem: "Change a", done_criteria: ["a changes"], desired_output: "a", scope: "src only",
  allowed_paths: ["src/"], files_to_change: ["src/a.txt"], tier: 2, tier_reason: "small", estimated_lines: 10, estimated_files: 1,
};

describe.each(BACKENDS)("worker crash mid-implement on $name", { timeout: 60_000 }, (backend) => {
  it("another worker takes the run over and resumes after the finished agent step: no second agent run", async () => {
    const clock = new FakeClock();
    const { store } = await backend.make(clock);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-crash-")));
    const origin = join(root, "origin.git");
    const dev = join(root, "dev");
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, dev);
    commitFile(dev, "README.md", "hi\n", "init");
    commitFile(dev, "src/a.txt", "a\n", "add a");
    git(dev, "push", "--quiet", "origin", "main");
    git(root, "clone", "--quiet", origin, repo);

    const cfg: FactoryConfig = { ...config, repo: { ...config.repo, path: repo, test_command: ["true"] } };
    let agentRuns = 0;
    const runner = new FakeRunner({
      triage: () => ({ output: spec }),
      implement: (s) => {
        agentRuns++;
        commitFile(s.sandbox.workdir, "src/a.txt", "a from the implementer\n", "implementer edits a");
        return { output: { summary: "changed a", next_steps: "none" } };
      },
    });
    const source = new FakeSource();
    const storage = new MemoryStorage();
    const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
    const worker = (id: string, broker: Broker, own: FakeClock) => new Worker({
      id: id as WorkerId, store, sandbox: new NoOpSandbox(join(repo, `.worktrees-${id}`)), runner, broker, storage, clock: own, config: cfg,
      prompts: { triage: "T", implement: "I", review: "R", resolve: "S" }, log: silent, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
    });
    // Worker 1 dies at its push: the push never returns, and its own clock never moves, so it never renews.
    const dying = new Broker("w1", true);
    const w1 = worker("h1:1:0", dying, new FakeClock(clock.now()));
    const healthy = new Broker("w2", false);
    const w2 = worker("h2:1:0", healthy, clock);

    const src = issueRef(5);
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    while (await w2.tick()) await controller.tickRuns();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "500", approver: alice });
    await controller.tickIntake();
    await controller.tickRuns();
    const item = (await store.getWorkItemBySource("github_issue", src.id))!;
    const implementRun = async () => (await store.listRuns(item.id as WorkItem["id"])).find((r) => r.kind === "implement")!;

    const crashed = w1.tick();
    await waitUntil(() => dying.calls.some((c) => c.name === "github.push_branch"));
    const steps = async () =>
      (await storeSql(store).all("SELECT step_id, attempt, status FROM worker_run_steps WHERE run_id = ? ORDER BY step_id", [(await implementRun()).id]))
        .map((r) => `${String(r.step_id)}@${Number(r.attempt)}:${String(r.status)}`);
    expect(await steps()).toEqual(["push-branch@1:running", "record-handoffs@1:succeeded", "run-agent@1:succeeded"]);

    // The lease runs out; the reaper requeues the run (with its backoff) and worker 2 claims it.
    clock.advance(cfg.lease_ms + 1);
    await controller.tickReaper();
    expect((await implementRun()).status).toBe("queued");
    clock.advance(cfg.retry_max_ms);
    expect(await w2.tick()).toBe(true);

    const run = await implementRun();
    expect(run).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(agentRuns).toBe(1);
    expect(await steps()).toEqual(["open-pr@2:succeeded", "push-branch@2:succeeded", "record-handoffs@1:succeeded", "run-agent@1:succeeded"]);
    expect(healthy.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    expect(git(origin, "show", `refs/heads/factory/${item.id}:src/a.txt`)).toBe("a from the implementer");

    // The dead worker's push returns at last: its lease is gone, so it writes nothing.
    dying.release();
    await crashed;
    expect(dying.calls.map((c) => c.name)).toEqual(["github.push_branch"]);
    expect(await implementRun()).toMatchObject({ status: "succeeded", attempt: 2 });
  });
});

async function waitUntil(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error("timed out waiting");
}
