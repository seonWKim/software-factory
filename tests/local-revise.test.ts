import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// `/revise <feedback>` on a local item waiting for its merge (issue #563): no PR, so the feedback goes to one
// implement run on the item's local branch, a review follows, and the item waits for its merge again.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

async function localFactory(cfgPatch: Partial<FactoryConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-local-revise-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, ...ident, "commit", "--quiet", "-m", "init");

  const project = localProject({ owner: "o", name: "r" });
  const cfg: FactoryConfig = {
    ...config,
    project,
    local_only: true,
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: ["sh", "-c", "exit 0"] },
    ...cfgPatch,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const auth = new OwnerAuth(store);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
  });
  let commits = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      commits++;
      mkdirSync(join(spec.sandbox.workdir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(spec.sandbox.workdir, ".github", "workflows", "a.yml"), `name: a${commits}\n`);
      git(spec.sandbox.workdir, "add", "-A");
      git(spec.sandbox.workdir, ...ident, "commit", "--quiet", "-m", `change ${commits}`);
      return { output: { summary: "the summary", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  /** The controller reads intake and commands; the worker takes every run it may; the controller applies the outcomes. */
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const revise = (id: WorkItemId, text: string) => cli({ action: "command", command: "revise", id, text });
  const messages = async (id: WorkItemId, prefix: string) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const implementRuns = async (id: WorkItemId) => (await store.listRuns(id)).filter((r) => r.kind === "implement");
  /** A local task through triage, approval, implement and review, waiting for its merge. */
  const toMergePending = async () => {
    const id = (await cli({ action: "create", title: "Add a", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
    return id;
  };
  /** Moves the item to another state, as a test setup. */
  const put = async (id: WorkItemId, patch: WorkItemPatch) => {
    const cur = (await store.getWorkItem(id))!;
    const r = await store.transition({ id, expected_version: cur.version, actor: { kind: "system", id: "test" }, reason: "setup", patch });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  return { repo, store, controller, runner, step, cli, revise, messages, implementRuns, toMergePending, put };
}

describe("revise on a local item at the merge wait (issue #563)", { timeout: 60_000 }, () => {
  it("stores the feedback and moves the item to RUNNING with one implement run on its local branch", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    expect((await f.revise(id, "rename the flag to --dry-run")).code).toBe(0);
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: 1, change_ref: null });
    const queued = (await f.implementRuns(id)).filter((r) => r.status === "queued");
    expect(queued.map((r) => [r.idempotency_key, r.input])).toEqual([[`${id}:implement:l1:r0`, { notes: "rename the flag to --dry-run" }]]);
    const change = (await f.store.listStateChanges(id)).find((c) => c.reason === "pr_revise_requested")!;
    expect(change.actor).toEqual({ kind: "user", id: ME });
    expect(change.detail).toMatchObject({ feedback: "rename the flag to --dry-run" });
    expect(await f.messages(id, "<!-- factory:refused:")).toEqual([]);
  });

  it("after the implement run, a review runs on the local branch and the item waits for its merge again", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const head = git(f.repo, "rev-parse", `refs/heads/factory/${id}`);
    await f.revise(id, "use the existing logger");
    await f.step();
    await f.step();

    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", loop_count: 1, change_ref: null });
    // The fix landed on the same local branch, after the first change.
    expect(git(f.repo, "rev-list", "--count", `${head}..refs/heads/factory/${id}`)).toBe("1");
    const implement = f.runner.specs.filter((s) => s.role === "implement").at(-1)!;
    expect(implement.prompt).toContain("## Feedback on the change");
    expect(implement.prompt).toContain("use the existing logger");
    const reviews = f.runner.specs.filter((s) => s.role === "review");
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    const reasons = (await f.store.listStateChanges(id)).map((c) => c.reason);
    const from = reasons.indexOf("pr_revise_requested");
    expect(from).toBeGreaterThan(-1);
    expect(reasons.slice(from)).toContain("review_passed");
    expect(reasons.indexOf("review_passed", from)).toBeGreaterThan(from);
    // The merge comment again, naming `factory merge`.
    expect((await f.messages(id, "<!-- factory:merge:")).at(-1)).toContain(`factory merge ${id}`);
  });

  it("the same command delivered twice starts one implement run", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    await f.revise(id, "keep the old flag");
    await f.controller.tickIntake();
    const row = (await f.store.listCliCommandsAfter(0, 100)).filter((c) => c.command === "revise").at(-1)!;
    // A second delivery of the same row (another worker, a restart).
    await f.controller.consumeCommand(row);
    await f.controller.consumeCommand(row);

    expect((await f.implementRuns(id)).filter((r) => r.status === "queued")).toHaveLength(1);
    expect((await f.store.listStateChanges(id)).filter((c) => c.reason === "pr_revise_requested")).toHaveLength(1);
  });

  it("with no feedback: refused with the no-feedback wording, and nothing changes", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const before = await f.store.getWorkItem(id);
    await f.revise(id, "");
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(id)).toEqual(before);
    const refused = await f.messages(id, "<!-- factory:refused:");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("it needs feedback after the command");
  });

  it("at the review loop limit: blocks with max_loops, and the comment does not say PR", async () => {
    const f = await localFactory({ max_loops: 1 });
    const id = await f.toMergePending();
    await f.revise(id, "one more change");
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops" });
    expect((await f.implementRuns(id)).filter((r) => r.status === "queued")).toEqual([]);
    const comment = (await f.messages(id, "<!-- factory:max-loops:")).join("\n");
    expect(comment).toContain("The feedback would start loop 1");
    // The comment's own text; the command footer after it is the table's.
    expect(comment.split("\n")[0]).not.toMatch(/\bPR\b/);
  });

  it("in any other phase, failed_review included, revise is refused as before", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const blocked = await f.put(id, { blocked_on: "human", blocked_reason: "run_failed:review:invalid_output" });
    await f.revise(id, "fix it");
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(id)).toEqual(blocked);
    const refused = await f.messages(id, "<!-- factory:refused:");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("the spec is not waiting for approval (the item is blocked by a failed review run)");
    expect(refused[0]).not.toContain("PR #");
  });
});
