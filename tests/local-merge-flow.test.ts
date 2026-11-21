import { OwnerAuth } from "../src/core/authorize.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiDeps } from "../src/ui/deps.js";
import { api } from "../src/ui/api.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { autoResolveKey } from "../src/core/policy.js";
import { requestTransition } from "../src/core/request-transition.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// A local task from create to merge with no GitHub plugin (design 05-sources, Local startup): the local source,
// local auth, the local broker and the local sandbox over a real git repo. The branch stays local, the review
// reads the local branch, and `factory merge <id>` merges it into the local base branch with no push.

const ME = "local:me@example.com" as UserId;
const DEV = "local:dev@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, ...ident, "commit", "--quiet", "-m", msg);
};
const WORKFLOW = ".github/workflows/scope.yml";
/** A gate command that appends `name` and the HEAD it ran on to `<root>/gates.log`. */
const gateCommand = (root: string, name: string) => ["sh", "-c", `echo "${name} $(git rev-parse HEAD)" >> "${join(root, "gates.log")}"`];

/**
 * `resolve`: the resolve agent's script (default: it keeps the branch's side of the workflow file, uncommitted, as
 * the worker commits the checked tree). The install and test commands append the HEAD they ran on to `gates.log`.
 */
async function localFactory(opts: { resolve?: ConstructorParameters<typeof FakeRunner>[0]["resolve"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-local-merge-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  // The owner's repo has a remote; with no GitHub plugin nothing reads or writes it.
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  // The owner works on another branch with uncommitted changes: the merge must leave all of it as it is.
  git(repo, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(repo, "README.md"), "hi, edited\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const owner = () => ({ head: git(repo, "rev-parse", "HEAD"), ref: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain") });
  const remoteRefs = () => git(origin, "for-each-ref");

  const project = localProject({ owner: "o", name: "r" });
  const cfg: FactoryConfig = {
    ...config,
    project,
    local_only: true,
    repo: { ...config.repo, path: repo, install_command: gateCommand(root, "install"), test_command: gateCommand(root, "test") },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const auth = new OwnerAuth(store);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      commitIn(spec.sandbox.workdir, { [WORKFLOW]: "name: scope\non: push\n" }, "add the scope gate");
      return { output: { summary: "added the scope gate", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
    resolve: opts.resolve ?? ((spec) => {
      writeFileSync(join(spec.sandbox.workdir, WORKFLOW), "name: scope\non: push\n");
      return { output: { summary: "kept the branch's workflow", next_steps: "none" } };
    }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts,
    log: silent, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) =>
    runLocalCli({ store, identity: { user, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const messages = async (id: WorkItemId, prefix: string) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  /** A local task through triage, approval, implement and review, waiting for its merge. */
  const toMergePending = async () => {
    const id = (await cli(ME, { action: "create", title: "Add a scope gate", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli(ME, { action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    return id;
  };
  /** A merge from the status page: an app command request by `user`, as POST /api/v1/items/:id/commands writes it. */
  const appMerge = async (user: UserId, id: WorkItemId) =>
    (await store.recordAppCommandRequest({ key: `app:${++n}`, actor: user, command: "merge", args: { work_item_id: id } })).request.seq;
  /** The HEADs the install and test commands ran on, oldest first. */
  const gates = () => (existsSync(join(root, "gates.log")) ? readFileSync(join(root, "gates.log"), "utf8").trim().split("\n") : []);
  /** A commit on the local main that changes the workflow file the item's branch adds: the branch no longer merges. */
  const conflictOnMain = () => {
    const side = join(root, "side");
    git(repo, "worktree", "add", "--quiet", side, "main");
    commitIn(side, { [WORKFLOW]: "name: other\n" }, "another workflow");
    git(repo, "worktree", "remove", side);
    return git(repo, "rev-parse", "main");
  };
  const resolves = async (id: WorkItemId) => (await store.listRuns(id)).filter((r) => r.kind === "resolve");
  return { repo, origin, owner, remoteRefs, store, runner, step, cli, messages, toMergePending, appMerge, controller, clock, gates, conflictOnMain, resolves };
}

describe("a local task from create to merge, no GitHub plugin", { timeout: 60_000 }, () => {
  it("create → triage → approve → implement → review → factory merge → CLOSED, completed, with a merge sha", async () => {
    const f = await localFactory();
    const ownerBefore = f.owner();
    const remoteBefore = f.remoteRefs();
    const mainBefore = git(f.repo, "rev-parse", "main");

    const id = await f.toMergePending();
    const branch = `factory/${id}`;
    // No PR: the item reviews and waits as its local branch.
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
    const head = git(f.repo, "rev-parse", `refs/heads/${branch}`);
    expect(git(f.repo, "show", `${head}:${WORKFLOW}`)).toBe("name: scope\non: push");
    // The review read the local branch's diff.
    const review = f.runner.specs.find((s) => s.role === "review")!;
    expect(review.prompt).toContain(`+++ b/${WORKFLOW}`);
    expect(review.prompt).toContain("+name: scope");
    const ready = (await f.messages(id, "<!-- factory:merge:")).join("\n");
    expect(ready).toContain(`factory merge ${id}`);

    expect((await f.cli(ME, { action: "command", command: "merge", id, text: "" })).code).toBe(0);
    await f.step();
    const done = (await f.store.getWorkItem(id))!;
    const main = git(f.repo, "rev-parse", "main");
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, head]);
    expect(git(f.repo, "show", `main:${WORKFLOW}`)).toBe("name: scope\non: push");
    const merged = (await f.store.listStateChanges(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.actor).toEqual({ kind: "user", id: ME });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain(main.slice(0, 12));

    const reasons = (await f.store.listStateChanges(id)).map((c) => c.reason);
    const order = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "local_merged"];
    const at = order.map((r) => reasons.indexOf(r));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    // No push: the remote and the owner's checkout are as they were.
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.owner()).toEqual(ownerBefore);
    expect(await f.store.getBasePush(id)).toBeNull();
  });

  it("a task built with `factory task build` is closed as done by its item's local merge; an unlinked task stays open", async () => {
    const f = await localFactory();
    await f.cli(ME, { action: "add", task: { title: "Add a scope gate", list: null, priority: null, due: null, due_time: null, recurrence: null } });
    await f.cli(ME, { action: "add", task: { title: "other", list: null, priority: null, due: null, due_time: null, recurrence: null } });
    const [built, other] = await f.store.listTasks(10);
    const r = await f.cli(ME, { action: "build", id: built!.id });
    const id = (await f.store.getTask(built!.id))!.work_item_id!;
    expect(r.lines).toEqual([`built ${built!.id} as ${id}`]);
    await f.step();
    await f.cli(ME, { action: "command", command: "approve", id, text: "" });
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending" });
    expect((await f.store.getTask(built!.id))!.done_at).toBeNull();

    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await f.store.getTask(built!.id))!.done_at).toBe(f.clock.now().toISOString());
    expect(await f.store.getTask(other!.id)).toMatchObject({ done_at: null, work_item_id: null });
  });

  it("factory merge is refused for an item not waiting for a merge, and for anyone but the owner", async () => {
    const f = await localFactory();
    const id = (await f.cli(ME, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toContain("is not waiting for a merge");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });

    await f.cli(ME, { action: "command", command: "approve", id, text: "" });
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending" });
    const mainBefore = git(f.repo, "rev-parse", "main");
    await f.cli(DEV, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toBe("`factory merge` was not applied: only the owner may send this command.");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
  });

  it("factory merge on a conflict names the files and starts the automatic resolve: local base merged into the local branch, gates run, committed, nothing pushed, reviewed, merge_pending", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const branch = `factory/${id}`;
    const tip = git(f.repo, "rev-parse", branch);
    const main = f.conflictOnMain();
    const remoteBefore = f.remoteRefs();

    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("does not merge cleanly");
    expect(reply).toContain(`- \`${WORKFLOW}\``);
    expect(reply).toContain("automatic resolve run");

    // One automatic resolve run for the local base's commit; it did not stop on `no_pr`.
    const [run] = await f.resolves(id);
    expect([run!.idempotency_key, run!.status]).toEqual([autoResolveKey(id, main, 1), "succeeded"]);
    // The local base is merged into the local branch, committed there; the base and the remote did not move.
    const head = git(f.repo, "rev-parse", branch);
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([tip, main]);
    expect(git(f.repo, "show", `${head}:${WORKFLOW}`)).toBe("name: scope\non: push");
    expect(git(f.repo, "rev-parse", "main")).toBe(main);
    expect(f.remoteRefs()).toBe(remoteBefore);
    // The install command and the checks ran on that merge commit.
    expect(f.gates()).toEqual(expect.arrayContaining([`install ${head}`, `test ${head}`]));
    expect(f.runner.specs.find((s) => s.role === "resolve")!.prompt).toContain(`work item ${id}, local branch`);

    // As on the PR path: resolved, a review after the resolve, then merge_pending; the comment is on the item's thread.
    const changes = await f.store.listStateChanges(id);
    const from = changes.findIndex((c) => c.reason === "auto_resolve_started");
    expect(changes[from]!.detail).toMatchObject({ cause: "merge_refused", base_sha: main, attempt: 1 });
    expect(changes.slice(from).map((c) => c.reason)).toEqual(expect.arrayContaining(["auto_resolve_started", "resolved", "review_passed"]));
    expect(changes.slice(from).map((c) => c.reason).indexOf("resolved")).toBeLessThan(changes.slice(from).map((c) => c.reason).indexOf("review_passed"));
    const reviews = (await f.store.listRuns(id)).filter((r) => r.kind === "review");
    expect(reviews.at(-1)!.idempotency_key).toBe(`${id}:review:after-resolve:${run!.id}`);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
    const resolved = (await f.messages(id, "<!-- factory:auto-resolved:")).join("");
    expect(resolved).toContain(`the local branch \`${branch}\``);
    expect(resolved).toContain("1 resolved automatically, 0 needed a person");

    // The resolved branch now merges.
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: git(f.repo, "rev-parse", "main") });
  });

  it("the merge check finds the conflict when the local base moves and starts the same resolve run", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    await f.controller.tickMergeCheck();
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending" });
    const main = f.conflictOnMain();
    const messages = (await f.store.listItemMessages(id)).length;

    // The base is read again after poll_interval_ms.
    f.clock.advance(config.poll_interval_ms);
    await f.controller.tickMergeCheck();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect((await f.resolves(id)).map((r) => r.idempotency_key)).toEqual([autoResolveKey(id, main, 1)]);
    expect((await f.store.listItemMessages(id)).length).toBe(messages);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", `factory/${id}`).split(" ")).toContain(main);
  });

  it("two failed automatic resolves stop at merge_conflict_pending with a comment on the thread; factory resolve then starts one under a new key", async () => {
    let fail = true;
    const f = await localFactory({
      resolve: (spec) => {
        if (fail) throw new Error("the agent gave up");
        writeFileSync(join(spec.sandbox.workdir, WORKFLOW), "name: scope\non: push\n");
        return { output: { summary: "resolved", next_steps: "none" } };
      },
    });
    const id = await f.toMergePending();
    const tip = git(f.repo, "rev-parse", `factory/${id}`);
    const main = f.conflictOnMain();
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();

    expect((await f.resolves(id)).map((r) => [r.idempotency_key, r.status])).toEqual([
      [autoResolveKey(id, main, 1), "failed"], [autoResolveKey(id, main, 2), "failed"],
    ]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect(git(f.repo, "rev-parse", `factory/${id}`)).toBe(tip);
    const final = await f.messages(id, "<!-- factory:run-failed:");
    expect(final).toHaveLength(1);
    expect(final[0]).toContain("attempt 2 of 2");
    expect(final[0]).toContain(`the local branch \`factory/${id}\` is unchanged`);
    expect(final[0]).toContain("0 resolved automatically, 1 needed a person");

    fail = false;
    await f.cli(ME, { action: "command", command: "resolve", id, text: "keep the branch's workflow" });
    await f.step();
    const runs = await f.resolves(id);
    expect(runs.map((r) => r.idempotency_key)).toContain(`${id}:resolve:l0:r1`);
    expect(runs.at(-1)!.input).toEqual({ notes: "keep the branch's workflow" });
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });

  it("factory merge on an item parked at merge_conflict_pending: still conflicting is refused with the files and factory resolve, the owner only, then a hand fix gets a fresh review of its head and no resolve run", async () => {
    const f = await localFactory({ resolve: () => { throw new Error("the agent gave up"); } });
    const id = await f.toMergePending();
    const branch = `factory/${id}`;
    const main = f.conflictOnMain();
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const parked = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" };
    expect(await f.store.getWorkItem(id)).toMatchObject(parked);
    const resolvesBefore = (await f.resolves(id)).map((r) => r.idempotency_key);
    const changes = async () => (await f.store.listStateChanges(id)).length;

    // Still conflicting: refused with the files and `factory resolve`; nothing moves, no resolve run starts.
    const before = await changes();
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("does not merge cleanly");
    expect(reply).toContain(`- \`${WORKFLOW}\``);
    expect(reply).toContain(`factory resolve ${id}`);
    expect(reply).not.toContain("is not waiting for a merge");
    expect(await f.store.getWorkItem(id)).toMatchObject(parked);
    expect(await changes()).toBe(before);
    expect((await f.resolves(id)).map((r) => r.idempotency_key)).toEqual(resolvesBefore);

    // The owner merges the local base into the branch by hand.
    const side = join(f.repo, "..", "hand");
    git(f.repo, "worktree", "add", "--quiet", side, branch);
    try { git(side, ...ident, "merge", "--quiet", "main"); } catch { /* the conflict, resolved below */ }
    writeFileSync(join(side, WORKFLOW), "name: scope\non: push\n");
    git(side, "add", WORKFLOW);
    git(side, ...ident, "commit", "--quiet", "--no-edit");
    git(f.repo, "worktree", "remove", side);
    const head = git(f.repo, "rev-parse", branch);

    // Anyone but the owner is still refused, and nothing moves.
    await f.cli(DEV, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toBe("`factory merge` was not applied: only the owner may send this command.");
    expect(await f.store.getWorkItem(id)).toMatchObject(parked);

    // The clean hand fix: no resolve run, one fresh review keyed on the branch head, then merge_pending.
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.resolves(id)).map((r) => r.idempotency_key)).toEqual(resolvesBefore);
    const fixed = (await f.store.listStateChanges(id)).find((c) => c.reason === "conflict_fixed_by_hand")!;
    expect(fixed).toMatchObject({ actor: { kind: "user", id: ME }, detail: { head_sha: head } });
    const reviews = (await f.store.listRuns(id)).filter((r) => r.idempotency_key === `${id}:review:hand-fixed:${head}`);
    expect(reviews.map((r) => r.status)).toEqual(["succeeded"]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null });
    expect((await f.messages(id, "<!-- factory:hand-fixed:")).join("")).toContain(`factory merge ${id}`);

    // Then `factory merge` lands the hand-fixed branch.
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const landed = git(f.repo, "rev-parse", "main");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: landed });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", landed).split(" ").slice(1)).toEqual([main, head]);
  });

  it("factory merge on an item held for recurring_failure after its resolve runs failed: a hand fix gets a fresh review, the request gate passes it, and a hold with no failed resolve is refused", async () => {
    const f = await localFactory({ resolve: () => { throw new Error("the agent stalled"); } });
    const system = { kind: "system", id: "test" } as const;
    const hold = async (id: WorkItemId) => {
      const it = (await f.store.getWorkItem(id))!;
      await f.store.transition({ id, expected_version: it.version, actor: system, reason: "recurring_failure", patch: { blocked_on: "human", blocked_reason: "recurring_failure" }, detail: { pattern_key: "k" } });
    };
    const gate = async (id: WorkItemId) => {
      const r = (await f.store.getAppCommandRequest(await f.appMerge(ME, id)))!;
      return requestTransition({
        store: f.store, scanner: cleanScanner, allowed: async () => ({ allow: true }), answers: {} as never, changeName: String, localMerge: true,
      }, r, (await f.store.getWorkItem(id))!);
    };

    // A hold on an item with no failed resolve run: `factory merge` is refused, nothing moves.
    const other = await f.toMergePending();
    await hold(other);
    expect((await gate(other)).outcome).toBe("refused");
    await f.cli(ME, { action: "command", command: "merge", id: other, text: "" });
    await f.step();
    expect((await f.messages(other, "<!-- factory:refused:")).at(-1)).toContain("is not waiting for a merge");
    expect(await f.store.getWorkItem(other)).toMatchObject({ blocked_reason: "recurring_failure" });

    const id = await f.toMergePending();
    const branch = `factory/${id}`;
    f.conflictOnMain();
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.resolves(id)).at(-1)!.status).toBe("failed");
    await hold(id);
    const held = { stage: "REVIEW", blocked_on: "human", blocked_reason: "recurring_failure" };
    expect(await f.store.getWorkItem(id)).toMatchObject(held);
    const resolvesBefore = (await f.resolves(id)).map((r) => r.idempotency_key);

    // Still conflicting: refused with the files, as a parked item is; the hold stays.
    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("does not merge cleanly");
    expect(reply).not.toContain("is not waiting for a merge");
    expect(await f.store.getWorkItem(id)).toMatchObject(held);

    // The hand fix: the dashboard's request gate passes it, and `factory merge` sends it to its fresh review.
    const side = join(f.repo, "..", "hand");
    git(f.repo, "worktree", "add", "--quiet", side, branch);
    try { git(side, ...ident, "merge", "--quiet", "main"); } catch { /* the conflict, resolved below */ }
    writeFileSync(join(side, WORKFLOW), "name: scope\non: push\n");
    git(side, "add", WORKFLOW);
    git(side, ...ident, "commit", "--quiet", "--no-edit");
    git(f.repo, "worktree", "remove", side);
    const head = git(f.repo, "rev-parse", branch);
    expect((await gate(id)).outcome).toBe("queued");
    await f.step();
    expect((await f.resolves(id)).map((r) => r.idempotency_key)).toEqual(resolvesBefore);
    expect((await f.store.listStateChanges(id)).find((c) => c.reason === "conflict_fixed_by_hand")).toMatchObject({ detail: { head_sha: head } });
    const reviews = (await f.store.listRuns(id)).filter((r) => r.idempotency_key === `${id}:review:hand-fixed:${head}`);
    expect(reviews.map((r) => r.status)).toEqual(["succeeded"]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
  });

  it("factory resolve on a local item waiting for a merge whose branch conflicts starts a resolve run", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    f.conflictOnMain();
    await f.cli(ME, { action: "command", command: "resolve", id, text: "" });
    await f.step();
    expect((await f.resolves(id)).map((r) => [r.idempotency_key, r.status])).toEqual([[`${id}:resolve:l0:r1`, "succeeded"]]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });

  it("the base checked out with uncommitted changes: the merge applies, that checkout's HEAD, index and status stay, and the item API says so", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const side = join(f.repo, "..", "side");
    git(f.repo, "worktree", "add", "--quiet", side, "main");
    writeFileSync(join(side, "README.md"), "hi, staged\n");
    git(side, "add", "README.md");
    writeFileSync(join(side, "README.md"), "hi, staged, then edited\n");
    const look = () => ({ head: git(side, "rev-parse", "HEAD"), index: git(side, "ls-files", "-s"), status: git(side, "status", "--porcelain") });
    const before = look();

    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const done = (await f.store.getWorkItem(id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: git(f.repo, "rev-parse", "main") });
    expect(look()).toEqual(before);
    const merged = (await f.store.listStateChanges(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.detail).toMatchObject({ checkout_not_updated: realpathSync(side) });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain("that checkout was not updated");
    const r = await api(uiDeps(f.store), new URL(`http://127.0.0.1/api/v1/items/${id}`));
    const timeline = (r.value as { timeline: { reason: string; detail: Record<string, string | null> | null }[] }).timeline;
    expect(timeline.find((c) => c.reason === "local_merged")?.detail).toMatchObject({ checkout_not_updated: realpathSync(side) });
  });

  it("the base checked out clean: that checkout is fast-forwarded to the merge (HEAD, index and files), status still clean", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const side = join(f.repo, "..", "side");
    git(f.repo, "worktree", "add", "--quiet", side, "main");

    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const main = git(f.repo, "rev-parse", "main");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", merge_sha: main });
    expect(git(side, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(side, "rev-parse", "HEAD")).toBe(main);
    expect(git(side, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(side, WORKFLOW), "utf8")).toBe("name: scope\non: push\n");
    const merged = (await f.store.listStateChanges(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.detail).not.toHaveProperty("checkout_not_updated");
  });

  it("a merge from the status page goes through the same local merge: a conflict is refused on the request and resolved, then a merge closes the item", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const conflicted = f.conflictOnMain();

    const refused = await f.appMerge(ME, id);
    await f.step();
    const row = (await f.store.getAppCommandRequest(refused))!;
    expect(row.handled_at).not.toBeNull();
    expect(row.refusal).toContain("does not merge cleanly");
    expect(row.refusal).toContain(`- \`${WORKFLOW}\``);
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toContain("does not merge cleanly");
    // The automatic resolve ran and the review after it passed: the item waits for a merge again.
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(conflicted);
    const head = git(f.repo, "rev-parse", `refs/heads/factory/${id}`);

    // A non-owner's merge from the page is refused on its request with the owner reply.
    const denied = await f.appMerge(DEV, id);
    await f.step();
    expect((await f.store.getAppCommandRequest(denied))!.refusal).toContain("only the owner may send this command");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });

    // The resolved branch merges from the page.
    const mainBefore = git(f.repo, "rev-parse", "main");
    const ok = await f.appMerge(ME, id);
    await f.step();
    expect(await f.store.getAppCommandRequest(ok)).toMatchObject({ refusal: null });
    expect((await f.store.getAppCommandRequest(ok))!.handled_at).not.toBeNull();
    const main = git(f.repo, "rev-parse", "main");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, head]);
    const merged = (await f.store.listStateChanges(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.actor).toEqual({ kind: "user", id: ME });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain(main.slice(0, 12));
  });
});

/** The dashboard API's dependencies, enough for an item's detail. */
function uiDeps(store: UiDeps["store"]): UiDeps {
  return {
    store, scanner: cleanScanner, clock: new FakeClock(), lease_ms: 60_000,
    health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], new FakeClock()),
  };
}
