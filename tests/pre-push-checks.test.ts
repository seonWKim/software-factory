import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { failingTestFiles, withTestFiles } from "../src/core/checks.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { type AdminConnection, MysqlLocalTestDatabase } from "../src/impl/test-database/mysql-local-test-database.js";
import { MYSQL_SKIPPED, NoTestDatabase } from "../src/impl/test-database/no-test-database.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { TestDatabase } from "../src/interfaces/test-database.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeForge, FAKE_GITHUB_TOOLS, FakeAuth, FakeRunner, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, recordingLog, runComments } from "./helpers/fakes.js";
import { git, gitTemplate } from "./helpers/git-fixture.js";
import { newStore } from "./helpers/store.js";

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
    if (name === "github.preflight") return { ok: true, content: {} };
    // The run's last step: the bare origin stands in for the forge, so the stored branch lands there at once;
    // outbound's push and PR (RFC 0015 M7) are logged into \`calls\` by the controller's FakeForge.
    if (name === STORE_BRANCH) {
      git(String(a.workdir), "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: { sha: git(String(a.workdir), "rev-parse", "HEAD").trim(), forge: true } };
    }
    this.calls.push({ ctx, name, args: a });
    if (name === "github.push_branch") {
      git(String(a.workdir), "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: {} };
    }
    if (name === "github.open_pr") return { ok: true, content: { number: 42 } };
    return { ok: true, content: {} };
  }
  names() {
    return this.calls.map((c) => c.name);
  }
  pushes() {
    return this.calls.filter((c) => c.name === "github.push_branch").map((c) => String(c.args.branch));
  }
  prBody() {
    return String(this.calls.find((c) => c.name === "github.open_pr")?.args.body ?? "");
  }
}

