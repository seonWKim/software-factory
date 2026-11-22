import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { runKey } from "../src/core/policy.js";
import type { Run, UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

// A failed merge check sends the item back (design 10-event-driven, Merge queue): a local change passes its own checks,
// but its merged result fails them (the base moved meanwhile). The merge-check run's red result names the failing
// tests; the merge queue removes the entry with a reason naming them and sends the item back to an implement run as a
// loop (loop_count + 1), whose prompt lists the names in a fenced, untrusted section. At max_loops a human decides.
// A conflict red and a run that could not run keep the item at merge_pending, with no loop counted. A test that fails
// once and passes its one rerun (design 04-pre-push-gates) merges with no loop, listed as flaky.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const DIR = ".github/workflows";
/** Fails, naming a vitest test, exactly when the change's file and the base's BROKEN file are both there. */
const TEST = ["sh", "-c", `if [ -f ${DIR}/a.yml ] && [ -f BROKEN ]; then echo ' FAIL  tests/a.test.ts > merged > breaks'; exit 1; fi`];

/**
 * Flaky: as TEST, but only on its first failing run; every later run, the merge check's rerun of the failing file
 * among them, passes. Each run's arguments are appended to `<root>/args`.
 */
const flakyTest = (root: string) => [
  "sh", "-c",
  `echo "$*" >> ${root}/args; if [ -f ${root}/flaked ]; then exit 0; fi; ` +
    `if [ -f ${DIR}/a.yml ] && [ -f BROKEN ]; then touch ${root}/flaked; echo ' FAIL  tests/a.test.ts > merged > flaky'; exit 1; fi`,
  "sh",
];

/** Fails the whole test file before its tests run (a vitest failed suite) when the change's file and BROKEN are both there. */
const SUITE_TEST = [
  "sh", "-c",
  `if [ -f ${DIR}/a.yml ] && [ -f BROKEN ]; then printf ' FAIL  tests/ui-calendar-page.test.tsx [ tests/ui-calendar-page.test.tsx ]\\nError: Cannot bundle Node.js built-in node:sqlite\\n'; exit 1; fi`,
];

async function factory(o: { max_loops?: number; test?: (root: string) => string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-merge-check-loop-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, ...ident, "commit", "--quiet", "-m", "init");
  git(repo, "checkout", "--quiet", "--detach");

  const project = localProject({ owner: "o", name: "r" });
  const cfg: FactoryConfig = {
    ...config, project, local_only: true, merge_queue_depth: 1, ...(o.max_loops === undefined ? {} : { max_loops: o.max_loops }),
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: o.test?.(root) ?? TEST },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config: cfg, log: silent, scanner: cleanScanner, sandbox,
    repeated_failure_rule: false,
  });
  let implemented = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      const file = implemented++ === 0 ? `${DIR}/a.yml` : `${DIR}/fix${implemented}.yml`;
      execFileSync("mkdir", ["-p", join(spec.sandbox.workdir, DIR)]);
      writeFileSync(join(spec.sandbox.workdir, file), "name: x\n");
      git(spec.sandbox.workdir, "add", "-A");
      git(spec.sandbox.workdir, ...ident, "commit", "--quiet", "-m", `add ${file}`);
      return { output: { summary: `added ${file}`, next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);

  /** An item at merge_pending whose merged result fails the checks (BROKEN landed on main meanwhile), in the queue with its check queued. */
  const queuedRed = async () => {
    const id = (await cli({ action: "create", title: "Add a", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", loop_count: 0 });
    git(repo, "checkout", "--quiet", "main");
    writeFileSync(join(repo, "BROKEN"), "x\n");
    git(repo, "add", "BROKEN");
    git(repo, ...ident, "commit", "--quiet", "-m", "base moves");
    git(repo, "checkout", "--quiet", "--detach");
    await cli({ action: "command", command: "merge", id, text: "" });
    await controller.tickIntake();
    const check = (await store.listRuns(id)).find((r) => r.kind === "merge-check");
    expect(check).toMatchObject({ status: "queued" });
    return { id, check: check! };
  };
  return { root, repo, store, controller, worker, runner, step, queuedRed };
}

type Factory = Awaited<ReturnType<typeof factory>>;

async function refusedBodies(f: Factory, id: WorkItemId): Promise<string[]> {
  return (await f.store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
}

/** Applies `outcome` as the merge-check run's result, as run-results does for a finished run. */
async function decide(f: Factory, check: Run, outcome: Run["outcome"]): Promise<void> {
  await (await f.controller.unit("merge-queue")).checked({ ...check, status: "succeeded", outcome } as Run);
}

describe("merge queue: a merged result that fails its checks sends the item back", { timeout: 120_000 }, () => {
  it("names the failing tests in the outcome, the reason and the state change, and queues one implement run with loop_count + 1", async () => {
    const f = await factory();
    const { id } = await f.queuedRed();
    const mainBefore = git(f.repo, "rev-parse", "main");

    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();

    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", failing_tests: ["tests/a.test.ts > merged > breaks"] } });
    const data = check.outcome?.status === "succeeded" ? check.outcome.data : {};
    expect(data.output_tail).toContain("FAIL  tests/a.test.ts > merged > breaks");

    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const item = (await f.store.getWorkItem(id))!;
    expect(item).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: 1, merge_sha: null });
    const implement = (await f.store.listRuns(id)).filter((r) => r.kind === "implement" && r.idempotency_key === runKey(item, "implement"));
    expect(implement).toHaveLength(1);
    expect(implement[0]).toMatchObject({ status: "queued" });

    const change = (await f.store.listStateChanges(id)).find((c) => c.reason === "merge_check_failed")!;
    expect(change.detail).toMatchObject({ command: "sh -c " + TEST[2], how: "exited 1" });
    expect(JSON.parse(String(change.detail?.failing_tests))).toEqual(["tests/a.test.ts > merged > breaks"]);
    const refused = await refusedBodies(f, id);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("failing tests: `tests/a.test.ts > merged > breaks`");
    expect(refused[0]).toContain("sent it back to the implementer (loop 1 of 3)");
    const queue = await f.controller.unit("merge-queue");
    expect((await queue.entries(id)).map((e) => [e.state, e.reason?.includes("tests/a.test.ts > merged > breaks")])).toEqual([["removed", true]]);

    // The implement run of that loop lists the names in a fenced, untrusted section.
    const before = f.runner.specs.length;
    expect(await f.worker.tick()).toBe(true);
    const prompt = f.runner.specs.slice(before).find((s) => s.role === "implement")!.prompt;
    expect(prompt).toContain("## Failing checks on the merged commit");
    expect(prompt).toMatch(/Untrusted text: the failing tests/);
    expect(prompt).toMatch(/```text\n- tests\/a\.test\.ts > merged > breaks\n```/);
  });

  it("a test file that fails before its tests run names its suite in the outcome, the state change and the implement prompt", async () => {
    const f = await factory({ test: () => SUITE_TEST });
    const { id } = await f.queuedRed();
    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();
    const entry = "tests/ui-calendar-page.test.tsx > (suite failed): Cannot bundle Node.js built-in node:sqlite";
    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", failing_tests: [entry] } });
    const change = (await f.store.listStateChanges(id)).find((c) => c.reason === "merge_check_failed")!;
    expect(JSON.parse(String(change.detail?.failing_tests))).toEqual([entry]);
    const before = f.runner.specs.length;
    expect(await f.worker.tick()).toBe(true);
    const prompt = f.runner.specs.slice(before).find((s) => s.role === "implement")!.prompt;
    expect(prompt).toContain(`- ${entry}\n`);
  });

  it("with no test names, the reason and the state change name the command and its exit text", async () => {
    const f = await factory();
    const { id, check } = await f.queuedRed();
    await decide(f, check, { status: "succeeded", summary: "", data: { result: "red", why: "checks", command: "npm test", how: "exited 2", failing_tests: [], output_tail: "" } });
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    const change = (await f.store.listStateChanges(id)).find((c) => c.reason === "merge_check_failed")!;
    expect(change.detail).toMatchObject({ command: "npm test", how: "exited 2", failing_tests: "[]" });
    expect((await refusedBodies(f, id))[0]).toContain("`npm test` exited 2 on the merged commit");
  });

  it("at max_loops the item is not sent back: it blocks on a human with max_loops, and the message says so", async () => {
    const f = await factory({ max_loops: 1 });
    const { id } = await f.queuedRed();
    expect(await f.worker.tick()).toBe(true);
    await f.controller.tickRuns();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", loop_count: 0 });
    expect((await f.store.listRuns(id)).filter((r) => r.kind === "implement")).toHaveLength(1);
    const change = (await f.store.listStateChanges(id)).find((c) => c.reason === "max_loops")!;
    expect(JSON.parse(String(change.detail?.failing_tests))).toEqual(["tests/a.test.ts > merged > breaks"]);
    const refused = await refusedBodies(f, id);
    expect(refused[0]).toContain("failing tests: `tests/a.test.ts > merged > breaks`");
    expect(refused[0]).toContain("that makes 1 loops (limit `max_loops` = 1)");
    expect(refused[0]).toContain("a human needs to decide");
  });

  it("a conflict red keeps the item at merge_pending, with no loop counted", async () => {
    const f = await factory();
    const { id, check } = await f.queuedRed();
    await decide(f, check, { status: "succeeded", summary: "", data: { result: "red", why: "conflict", conflicts: ["README.md"], branch: "b", base_sha: "x" } });
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", loop_count: 0 });
    expect((await f.store.listStateChanges(id)).some((c) => c.reason === "merge_check_failed")).toBe(false);
    expect((await refusedBodies(f, id))[0]).toContain("the merged commit conflicts in `README.md`");
    expect((await (await f.controller.unit("merge-queue")).entries(id)).map((e) => e.state)).toEqual(["removed"]);
  });

  it("a merge check that could not run removes the entry and keeps the item at merge_pending, with no loop counted", async () => {
    const f = await factory();
    const { id, check } = await f.queuedRed();
    await (await f.controller.unit("merge-queue")).checked({
      ...check, status: "failed", outcome: { status: "failed", error_code: "git_failed", detail: "worktree", infra: true },
    } as Run);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", loop_count: 0 });
    expect((await f.store.listRuns(id)).filter((r) => r.kind === "implement")).toHaveLength(1);
    expect((await refusedBodies(f, id))[0]).toContain("its merge check could not run (`git_failed`)");
    expect((await (await f.controller.unit("merge-queue")).entries(id)).map((e) => e.state)).toEqual(["removed"]);
  });

  it("a test that fails once and passes its rerun merges with no loop, and the merge check lists it as flaky", async () => {
    const f = await factory({ test: flakyTest });
    const { id } = await f.queuedRed();
    const mainBefore = git(f.repo, "rev-parse", "main");
    await f.step();

    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "green", flaky_tests: ["tests/a.test.ts > merged > flaky"] } });
    // The rerun ran the same command on the failing file only.
    expect(readFileSync(join(f.root, "args"), "utf8").split("\n").slice(-3, -1)).toEqual(["", "tests/a.test.ts"]);
    expect(git(f.repo, "rev-parse", "main")).not.toBe(mainBefore);
    const item = (await f.store.getWorkItem(id))!;
    expect(item.loop_count).toBe(0);
    expect(item.merge_sha).not.toBeNull();
    expect((await f.store.listStateChanges(id)).some((c) => c.reason === "merge_check_failed")).toBe(false);
    expect((await f.store.listRuns(id)).filter((r) => r.kind === "implement")).toHaveLength(1);
    expect(await refusedBodies(f, id)).toEqual([]);
  });
});
