import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { type CheckRound, checkCommands, doneCheckRound } from "../src/core/checks.js";
import type { DoneCheck } from "../src/core/done-checks.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../src/interfaces/tool-broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FAKE_GITHUB_TOOLS } from "./helpers/fakes/broker.js";
import { FakeAuth, FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes/config.js";
import { git, gitTemplate } from "./helpers/git-fixture.js";
import { newStore } from "./helpers/store.js";

// Done-when checks in the implement run (design 04-pre-push-gates, RFC 0024 WP3 phase 2): the item's done checks run in
// the check round before push, after the check list; a failing one is a failed check, named by its done-when line.

function commitFile(repo: string, path: string, content: string, msg: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
}

/** Records every exec, so a test sees which check commands ran with which arguments. */
class RecordingSandbox extends NoOpSandbox {
  execs: string[][] = [];
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    this.execs.push([...cmd]);
    return super.exec(h, cmd, o);
  }
}

/** Stores the branch in the bare origin, as the pre-push tests' broker does; logs every other call. */
class GitPushBroker implements ToolBroker {
  calls: { ctx?: ToolCallContext; name: string; args: Record<string, unknown> }[] = [];
  listTools(): ToolDescriptor[] {
    return [];
  }
  allTools(): ToolDescriptor[] {
    return [...FAKE_GITHUB_TOOLS];
  }
  async call(_ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const a = args as Record<string, unknown>;
    if (name === "forge.preflight") return { ok: true, content: {} };
    if (name === STORE_BRANCH) {
      git(String(a.workdir), "push", "--quiet", "origin", `HEAD:refs/heads/${String(a.branch)}`);
      return { ok: true, content: { sha: git(String(a.workdir), "rev-parse", "HEAD").trim(), forge: true } };
    }
    this.calls.push({ name, args: a });
    return { ok: true, content: {} };
  }
  prBody(): string {
    return String(this.calls.find((c) => c.name === "forge.open_change")?.args.body ?? "");
  }
}

/** The test command: with no file it passes; with files it fails, vitest-style, on a missing one or the first one that holds "broken". */
const TESTS = ["sh", "-c", 'for f; do [ -e "$f" ] || { echo "No test files found, exiting with code 1"; exit 1; }; if grep -q broken "$f"; then echo " FAIL  $f > checks the line"; exit 1; fi; done', "tests"];
const TYPECHECK = ["sh", "-c", "exit 0", "typecheck"];
const NEW_TEST = "tests/new.test.ts";
const EXISTING = ["tests/data-table-docs.test.ts", "tests/table-docs-extra.test.ts"];
const LINES = ["the new test passes", "the whole suite passes", "the page looks right"];

const repos = gitTemplate((root) => {
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  commitFile(dev, "src/a.txt", "a\n", "add a");
  for (const f of EXISTING) commitFile(dev, f, "passes\n", `add ${f}`);
  git(dev, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, join(root, "repo"));
});

type AgentStep = (workdir: string, spec: AgentRunSpec) => void;

