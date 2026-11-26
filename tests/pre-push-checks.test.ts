import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { Floor } from "../src/core/settings.js";
import { type GateEntry, failingTestFiles, withTestFiles } from "../src/core/checks.js";
import { MODE_KEY, SELECTION_ACTOR, cleanCursor } from "../src/core/test-selection.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FAKE_GITHUB_TOOLS } from "./helpers/fakes/broker.js";
import { FakeAuth, FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, recordingLog, runComments } from "./helpers/fakes/config.js";
import { git, gitTemplate } from "./helpers/git-fixture.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The pre-push checks (design §4, decided 2026-11-03): an implement run runs repo.check_commands after sync and
// the scope, size and floor gates, before any handoff row or push. A failure gets one fix step in the same run.

function commitFile(repo: string, path: string, content: string, msg: string): string {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function removeFile(repo: string, path: string, msg: string): void {
  git(repo, "rm", "--quiet", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
}

/** Records every exec with its env, folder and output, so tests can see which commands got the test database URL. */
class RecordingSandbox extends NoOpSandbox {
  execs: { cmd: string; env: Readonly<Record<string, string>>; cwd?: string; stdout?: string }[] = [];
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const e: (typeof this.execs)[number] = { cmd: cmd.join(" "), env: o.env, ...(o.cwd === undefined ? {} : { cwd: o.cwd }) };
    this.execs.push(e);
    const r = await super.exec(h, cmd, o);
    e.stdout = r.stdout;
    return r;
  }
}

/** Pushes to the local bare remote like the real broker (never a force push); records every forge call. */
class GitPushBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: Record<string, unknown> }[] = [];
  listTools(): ToolDescriptor[] {
    return [];
  }
  /** The GitHub broker's tools: the worker opens a PR and comments only through a broker that lists them. */
  allTools(): ToolDescriptor[] {
    return [...FAKE_GITHUB_TOOLS];
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const a = args as Record<string, unknown>;
    if (name === "forge.preflight") return { ok: true, content: {} };
    // The run's last step: the bare origin stands in for the forge, so the stored branch lands there at once;
    // outbound's push and PR (RFC 0015 M7) are logged into \`calls\` by the controller's FakeForge.
    if (name === STORE_BRANCH) {
      git(String(a.workdir), "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: { sha: git(String(a.workdir), "rev-parse", "HEAD").trim(), forge: true } };
    }
    this.calls.push({ ctx, name, args: a });
    return { ok: true, content: {} };
  }
  names() {
    return this.calls.map((c) => c.name);
  }
  pushes() {
    return this.calls.filter((c) => c.name === "forge.push_branch").map((c) => String(c.args.branch));
  }
  prBody() {
    return String(this.calls.find((c) => c.name === "forge.open_change")?.args.body ?? "");
  }
}

const spec = {
  in_short: "AS-IS: a.\nTO-BE: b.",
  problem: "Change a",
  done_criteria: ["a changes"],
  // Manual: a test file check would run `repo.test_command` on it in every round (tests/done-checks-run.test.ts covers that).
  done_checks: [{ line: "a changes", manual: true, reason: "a person reads a" }],
  desired_output: "a",
  scope: "src only",
  allowed_paths: ["src/"],
  files_to_change: ["src/a.txt"],
  tier: 2,
  tier_reason: "small",
  estimated_lines: 10,
  estimated_files: 1,
};

/** A check that fails while `file` is in the work tree, printing `say`. */
const failsWhile = (name: string, file: string, say: string, code = 1): string[] =>
  ["sh", "-c", `if [ -f ${file} ]; then echo '${say}'; exit ${code}; fi`, name];

const TYPECHECK = failsWhile("typecheck", "src/type-error.txt", "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.", 2);
const SQLITE = failsWhile("sqlite-tests", "src/sqlite-fail.txt", "FAIL tests/store-contract.test.ts > sqlite > claims a run");
const LINT = failsWhile("lint", "src/lint-fail.txt", "src/a.ts:1:1 error no-unused-vars");
const CHECKS = [TYPECHECK, SQLITE, LINT];

type AgentStep = (workdir: string, spec: AgentRunSpec) => void;

/** A bare origin with main (README, src/a.txt), a dev clone and a factory checkout. */
const repos = gitTemplate((root) => {
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  commitFile(dev, "README.md", "hi\n", "init");
  commitFile(dev, "src/a.txt", "a\n", "add a");
  git(dev, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, join(root, "repo"));
});