const spec = {
  in_short: "AS-IS: a.\nTO-BE: b.",
  problem: "Change a",
  done_criteria: ["a changes"],
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
/** Fails only when the run's database URL is set: the MySQL tests run only then. */
const MYSQL = [
  "sh", "-c",
  "if [ -n \"$SF_TEST_MYSQL_URL\" ] && [ -f src/mysql-fail.txt ]; then echo 'FAIL tests/store-contract.test.ts > mysql > claims a run'; exit 1; fi",
  "mysql-tests",
];
const CHECKS = [TYPECHECK, SQLITE, MYSQL];

const PASSWORD = "Pw-9f8e7d6c5b4a3210";
const DB_URL = `mysql://sf_test:${PASSWORD}@127.0.0.1:3306/sf_test_run`;

/** A TestDatabase that records each run's lease and its release. */
class FakeTestDatabase implements TestDatabase {
  created: string[] = [];
  released: string[] = [];
  async create(run_id: string) {
    this.created.push(run_id);
    return {
      env: { SF_TEST_MYSQL_URL: DB_URL },
      redact: [DB_URL, PASSWORD],
      skipped: null,
      release: async () => void this.released.push(run_id),
    };
  }
}

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
  checks?: string[][];
  implement?: AgentStep;
  fix?: AgentStep;
  testDatabase?: TestDatabase;
  scanner?: PatternEgressScanner;
  max_attempts?: number;
} = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const root = repos.copy();
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  const cfg: FactoryConfig = {
    ...config,
    repo: { ...config.repo, path: repo, check_commands: opts.checks ?? CHECKS },
    settings: { ...config.settings, defaults: { ...config.settings.defaults, max_attempts: opts.max_attempts ?? 3 } },
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
    ...(opts.testDatabase ? { testDatabase: opts.testDatabase } : {}),
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
    { name: "a typecheck failure", file: "src/type-error.txt", cmd: TYPECHECK, say: "error TS2322", db: false },
    { name: "a SQLite test failure", file: "src/sqlite-fail.txt", cmd: SQLITE, say: "FAIL tests/store-contract.test.ts > sqlite", db: false },
    { name: "a MySQL test failure", file: "src/mysql-fail.txt", cmd: MYSQL, say: "FAIL tests/store-contract.test.ts > mysql", db: true },
  ]) {
    it(`${c.name}: no push before the fix; the fix step gets the command and the output tail; the fixed branch is pushed`, async () => {
      const db = new FakeTestDatabase();
      const f = await setup({
        implement: (wd) => commitFile(wd, c.file, "broken\n", "add a fault"),
        fix: (wd, s) => {
          // Nothing was pushed while the fix step ran.
          expect(f.broker.pushes()).toEqual([]);
          expect(s.prompt).toContain(`\`${c.cmd.join(" ")}\` failed`);
          fixBy(c.file)(wd, s);
        },
        testDatabase: db,
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

      expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
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
      expect(db.created).toEqual([run.id]);
      expect(db.released).toEqual([run.id]);
      // The MySQL check failed only because the run's database URL was in its environment.
      if (c.db) expect(f.checkExecs().every((e) => e.env.SF_TEST_MYSQL_URL === DB_URL)).toBe(true);
    });
  }

  it("a successful run's PR body has a 'Checked before push' line per command, with its result", async () => {
    const f = await setup({ testDatabase: new FakeTestDatabase() });
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
    expect(f.broker.names()).not.toContain("github.open_pr");
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
    expect(f.broker.names()).not.toContain("github.open_pr");
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
    expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    const prompt = f.fixSteps[0]!.prompt;
    expect(prompt).toContain("`sh -c");
    expect(prompt).toContain("leaky` failed (exited 1)");
    expect(prompt).not.toContain(token);
    expect(prompt).toContain("Its output is withheld");
  });

  it("after a fix commit the scope gate runs again: a fix outside allowed_paths fails with scope_violation and pushes nothing", async () => {
    const f = await setup({
      implement: (wd) => commitFile(wd, "src/type-error.txt", "x\n", "add a fault"),
      fix: (wd) => {
        removeFile(wd, "src/type-error.txt", "fix the type");
        commitFile(wd, "README.md", "changed\n", "also README");
      },
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });
    expect(run.outcome).not.toHaveProperty("wip");
    expect(f.broker.pushes()).toEqual([]);
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

describe("the test database's URL stays with the check commands", { timeout: 60_000 }, () => {
  it("SF_TEST_MYSQL_URL is in every check command's environment and in no agent run's environment", async () => {
    const f = await setup({
      testDatabase: new FakeTestDatabase(),
      implement: (wd) => commitFile(wd, "src/sqlite-fail.txt", "x\n", "add a fault"),
      fix: fixBy("src/sqlite-fail.txt"),
    });
    await f.approveAndImplement();
    expect(f.checkExecs().length).toBeGreaterThan(CHECKS.length);
    for (const e of f.checkExecs()) expect(e.env.SF_TEST_MYSQL_URL, e.cmd).toBe(DB_URL);
    for (const e of f.sandbox.execs.filter((x) => x.cmd.startsWith("git "))) expect(e.env).not.toHaveProperty("SF_TEST_MYSQL_URL");
    expect(f.runner.specs.length).toBeGreaterThan(2);
    for (const s of f.runner.specs) {
      expect(s.env_allowlist).not.toHaveProperty("SF_TEST_MYSQL_URL");
      expect(JSON.stringify(s)).not.toContain(PASSWORD);
    }
  });

  it("a check that prints the URL: neither the URL nor its password reaches a prompt, the outcome, a comment or a log", async () => {
    const printUrl = ["sh", "-c", "echo \"connecting to $SF_TEST_MYSQL_URL\"; echo \"pw=${SF_TEST_MYSQL_URL#*:*:}\"; exit 1", "print-url"];
    const f = await setup({
      checks: [printUrl],
      testDatabase: new FakeTestDatabase(),
      implement: () => undefined,
      fix: () => undefined,
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });

    const seen = [
      ...f.runner.specs.map((s) => `${s.system_prompt}\n${s.prompt}`),
      JSON.stringify(run.outcome),
      ...f.broker.calls.map((c) => JSON.stringify(c.args)),
      ...f.source.comments.map((c) => c.body),
      ...f.log.lines.map((l) => JSON.stringify(l)),
      ...(await f.store.listStateChanges(item.id)).map((c) => JSON.stringify(c)),
    ];
    // The output did reach the fix step, redacted.
    expect(f.fixSteps[0]!.prompt).toContain("connecting to [redacted]");
    for (const text of seen) {
      expect(text).not.toContain(DB_URL);
      expect(text).not.toContain(PASSWORD);
    }
  });
});

describe("TestDatabase plugins", { timeout: 60_000 }, () => {
  /** An admin connection that records every statement. */
  const recorder = () => {
    const queries: string[] = [];
    const connects: { host: string; port: number; user: string; password: string }[] = [];
    const connect = async (server: { host: string; port: number; user: string; password: string }): Promise<AdminConnection> => {
      connects.push(server);
      return { query: async (sql: string) => void queries.push(sql), end: async () => undefined };
    };
    return { queries, connects, connect };
  };
  const ADMIN = `mysql://sf_test:${PASSWORD}@127.0.0.1:3307`;

  it("mysql-local creates one sf_test_* database per run and drops it in a finally block, also when a check fails", async () => {
    const r = recorder();
    const f = await setup({
      checks: [failsWhile("always", "src/a.txt", "fail")],
      testDatabase: new MysqlLocalTestDatabase(() => ADMIN, r.connect),
      implement: () => undefined,
      fix: () => undefined,
    });
    const item = await f.approveAndImplement();
    const run = (await f.implementRuns(item.id))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    const name = `sf_test_${run.id}`;
    expect(r.queries).toEqual([`CREATE DATABASE \`${name}\``, `DROP DATABASE IF EXISTS \`${name}\``]);
    expect(r.connects.every((c) => c.host === "127.0.0.1" && c.port === 3307 && c.user === "sf_test" && c.password === PASSWORD)).toBe(true);
    // Each check got the per-run URL: the same user, the run's database.
    for (const e of f.checkExecs()) expect(e.env.SF_TEST_MYSQL_URL).toBe(`mysql://sf_test:${PASSWORD}@127.0.0.1:3307/${name}`);
  });

  it("mysql-local refuses to create or drop any database whose name does not start with sf_test_", async () => {
    const r = recorder();
    const db = new MysqlLocalTestDatabase(() => ADMIN, r.connect);
    for (const name of ["software_factory", "mysql", "sf_testx", "sf_test_", "sf_test_a`; DROP DATABASE software_factory; --", "SF_TEST_a", "x_sf_test_a"]) {
      await expect(db.createDatabase(name), name).rejects.toThrow(/refusing database/);
      await expect(db.dropDatabase(name), name).rejects.toThrow(/refusing database/);
    }
    expect(r.connects).toEqual([]);
    expect(r.queries).toEqual([]);
    await db.dropDatabase("sf_test_ok_1");
    expect(r.queries).toEqual(["DROP DATABASE IF EXISTS `sf_test_ok_1`"]);
  });

  it("mysql-local's errors never include the admin URL", async () => {
    const db = new MysqlLocalTestDatabase(() => `http://u:${PASSWORD}@h`, recorder().connect);
    const err = await db.create("run_1").then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/TEST_MYSQL_URL must look like/);
    expect(err).not.toContain(PASSWORD);
  });

  it("none sets no SF_TEST_MYSQL_URL, and the PR body says the MySQL checks were skipped", async () => {
    const f = await setup({ testDatabase: new NoTestDatabase() });
    const item = await f.approveAndImplement();
    expect(item).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    for (const e of f.checkExecs()) expect(e.env).not.toHaveProperty("SF_TEST_MYSQL_URL");
    expect(f.broker.prBody()).toContain(MYSQL_SKIPPED);
    expect(MYSQL_SKIPPED).toMatch(/MySQL checks skipped/);
  });
});