/** One item through triage (with `done_checks`) and approval; the implementer runs `implement`, a fix step `fix`. */
async function setup(o: { done_checks: DoneCheck[]; implement: AgentStep; fix?: AgentStep }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const root = repos.copy();
  const repo = join(root, "repo");
  const cfg: FactoryConfig = {
    ...config,
    repo: { ...config.repo, path: repo, test_command: TESTS, check_commands: [TYPECHECK, TESTS] },
    settings: { ...config.settings, defaults: { ...config.settings.defaults, max_attempts: 2 } },
  };
  const spec = {
    in_short: "AS-IS: a.\nTO-BE: b.", problem: "Change a", done_criteria: LINES, done_checks: o.done_checks, desired_output: "a",
    scope: "src and tests", allowed_paths: ["src/", "tests/"], files_to_change: ["src/a.txt"], tier: 2, tier_reason: "small",
    estimated_lines: 10, estimated_files: 2,
  };
  const fixSteps: AgentRunSpec[] = [];
  const reply = (): Partial<AgentRunResult> => ({ output: { summary: "changed a", next_steps: "none" } });
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      if (s.prompt.includes("## Checks failed before push")) {
        fixSteps.push(s);
        o.fix?.(s.sandbox.workdir, s);
        return reply();
      }
      o.implement(s.sandbox.workdir, s);
      return reply();
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const source = new FakeSource();
  const sandbox = new RecordingSandbox(join(repo, ".worktrees"));
  const broker = new GitPushBroker();
  const log = recordingLog();
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const controller = new ControllerRole({ store, source, forge: new FakeForge(null, broker.calls), auth: new FakeAuth(), clock, config: cfg, log, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg,
    prompts: { triage: "T", implement: "I", review: "R", resolve: "S" }, log, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(7);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
  await step();
  source.queue.push({ kind: "spec_approved", source: src, comment_id: "700", approver: alice });
  await step();
  const item = (await store.getWorkItemBySource("github_issue", src.id))!;
  const implementRuns = async () => (await store.listRuns(item.id as WorkItem["id"])).filter((r) => r.kind === "implement");
  /** The test command's runs (the check list's whole run and each test file check), as argv after the script. */
  const testRuns = () => sandbox.execs.filter((c) => c[2] === TESTS[2]).map((c) => c.slice(4));
  return { store, clock, cfg, step, item, fixSteps, broker, implementRuns, testRuns };
}

const changeA: AgentStep = (wd) => commitFile(wd, "src/a.txt", "a changed\n", "change a");
/** A test file check; one the base lacks is marked new, as triage must (design 04-triage). */
const testFile = (line: string, test_file = NEW_TEST, isNew = test_file === NEW_TEST): DoneCheck => ({ line, test_file, ...(isNew ? { new: true as const } : {}) });
const manual = (line: string): DoneCheck => ({ line, manual: true, reason: "a person looks at the page" });

describe("implement run: the item's done checks run before push", { timeout: 60_000 }, () => {
  it("a failing done check fails the run: the fix step and the retry's fix step get its done-when line and output", async () => {
    let tries = 0;
    const f = await setup({
      done_checks: [testFile(LINES[0]!), { line: LINES[1]!, command: TESTS.join(" ") }, manual(LINES[2]!)],
      implement: (wd) => commitFile(wd, NEW_TEST, "broken\n", "add the new test"),
      fix: (wd) => commitFile(wd, "src/a.txt", `a tried ${++tries}\n`, "a fix that does not fix"),
    });

    const [first] = await f.implementRuns();
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    const outcome = first!.outcome as unknown as { detail: string; done_checks: unknown };
    expect(outcome.detail).toContain(`"${LINES[0]}"`);
    // The run created the file: its failure is its exit code, as before, never "does not exist".
    expect(outcome.detail).toContain("exited 1");
    expect(outcome.detail).not.toContain("does not exist");
    expect(outcome.done_checks).toEqual([
      { line: LINES[0], result: "fail", check: `${TESTS.join(" ")} ${NEW_TEST}` },
      { line: LINES[1], result: "pass", check: TESTS.join(" ") },
      { line: LINES[2], result: "manual", check: "a person looks at the page" },
    ]);
    // The controller keeps the lines' results on the state change it writes for the failed run (not its wip push's).
    const failedChange = (await f.store.listStateChanges(f.item.id)).find((c) => c.detail?.run_id === first!.id && c.detail?.error_code === "checks_failed");
    expect(JSON.parse(String(failedChange?.detail?.done_checks))).toEqual(outcome.done_checks);
    expect(f.fixSteps).toHaveLength(1);
    for (const want of [`the done-when line "${LINES[0]}"`, `FAIL  ${NEW_TEST} > checks the line`]) expect(f.fixSteps[0]!.prompt).toContain(want);

    // The retry (from the kept commits, no new agent step) runs the checks again; its one fix step gets the same line and output.
    f.clock.advance(f.cfg.retry_max_ms);
    await f.step();
    expect(f.fixSteps).toHaveLength(2);
    for (const want of [`the done-when line "${LINES[0]}"`, `FAIL  ${NEW_TEST} > checks the line`]) expect(f.fixSteps[1]!.prompt).toContain(want);
    expect((await f.implementRuns()).map((r) => r.outcome?.status)).toEqual(["failed", "failed"]);
  });

  it("passing checks: the run succeeds, the test file check runs only its file, each line's result is on the outcome", async () => {
    const f = await setup({
      done_checks: [testFile(LINES[0]!), { line: LINES[1]!, command: TESTS.join(" ") }, manual(LINES[2]!)],
      implement: (wd) => {
        commitFile(wd, NEW_TEST, "passes\n", "add the new test");
        commitFile(wd, "tests/other.test.ts", "broken\n", "a test no done check names");
      },
    });

    const [run] = await f.implementRuns();
    expect(run!.outcome).toMatchObject({ status: "succeeded" });
    expect(f.fixSteps).toHaveLength(0);
    // The check list's test command whole (no file), then the done check on its one file; the command check runs no second time.
    expect(f.testRuns()).toEqual([[], [NEW_TEST]]);
    expect((run!.outcome as { data: Record<string, unknown> }).data.done_checks).toEqual([
      { line: LINES[0], result: "pass", check: `${TESTS.join(" ")} ${NEW_TEST}` },
      { line: LINES[1], result: "pass", check: TESTS.join(" ") },
      { line: LINES[2], result: "manual", check: "a person looks at the page" },
    ]);
    const implemented = (await f.store.listStateChanges(f.item.id)).find((c) => c.reason === "implemented");
    expect(JSON.parse(String(implemented?.detail?.done_checks))).toEqual((run!.outcome as { data: Record<string, unknown> }).data.done_checks);
    expect(f.broker.prBody()).toContain(`Not run, a person checks it: "${LINES[2]}" (a person looks at the page)`);
  });
});

// A test file check on a file that does not exist (design 04-triage and 04-pre-push-gates, 2026-11-24): triage sends a
// missing, unmarked name back once and never swaps it; a missing file the run did not create fails with "does not exist".
describe("a done check on a missing test file", { timeout: 60_000 }, () => {
  it("triage sends a missing, unmarked test file back once, never swapped for a close one, and fails when it is still named", async () => {
    const f = await setup({ done_checks: [testFile(LINES[0]!, "tests/table-docs.test.ts"), manual(LINES[1]!), manual(LINES[2]!)], implement: changeA });
    const triage = (await f.store.listRuns(f.item.id)).find((r) => r.kind === "triage");
    expect(triage!.outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
    expect((triage!.outcome as unknown as { detail: string }).detail).toContain("not marked new: true: tests/table-docs.test.ts");
    expect(f.item.done_checks).toBeNull();
    expect(await f.implementRuns()).toEqual([]);
  });

  it("a missing file the run did not create fails with its own outcome, and the fix step names no file when none is close", async () => {
    const f = await setup({ done_checks: [testFile(LINES[0]!, "tests/zzz.test.ts", true), manual(LINES[1]!), manual(LINES[2]!)], implement: changeA });
    const [first] = await f.implementRuns();
    expect(first!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    const detail = (first!.outcome as unknown as { detail: string }).detail;
    expect(detail).toContain("the check names tests/zzz.test.ts, which does not exist");
    expect(detail).not.toContain("exited 1");
    expect(f.fixSteps[0]!.prompt).toContain("failed (the check names tests/zzz.test.ts, which does not exist)");
    expect(f.fixSteps[0]!.prompt).toContain("The test file `tests/zzz.test.ts` does not exist on this branch");
    expect(f.fixSteps[0]!.prompt).not.toContain("closest existing test file");
  });

  it("the fix step suggests the closest existing test file by name", async () => {
    const gone = EXISTING[0]!;
    const f = await setup({
      done_checks: [testFile(LINES[0]!, gone), manual(LINES[1]!), manual(LINES[2]!)],
      implement: (wd) => { git(wd, "rm", "--quiet", "--", gone); git(wd, "commit", "--quiet", "-m", "drop it"); },
    });
    const [first] = await f.implementRuns();
    expect((first!.outcome as unknown as { detail: string }).detail).toContain(`the check names ${gone}, which does not exist`);
    expect(f.fixSteps[0]!.prompt).toContain(`The closest existing test file by name is \`${EXISTING[1]}\``);
  });
});

describe("doneCheckRound", () => {
  const repo = { ...config.repo, test_command: ["npm", "test"], check_commands: [["npm", "run", "typecheck"], ["npm", "test"]] };
  const ran = (oks: boolean[]): CheckRound => {
    const results = oks.map((ok, i) => ({ command: [`c${i}`], ok, how: ok ? "passed" : "exited 1", tail: "" }));
    return { results, failed: results.find((r) => !r.ok) ?? null };
  };

  it("null done_checks: the check list as it is, nothing marked and no results", () => {
    const d = doneCheckRound(repo, null);
    expect(d.commands).toEqual(checkCommands(repo));
    const round = d.mark(ran([true, false]));
    expect(round.results.map((r) => r.lines)).toEqual([undefined, undefined]);
    expect(d.results(round)).toBeUndefined();
  });

  it("a test file check is the test command on that file after the list; a manual line adds nothing", () => {
    const d = doneCheckRound(repo, [testFile("a"), manual("b"), { line: "c", command: "npm run typecheck" }, testFile("d")]);
    expect(d.commands).toEqual([["npm", "run", "typecheck"], ["npm", "test"], ["npm", "test", "--", NEW_TEST]]);
    // Two lines on one test file share its one command.
    expect(d.mark(ran([true, true, false])).results.map((r) => r.lines)).toEqual([["c"], undefined, ["a", "d"]]);
  });

  it("a line whose command never ran, because an earlier one failed first, is not_run", () => {
    const d = doneCheckRound(repo, [{ line: "a", command: "npm run typecheck" }, testFile("b")]);
    expect(d.results(ran([false]))!.map((r) => r.result)).toEqual(["fail", "not_run"]);
  });

  it("a failed test file check on a file the branch lacks says it does not exist, with the closest file; a present one keeps its exit code", () => {
    const d = doneCheckRound(repo, [testFile("a", "tests/table-docs.test.ts")]);
    const failed = d.missing(ran([true, true, false]), ["tests/data-table-docs.test.ts"]).failed!;
    expect(failed).toMatchObject({ how: "the check names tests/table-docs.test.ts, which does not exist", missing: { file: "tests/table-docs.test.ts", closest: "tests/data-table-docs.test.ts" } });
    expect(d.missing(ran([true, true, false]), ["tests/table-docs.test.ts"]).failed).toMatchObject({ how: "exited 1" });
    expect(d.missing(ran([true, true, false]), ["tests/table-docs.test.ts"]).failed).not.toHaveProperty("missing");
    // A failure of a command that is not a test file check names no file.
    expect(d.testFile(ran([true, false]))).toBeNull();
    expect(d.missing(ran([true, false]), []).failed).toMatchObject({ how: "exited 1" });
  });
});
