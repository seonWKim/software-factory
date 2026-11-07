import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Write, guardPolicy } from "../src/core/tools/index.js";
import type { WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { FakeBroker, FakeRunner, MemoryStorage, cleanScanner, config, prompts, recordingLog } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// The owner's live checkout (repo.path) must not gain files from an agent run (design §5 Sandbox). Writes are
// stopped by the harness rules and the shared tools; the worker's check reports any file that still appears.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

/** A bare origin and the live checkout cloned from it, with main pushed; run folders go inside it, like `.worktrees/`. */
function liveCheckout() {
  const root = mkdtempSync(join(tmpdir(), "sf-live-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.txt"), "a\n");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=bot", "-c", "user.email=bot@example.com", "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "main");
  return { root, repo, worktrees: join(repo, ".worktrees") };
}

/** The agent's own work: one commit in its run folder, so the run gets to push. */
function commitInRunFolder(workdir: string) {
  writeFileSync(join(workdir, "src", "b.txt"), "b\n");
  git(workdir, "add", "--", "src/b.txt");
  git(workdir, "-c", "user.name=bot", "-c", "user.email=bot@example.com", "commit", "--quiet", "-m", "add b");
}

const WARNING = "files appeared in the live checkout during an agent step";

/** One implement run through the real NoOpSandbox; `agent` acts during the agent step, as a runner would. */
async function implement(agent: (spec: AgentRunSpec, f: ReturnType<typeof liveCheckout>, sbx: NoOpSandbox) => Promise<void> | void, setup?: (repo: string) => void) {
  const f = liveCheckout();
  setup?.(f.repo);
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const { item: created } = await store.createWorkItem(issue(301), system);
  const moved = await store.transition({
    id: created.id, expected_version: created.version, actor: system, reason: "test_setup",
    patch: { stage: "RUNNING", allowed_paths: ["src/"], done_criteria: ["works"], scope: "s", tier: 1 },
    enqueue: { kind: "implement", idempotency_key: "impl-1" },
  });
  if (!moved.ok) throw new Error("setup");
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, path: f.repo, test_command: ["sh", "-c", "exit 0"] } };
  const sbx = new NoOpSandbox(f.worktrees);
  const runner = new FakeRunner({
    implement: async (spec: AgentRunSpec) => {
      await agent(spec, f, sbx);
      return { output: { summary: "did it", next_steps: "none" } };
    },
  });
  const log = recordingLog();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: sbx, runner, broker: new FakeBroker(),
    storage: new MemoryStorage(), clock, config: cfg, prompts, log, scanner: cleanScanner, awake: new NoKeepAwake(),
    toolEnv: { PATH: process.env.PATH ?? "", HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  expect(await worker.tick()).toBe(true);
  const run = (await store.listRuns(created.id)).find((r) => r.kind === "implement")!;
  const reports = log.lines.filter((l) => l.level === "warn" && l.msg === WARNING);
  return { f, run, reports, spec: runner.specs[0]! };
}

describe("live checkout: writes from an implement run", { timeout: 30_000 }, () => {
  it("a runner on the shared tools: a Write to a file in the live checkout is refused, names the path, and creates nothing", async () => {
    let refusal: unknown = null;
    const { f, reports } = await implement(async (spec, f, sbx) => {
      // What any runner without a harness does (design §5): every file call through the shared tool, with the
      // guard policy built from the implement run's spec.
      const policy = guardPolicy({ workdir: spec.sandbox.workdir, deny_paths: spec.deny_paths, writable_paths: spec.writable_paths, env_allowlist: {} });
      refusal = await Write.run({ file_path: join(f.repo, "placeholder"), content: "x" }, { sandbox: sbx, handle: spec.sandbox, policy });
    });
    expect(refusal).toEqual({ ok: false, error: `refused: ${join(f.repo, "placeholder")} is outside the workdir and writable paths` });
    expect(existsSync(join(f.repo, "placeholder"))).toBe(false);
    expect(reports).toEqual([]);
  });

  it("the worker check reports a file written into the live checkout during the run, with its path and the run id; the run goes on", async () => {
    const { f, run, reports } = await implement((spec, f) => {
      writeFileSync(join(f.repo, "placeholder"), "");
      commitInRunFolder(spec.sandbox.workdir);
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.fields).toMatchObject({ run_id: run.id, checkout: f.repo, paths: "placeholder", count: 1 });
    // A report, never a failure: the run ends as it would have without the stray file.
    expect(run.outcome).toMatchObject({ status: "succeeded" });
  });

  it("does not report untracked files that were in the live checkout before the run", async () => {
    const { run, reports } = await implement(
      (_spec, f) => {
        writeFileSync(join(f.repo, "src", "new-during-run.txt"), "n\n");
      },
      (repo) => {
        writeFileSync(join(repo, "owner-notes.txt"), "mine\n");
        writeFileSync(join(repo, "src", "draft.txt"), "draft\n");
      },
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.fields).toMatchObject({ run_id: run.id, paths: "src/new-during-run.txt", count: 1 });
  });

  it("reports nothing when the run wrote only in its own folder", async () => {
    const { run, reports } = await implement((spec) => commitInRunFolder(spec.sandbox.workdir));
    expect(run.outcome).toMatchObject({ status: "succeeded" });
    expect(reports).toEqual([]);
  });
});