/**
 * A copy of the template's repositories. The implementer edits src/a.txt, commits, then runs `implement`. A fix
 * step (the prompt's "## Checks failed before push") runs `fix`.
 */
async function setup(opts: {
  checks?: GateEntry[];
  implement?: AgentStep;
  fix?: AgentStep;
  scanner?: PatternEgressScanner;
  max_attempts?: number;
  /** Files committed to the base branch before the item starts. */
  base?: Record<string, string>;
  floors?: Floor[];
  /** Merged into the repo config: test_command and test_selection. */
  repo?: Partial<FactoryConfig["repo"]>;
} = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const root = repos.copy();
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  for (const [path, content] of Object.entries(opts.base ?? {})) commitFile(repo, path, content, `base: ${path}`);
  if (opts.base) git(repo, "push", "--quiet", "origin", "HEAD:main");

  const cfg: FactoryConfig = {
    ...config,
    repo: { ...config.repo, path: repo, check_commands: opts.checks ?? CHECKS, ...opts.repo },
    settings: { ...config.settings, defaults: { ...config.settings.defaults, max_attempts: opts.max_attempts ?? 3, ...(opts.floors ? { floors: opts.floors } : {}) } },
  };
  let implementCount = 0;
  const fixSteps: AgentRunSpec[] = [];
  const reply = (): Partial<AgentRunResult> => ({ output: { summary: "changed a", next_steps: "none" } });
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      if (s.prompt.includes("## Checks failed before push")) {
        fixSteps.push(s);
        opts.fix?.(s.sandbox.workdir, s);
        return reply();
      }
      implementCount++;
      commitFile(s.sandbox.workdir, "src/a.txt", `a from the implementer, run ${implementCount}\n`, `implementer edits a (${implementCount})`);
      opts.implement?.(s.sandbox.workdir, s);
      return reply();
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const source = new FakeSource();
  const sandbox = new RecordingSandbox(join(repo, ".worktrees"));
  const broker = new GitPushBroker();
  const storage = new MemoryStorage();
  const log = recordingLog();
  const scanner = opts.scanner ?? cleanScanner;
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const controller = new ControllerRole({ store, source, forge: new FakeForge(null, broker.calls), auth: new FakeAuth(), clock, config: cfg, log, scanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage, clock, config: cfg,
    prompts: { triage: "T", implement: "I", review: "R", resolve: "S" }, log, scanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(5);
  const approveAndImplement = async (): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "500", approver: alice });
    await step();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  const remoteHas = (ref: string) => {
    try {
      git(origin, "rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  };
  const implementRuns = async (id: string) => (await store.listRuns(id as WorkItem["id"])).filter((r) => r.kind === "implement");
  const checkExecs = () => sandbox.execs.filter((e) => e.cmd.startsWith("sh -c"));
  return {
    store, source, sandbox, broker, runner, controller, worker, clock, log, step, approveAndImplement, origin, cfg,
    remoteHas, implementRuns, fixSteps, checkExecs, implementCount: () => implementCount,
  };
}

/** The fix step that removes `file` and commits. */
const fixBy = (file: string): AgentStep => (wd) => removeFile(wd, file, `fix: remove ${file}`);

// Real git clone/push work per test: 2–5s each alone, more under a full parallel run, so 60 s.
describe("implement run: checks before push, one fix step", { timeout: 60_000 }, () => {
  for (const c of [
    { name: "a typecheck failure", file: "src/type-error.txt", cmd: TYPECHECK, say: "error TS2322" },
    { name: "a SQLite test failure", file: "src/sqlite-fail.txt", cmd: SQLITE, say: "FAIL tests/store-contract.test.ts > sqlite" },
    { name: "a lint failure", file: "src/lint-fail.txt", cmd: LINT, say: "error no-unused-vars" },
  ]) {
    it(`${c.name}: no push before the fix; the fix step gets the command and the output tail; the fixed branch is pushed`, async () => {
      const f = await setup({
        implement: (wd) => commitFile(wd, c.file, "broken\n", "add a fault"),
        fix: (wd, s) => {
          // Nothing was pushed while the fix step ran.
          expect(f.broker.pushes()).toEqual([]);
          expect(s.prompt).toContain(`\`${c.cmd.join(" ")}\` failed`);
          fixBy(c.file)(wd, s);
        },
      });
      const item = await f.approveAndImplement();

      expect(f.fixSteps).toHaveLength(1);
      const prompt = f.fixSteps[0]!.prompt;
      expect(prompt).toContain(c.say);
      expect(prompt).toContain("This is the only fix step in this run");
      // Same tools and writable git dir as the merge step; the implement prompt.
      expect(f.fixSteps[0]!.system_prompt).toBe("I");
      expect(f.fixSteps[0]!.writable_paths).toHaveLength(1);
      expect(f.fixSteps[0]!.writable_paths[0]).toMatch(/[/]\.worktrees[/]sbx_[^/]+[/]\.git$/);

      expect(item).toMatchObject({ stage: "REVIEW", change_ref: "42" });
      const branch = `refs/heads/factory/${item.id}`;
      expect(git(f.origin, "log", "-1", "--format=%s", branch)).toBe(`fix: remove ${c.file}`);
      expect(f.broker.pushes()).toEqual([`factory/${item.id}`]);
      // Handoffs and the commit count include the fix commit.
      const handoffs = await f.store.listHandoffs(item.id);
      expect(handoffs.map((h) => h.worked_on)).toEqual(["implementer edits a (1)", "add a fault", `fix: remove ${c.file}`]);
      const run = (await f.implementRuns(item.id))[0]!;
      expect(run.outcome).toMatchObject({ status: "succeeded", data: { commits: 3, pr_pending: true } });
      // The whole list ran again after the fix: every command once more, in order.
      const ran = f.checkExecs().map((e) => e.cmd);
      const failedAt = CHECKS.findIndex((x) => x === c.cmd);
      expect(ran).toEqual([...CHECKS.slice(0, failedAt + 1), ...CHECKS].map((x) => x.join(" ")));
      expect(f.broker.prBody()).toContain(`Checked before push: \`${c.cmd.join(" ")}\` passed (after one fix step)`);
    });
  }

  it("a successful run's PR body has a 'Checked before push' line per command, with its result", async () => {
    const f = await setup();
    await f.approveAndImplement();
    expect(f.fixSteps).toHaveLength(0);
    const body = f.broker.prBody();
    for (const c of CHECKS) expect(body).toContain(`Checked before push: \`${c.join(" ")}\` passed\n`);
    expect(body).not.toContain("skipped");
    expect(body.indexOf("Checked before push")).toBeLessThan(body.indexOf("Closes #5"));
  });

  it("a second failure after the fix step fails the run with checks_failed: no push, no PR, no handoff rows, one comment", async () => {
    const f = await setup({
      implement: (wd) => commitFile(wd, "src/sqlite-fail.txt", "broken\n", "add a fault"),
      fix: (wd) => commitFile(wd, "src/a.txt", "a tried\n", "a fix that does not fix"),
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;

    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed", infra: false });
    expect(f.fixSteps).toHaveLength(1);
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(f.broker.names()).not.toContain("forge.open_change");
    expect(await f.store.listHandoffs(item.id)).toEqual([]);
    expect(f.broker.names()).not.toContain("github.comment");
    const comments = (await runComments(f.store, item.id)).filter((c) => c.marker.includes("factory:checks:"));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.marker).toBe(`<!-- factory:checks:${run.id} -->`);
    expect(comments[0]!.body).toContain(`\`${SQLITE.join(" ")}\``);
    expect(comments[0]!.number).toBe(5);
    // The failing test file ran again on the base commit, where it passed.
    expect(f.checkExecs().filter((e) => e.cwd === ".factory-base").map((e) => e.cmd)).toEqual([`${SQLITE.join(" ")} tests/store-contract.test.ts`]);
  });

  it("a test file that fails on the base commit too gives checks_env: rerun in a clean base worktree, removed after", async () => {
    const FLAKY = ["sh", "-c", "echo ' FAIL  tests/flaky.test.ts > times out'; echo \"a is: $(cat src/a.txt)\"; exit 1", "flaky"];
    const f = await setup({ checks: [FLAKY], fix: () => undefined });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_env", wip: { branch: `factory/wip/${item.id}/${run.id}` } });
    const onBase = f.checkExecs().filter((e) => e.cwd === ".factory-base");
    expect(onBase.map((e) => e.cmd)).toEqual([`${FLAKY.join(" ")} tests/flaky.test.ts`]);
    // The base commit's file, not the branch's edit.
    expect(onBase[0]!.stdout).toContain("a is: a\n");
    const gitCalls = f.sandbox.execs.map((e) => e.cmd);
    const add = gitCalls.findIndex((c) => c.includes("worktree add --quiet --detach .factory-base"));
    expect(gitCalls.slice(add).some((c) => c.includes("worktree remove --force .factory-base"))).toBe(true);
    const comments = (await runComments(f.store, item.id)).filter((c) => c.marker.includes("factory:checks:"));
    expect(comments.map((c) => c.marker)).toEqual([`<!-- factory:checks:${run.id} -->`]);
    expect(comments[0]!.body).toContain("`tests/flaky.test.ts`");
    expect(f.broker.pushes()).toEqual([`factory/wip/${item.id}/${run.id}`]);
  });

  it("a folder check's base rerun runs in that folder of the base worktree, and the comment names the folder", async () => {
    const FLAKY = ["sh", "-c", "echo ' FAIL  tests/flaky.test.ts > times out'; echo \"a is: $(cat a.txt)\"; exit 1", "flaky"];
    const f = await setup({ checks: [{ dir: "src", argv: FLAKY }], fix: () => undefined });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    const onBase = f.checkExecs().filter((e) => e.cwd === ".factory-base/src");
    expect(onBase.map((e) => e.cmd)).toEqual([`${FLAKY.join(" ")} tests/flaky.test.ts`]);
    expect(onBase[0]!.stdout).toContain("a is: a\n");
    const comments = (await runComments(f.store, item.id)).filter((c) => c.marker.includes("factory:checks:"));
    expect(comments[0]!.body).toContain(`\`${FLAKY.join(" ")} (in src/)\``);
  });

  it("the checks_failed detail names the failing vitest tests as file > name, at most 10; the output tail keeps the FAIL lines", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `tests/t${i + 1}.test.ts > case ${i + 1}`);
    const fixture = [
      " RUN  v4.1.12 /w",
      "",
      " ❯ tests/t1.test.ts (2 tests | 1 failed) 4ms",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 12 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      ...names.flatMap((n) => [` FAIL  ${n}`, "AssertionError: expected 1 to be 2", ""]),
      " Test Files  12 failed (12)",
      "      Tests  12 failed | 1 passed (13)",
    ].join("\n");
    const VITEST = ["sh", "-c", "if [ -f src/vitest.txt ]; then cat src/vitest.txt; exit 1; fi", "vitest"];
    const f = await setup({
      checks: [VITEST],
      implement: (wd) => commitFile(wd, "src/vitest.txt", `${fixture}\n`, "add failing tests"),
      fix: () => undefined,
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    if (run.outcome?.status !== "failed") throw new Error("expected a failed run");
    const detail = run.outcome.detail;
    expect(detail).toContain(`\`${VITEST.join(" ")}\` exited 1 after one fix step`);
    expect(detail).toContain("failing tests: ");
    let at = -1;
    for (const n of names.slice(0, 10)) {
      const i = detail.indexOf(n);
      expect(i, n).toBeGreaterThan(at);
      at = i;
    }
    for (const n of names.slice(10)) expect(detail).not.toContain(n);
    // The output tail is kept as before, with vitest's FAIL summary lines.
    expect(run.outcome.output_tail).toContain(` FAIL  ${names[11]}`);
    expect(run.outcome.output_tail).toContain("Tests  12 failed | 1 passed (13)");
  });

  it("a failing test name the egress scan flags makes the outcome egress_blocked, as for any other detail", async () => {
    const token = `ghp_${"C".repeat(36)}`;
    const f = await setup({
      checks: [["sh", "-c", "if [ -f src/leak.txt ]; then cat src/leak.txt; exit 1; fi", "leaky"]],
      implement: (wd) => commitFile(wd, "src/leak.txt", ` FAIL  tests/leak.test.ts > reads ${token}\n`, "add a fault"),
      fix: () => undefined,
      scanner: new PatternEgressScanner(async () => []),
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "egress_blocked" });
    expect(JSON.stringify(run.outcome)).not.toContain(token);
  });

  it("the failed run keeps its commits on a wip branch, and the retry starts from them", async () => {
    let fixes = 0;
    const f = await setup({
      implement: (wd) => commitFile(wd, "src/sqlite-fail.txt", "broken\n", "add a fault"),
      // The first run's fix does not fix; the retry's does.
      fix: (wd) => (++fixes === 1 ? commitFile(wd, "src/a.txt", "a tried\n", "a fix that does not fix") : fixBy("src/sqlite-fail.txt")(wd, {} as AgentRunSpec)),
    });
    const item = await f.approveAndImplement();
    const [first] = await f.implementRuns(item.id);
    const wipBranch = `factory/wip/${item.id}/${first!.id}`;
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed", wip: { branch: wipBranch, commits: 3 } });
    const wipHead = git(f.origin, "rev-parse", `refs/heads/${wipBranch}`);
    expect(first!.outcome).toMatchObject({ wip: { head: wipHead } });
    expect(f.broker.pushes()).toEqual([wipBranch]);

    // The controller retries it (a task failure, under max_attempts), with the wip ref.
    const retry = (await f.implementRuns(item.id))[1]!;
    expect(retry).toMatchObject({ status: "queued", input: { wip: { branch: wipBranch, head: wipHead } } });
    f.clock.advance(f.cfg.retry_max_ms);
    await f.step();

    const done = (await f.implementRuns(item.id))[1]!;
    expect(done.outcome).toMatchObject({ status: "succeeded", data: { pr_pending: true } });
    expect(f.implementCount()).toBe(1); // no new implement agent: the retry started from the kept commits
    const branch = `refs/heads/factory/${item.id}`;
    git(f.origin, "merge-base", "--is-ancestor", wipHead, branch);
    expect(git(f.origin, "log", "-1", "--format=%s", branch)).toBe("fix: remove src/sqlite-fail.txt");
    expect((await f.store.listHandoffs(item.id)).map((h) => h.worked_on)).toEqual([
      "implementer edits a (1)", "add a fault", "a fix that does not fix", "fix: remove src/sqlite-fail.txt",
    ]);
  });

  it("a check that cannot start its tools fails at once as infra (toolchain_missing): no fix step, the commits kept", async () => {
    const TOOLS = failsWhile(
      "tests", "src/a.txt", 'Error: Cannot find module "/w/node_modules/typescript/bin/tsc"',
    );
    const f = await setup({ checks: [TOOLS] });
    const item = await f.approveAndImplement();
    const [run] = await f.implementRuns(item.id);
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "toolchain_missing", infra: true, wip: { branch: `factory/wip/${item.id}/${run!.id}` } });
    expect(run!.outcome?.status === "failed" && run!.outcome.detail).toContain('Cannot find module "/w/node_modules/typescript/bin/tsc"');
    expect(f.fixSteps).toHaveLength(0);
    expect(f.broker.names()).not.toContain("forge.open_change");
  });

  it("a check that cannot find the JDK fails at once as infra (toolchain_missing): no fix step, no attempt spent", async () => {
    const JDK = failsWhile("tests", "src/a.txt", "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.");
    const f = await setup({ checks: [JDK] });
    const item = await f.approveAndImplement();
    const [run] = await f.implementRuns(item.id);
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "toolchain_missing", infra: true });
    expect(run!.outcome?.status === "failed" && run!.outcome.detail).toContain("JAVA_HOME is not set");
    expect(f.fixSteps).toHaveLength(0);
  });

  it("checks_failed counts as a task failure toward max_attempts; the PR-check reason checks_failed is not used", async () => {
    const f = await setup({
      max_attempts: 2,
      implement: (wd) => commitFile(wd, "src/sqlite-fail.txt", "broken\n", "add a fault"),
      fix: () => undefined,
    });
    const item = await f.approveAndImplement();
    f.clock.advance(f.cfg.retry_max_ms);
    await f.step();
    const runs = await f.implementRuns(item.id);
    expect(runs.map((r) => r.outcome?.status === "failed" ? r.outcome.error_code : r.status)).toEqual(["checks_failed", "checks_failed"]);
    const now = (await f.store.getWorkItem(item.id))!;
    expect(now).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts" });
    const changes = await f.store.listStateChanges(item.id);
    expect(changes.find((c) => c.reason === "max_attempts")?.detail).toMatchObject({ error_code: "checks_failed", failure: "task", task_failures: 2 });
    expect(changes.map((c) => c.reason)).not.toContain("checks_failed");
    expect(f.source.comments.at(-1)!.body).toContain("a check before push (repo.check_commands) failed");
  });

  it("the fix step's prompt holds the output tail only after the egress scan; a finding drops it", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const f = await setup({
      checks: [["sh", "-c", "if [ -f src/leak.txt ]; then cat src/leak.txt; exit 1; fi", "leaky"]],
      implement: (wd) => commitFile(wd, "src/leak.txt", `config: ${token}\n`, "add a fault"),
      fix: fixBy("src/leak.txt"),
      scanner: new PatternEgressScanner(async () => []),
    });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    const prompt = f.fixSteps[0]!.prompt;
    expect(prompt).toContain("`sh -c");
    expect(prompt).toContain("leaky` failed (exited 1)");
    expect(prompt).not.toContain(token);
    expect(prompt).toContain("Its output is withheld");
  });

  it("after a fix commit the scope gate runs again: a fix outside allowed_paths fails with scope_violation, pushes no PR branch and keeps its commits for an agent retry", async () => {
    const f = await setup({
      implement: (wd) => commitFile(wd, "src/type-error.txt", "x\n", "add a fault"),
      fix: (wd) => {
        removeFile(wd, "src/type-error.txt", "fix the type");
        commitFile(wd, "README.md", "changed\n", "also README");
      },
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    // Design 05-restart-asks: the commits go to the run's wip branch, marked `continue`; the PR branch is untouched.
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation", wip: { branch: `factory/wip/${item.id}/${run.id}`, continue: true } });
    expect(f.broker.pushes()).toEqual([`factory/wip/${item.id}/${run.id}`]);
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(await f.store.listHandoffs(item.id)).toEqual([]);
  });
});

describe("the base rerun's command", () => {
  it("takes the failing test files from vitest's FAIL lines, each once, in order", () => {
    const out = " FAIL  tests/b.test.ts > one\n FAIL  tests/a.test.ts > two\n FAIL  tests/b.test.ts > three\n Test Files  2 failed (9)\n";
    expect(failingTestFiles(out)).toEqual(["tests/b.test.ts", "tests/a.test.ts"]);
    expect(failingTestFiles("src/a.ts(1,7): error TS2322")).toEqual([]);
  });

  it("puts the files after `--` for npm, and as they are for a command with `--` or another runner", () => {
    expect(withTestFiles(["npm", "test"], ["tests/a.test.ts"])).toEqual(["npm", "test", "--", "tests/a.test.ts"]);
    expect(withTestFiles(["npm", "run", "t", "--", "--bail"], ["tests/a.test.ts"])).toEqual(["npm", "run", "t", "--", "--bail", "tests/a.test.ts"]);
    expect(withTestFiles(["vitest", "run"], ["tests/a.test.ts"])).toEqual(["vitest", "run", "tests/a.test.ts"]);
  });
});

// Checks run with no database (design §4, decision changed 2026-11-13): the tool env and the slot env only.
describe("check commands get the tool env and the slot env only", { timeout: 60_000 }, () => {
  it("no database env reaches a check command or an agent run, and the PR body has no skip line", async () => {
    const f = await setup({
      implement: (wd) => commitFile(wd, "src/sqlite-fail.txt", "x\n", "add a fault"),
      fix: fixBy("src/sqlite-fail.txt"),
    });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    expect(f.checkExecs().length).toBeGreaterThan(CHECKS.length);
    const allowed = new Set(["PATH", "HOME", "GIT_CONFIG_GLOBAL", "SF_WORKER_INDEX", "SF_TEST_WORKERS", "SF_RATCHET_SHRINK"]);
    const database = /MYSQL|DATABASE|_DB_|DB_URL/;
    for (const e of f.checkExecs()) {
      for (const k of Object.keys(e.env)) expect(allowed.has(k), `${e.cmd}: ${k}`).toBe(true);
      expect(Object.keys(e.env).some((k) => database.test(k)), e.cmd).toBe(false);
    }
    expect(f.runner.specs.length).toBeGreaterThan(2);
    for (const s of f.runner.specs) expect(Object.keys(s.env_allowlist).some((k) => database.test(k))).toBe(false);
    const body = f.broker.prBody();
    expect(body).toContain("Checked before push:");
    expect(body).not.toMatch(/skipped/i);
  });
});

// Ratchet shrink mode before push (design 04-pre-push-gates, pre-push checks): the checks run with SF_RATCHET_SHRINK=1,
// and the known-violations lists they lowered are committed alone, then the gates run again before any push.
describe("implement run: the factory lowers shrunk ratchet counts before push", { timeout: 60_000 }, () => {
  const LIST = "tests/architecture/known-violations/rule.json";
  // Stands in for tests/architecture/lib.ts's ratchetCounts: the budget of src/a.txt is its line count.
  const RATCHET = ["node", "-e", `
    const fs = require("fs"); const f = ${JSON.stringify(LIST)};
    const known = JSON.parse(fs.readFileSync(f, "utf8")); const n = fs.readFileSync("src/a.txt", "utf8").split("\\n").length - 1;
    if (n > known["src/a.txt"]) { console.log("grew: src/a.txt"); process.exit(1); }
    if (n < known["src/a.txt"]) {
      if (process.env.SF_RATCHET_SHRINK !== "1") { console.log("fell_but_list_not_lowered: src/a.txt"); process.exit(1); }
      fs.writeFileSync(f, JSON.stringify({ ...known, "src/a.txt": n }, null, 2) + "\\n");
    }`, "ratchet"];
  const listed = (n: number) => JSON.stringify({ "src/a.txt": n }, null, 2) + "\n";
  const LOWER = "Lower the shrunk known-violations counts";

  it("a shrunk count is lowered to the real count and committed alone before push, with no agent edit", async () => {
    const f = await setup({ checks: [RATCHET], base: { [LIST]: listed(3) } });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    const branch = `refs/heads/factory/${item.id}`;
    expect(git(f.origin, "show", `${branch}:${LIST}`) + "\n").toBe(listed(1));
    expect(git(f.origin, "log", "-1", "--format=%s", branch)).toBe(LOWER);
    expect(git(f.origin, "show", "--name-only", "--format=", branch).trim()).toBe(LIST);
    // The agent never touched the list: only the lowering commit did.
    expect(git(f.origin, "log", "--format=%s", `main..${branch}`, "--", LIST)).toBe(LOWER);
    expect(f.fixSteps).toHaveLength(0);
    expect(f.sandbox.execs.find((e) => e.cmd.startsWith("node -e"))!.env.SF_RATCHET_SHRINK).toBe("1");
    expect((await f.store.listHandoffs(item.id)).map((h) => h.worked_on)).toEqual(["implementer edits a (1)", LOWER]);
    expect((await f.implementRuns(item.id))[0]!.outcome).toMatchObject({ status: "succeeded", data: { commits: 2 } });
  });

  it("a count that grew still fails: grew, the list is not raised, checks_failed and nothing pushed", async () => {
    const f = await setup({
      checks: [RATCHET], base: { [LIST]: listed(1) },
      implement: (wd) => commitFile(wd, "src/a.txt", "1\n2\n3\n", "a grows"),
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(f.fixSteps[0]!.prompt).toContain("grew: src/a.txt");
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(f.broker.pushes()).not.toContain(`factory/${item.id}`);
    const wip = `refs/heads/factory/wip/${item.id}/${run.id}`;
    expect(git(f.origin, "show", `${wip}:${LIST}`) + "\n").toBe(listed(1));
    expect(git(f.origin, "log", "--format=%s", wip)).not.toContain(LOWER);
  });

  it("the lowering commit goes through the gates again: a floor on the lists blocks the push and keeps the head on the wip branch", async () => {
    const f = await setup({ checks: [RATCHET], base: { [LIST]: listed(3) }, floors: [{ prefix: "tests/architecture/known-violations/", tier: 4 }] });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { floor_block: true, required_tier: 4, floor_paths: [{ path: LIST }], wip: { branch: `factory/wip/${item.id}/${run.id}` } } });
    expect(f.remoteHas(`refs/heads/factory/${item.id}`)).toBe(false);
    expect(f.broker.pushes()).toEqual([`factory/wip/${item.id}/${run.id}`]);
  });

  it("no commit when the checks lowered nothing", async () => {
    const f = await setup({ checks: [RATCHET], base: { [LIST]: listed(1) } });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    const branch = `refs/heads/factory/${item.id}`;
    expect(git(f.origin, "log", "--format=%s", `main..${branch}`)).toBe("implementer edits a (1)");
  });
});

// Test selection (design §4, decided 2026-11-21): with repo.test_selection, only the check equal to
// repo.test_command runs on the test files the round's own diff reaches, plus the always-run list, in enforce mode.
// In shadow mode (no stored mode) it runs whole, and the run records the selection and any miss.
describe("implement run: test selection before push", { timeout: 60_000 }, () => {
  const TESTS = ["sh", "-c", "exit 0", "tests"];
  const base = {
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
    "tests/b.test.ts": 'import { b } from "../src/b.js";\n',
    "tests/c.test.ts": 'import { c } from "../src/c.js";\n',
    "tests/always.test.ts": "\n",
  };
  const selection = { hubs: [], always: ["tests/always.test.ts"] };

  it("in enforce mode each round narrows only the test command to the files its own diff reaches, and logs the selection first", async () => {
    const f = await setup({
      base, checks: [TYPECHECK, TESTS], repo: { test_command: TESTS, test_selection: selection },
      implement: (wd) => {
        commitFile(wd, "src/b.ts", "export const b = 2;\n", "change b");
        commitFile(wd, "src/type-error.txt", "broken\n", "add a fault");
      },
      fix: (wd) => {
        removeFile(wd, "src/type-error.txt", "fix: remove the fault");
        commitFile(wd, "src/c.ts", "export const c = 2;\n", "change c");
      },
    });
    await f.store.setLearnedSetting({
      project: PROJECT_KEY, key: MODE_KEY, expected: null, value: '"enforce"', evidence_run_ids: [], window_end: f.clock.now().toISOString() as never, actor: SELECTION_ACTOR,
    });
    const item = await f.approveAndImplement();
    expect(item.stage).toBe("REVIEW");
    const ran = f.checkExecs().map((e) => e.cmd);
    // Round one stops at the typecheck, which runs whole; round two's diff (src/a.txt, src/b.ts, src/c.ts) also reaches tests/c.test.ts.
    expect(ran).toEqual([TYPECHECK.join(" "), TYPECHECK.join(" "), "sh -c exit 0 tests tests/b.test.ts tests/c.test.ts tests/always.test.ts"]);
    const run = (await f.implementRuns(item.id))[0]!;
    const logged = f.log.lines.filter((l) => l.msg.startsWith("test selection (enforce): "));
    expect(logged.map((l) => l.msg)).toEqual([
      "test selection (enforce): 2 files, 1 reaching the 3 changed source and test files, plus 1 always-run: tests/b.test.ts tests/always.test.ts",
      "test selection (enforce): 3 files, 2 reaching the 3 changed source and test files, plus 1 always-run: tests/b.test.ts tests/c.test.ts tests/always.test.ts",
    ]);
    expect(logged.every((l) => l.fields?.run_id === run.id)).toBe(true);
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { test_selection: { mode: "enforce", full: false, files: ["tests/b.test.ts", "tests/c.test.ts", "tests/always.test.ts"] } } });
    // Enforce mode runs no whole command before push, so the run is not counted.
    expect(await f.store.getCursor(cleanCursor(item.project))).toBeNull();
  });

  it("with no stored mode (shadow) the test command runs whole; the run records its selection and counts one clean run", async () => {
    const f = await setup({ base, checks: [TESTS], repo: { test_command: TESTS, test_selection: selection } });
    const item = await f.approveAndImplement();
    expect(item.stage).toBe("REVIEW");
    expect(f.checkExecs().map((e) => e.cmd)).toEqual(["sh -c exit 0 tests"]);
    const run = (await f.implementRuns(item.id))[0]!;
    expect(f.log.lines.filter((l) => l.msg.startsWith("test selection")).map((l) => l.msg)).toEqual([
      "test selection (shadow): 1 files, 0 reaching the 1 changed source and test files, plus 1 always-run: tests/always.test.ts",
    ]);
    expect(run.outcome).toMatchObject({
      status: "succeeded", data: { test_selection: { mode: "shadow", full: false, files: ["tests/always.test.ts"], reason: expect.stringContaining("1 files") } },
    });
    expect(await f.store.getCursor(cleanCursor(item.project))).toBe("1");
  });

  it("in shadow mode a failing test file outside the selection is a miss: recorded with the changed files, and the count resets", async () => {
    // Fails while src/fault.txt is there, naming tests/c.test.ts, which the change to src/b.ts does not reach.
    const failing = failsWhile("tests", "src/fault.txt", " FAIL  tests/c.test.ts > c > breaks");
    const f = await setup({
      base, checks: [failing], repo: { test_command: failing, test_selection: selection },
      implement: (wd) => {
        commitFile(wd, "src/b.ts", "export const b = 2;\n", "change b");
        commitFile(wd, "src/fault.txt", "broken\n", "add a fault");
      },
      fix: fixBy("src/fault.txt"),
    });
    await f.store.advanceCursor(cleanCursor(PROJECT_KEY), null, "7");
    const item = await f.approveAndImplement();
    expect(item.stage).toBe("REVIEW");
    // Both rounds ran the whole command.
    expect(f.checkExecs().map((e) => e.cmd)).toEqual([failing.join(" "), failing.join(" ")]);
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({
      status: "succeeded",
      data: { test_selection: { mode: "shadow", misses: ["tests/c.test.ts"], changed: ["src/a.txt", "src/b.ts"] } },
    });
    expect(await f.store.getCursor(cleanCursor(item.project))).toBe("0");
    expect(f.log.lines.some((l) => l.msg.startsWith("test selection miss: tests/c.test.ts"))).toBe(true);
  });

  it("without repo.test_selection the test command runs whole, and nothing is logged", async () => {
    const f = await setup({ base, checks: [TYPECHECK, TESTS], repo: { test_command: TESTS } });
    await f.approveAndImplement();
    expect(f.checkExecs().map((e) => e.cmd)).toEqual([TYPECHECK.join(" "), "sh -c exit 0 tests"]);
    expect(f.log.lines.some((l) => l.msg.startsWith("test selection"))).toBe(false);
  });
});
