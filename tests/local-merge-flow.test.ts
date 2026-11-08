import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubPermissionGrant } from "../src/impl/github/github-permission.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, renderItem } from "../src/ui/pages.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { Forge } from "../src/interfaces/forge.js";
import { FakeGitHubClient, FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";
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

async function localFactory() {
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
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: ["sh", "-c", "exit 0"] },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  // Recording fakes: a GitHub client behind the (remote) GitHub permission grant, and a forge. Neither may be called.
  const github = new FakeGitHubClient();
  const forgeCalls: string[] = [];
  const forge = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => (forgeCalls.push(String(k)), Promise.reject(new Error("forge")))) }) as Forge;
  const grants = [new StaticGrant({ roles: {}, deny: {} }), new GitHubPermissionGrant(github, { owner: "o", name: "r" })];
  const auth = new LocalAuthProvider(store, grants);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new Controller({
    store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      commitIn(spec.sandbox.workdir, { [WORKFLOW]: "name: scope\non: push\n" }, "add the scope gate");
      return { output: { summary: "added the scope gate", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
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
  return { repo, origin, owner, remoteRefs, store, runner, github, forgeCalls, step, cli, messages, toMergePending, appMerge };
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
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: null });
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

    // No push, no forge: the remote and the owner's checkout are as they were; the fakes saw no call.
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.owner()).toEqual(ownerBefore);
    expect(f.github.calls).toEqual([]);
    expect(f.forgeCalls).toEqual([]);
    expect(await f.store.getBasePush(id)).toBeNull();
  });

  it("factory merge is refused for an item not waiting for a merge, and for a requester (naming factory users add)", async () => {
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
    expect((await f.cli(ME, { action: "users_add", user: DEV, role: "requester" })).code).toBe(0);
    await f.cli(DEV, { action: "command", command: "merge", id, text: "" });
    await f.step();
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toContain(`factory users add ${DEV} --role approver`);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(f.github.calls).toEqual([]);
  });

  it("a conflict leaves the item in merge_pending and the reply names the conflicting files", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    // The owner changed the same file on main meanwhile, from a worktree of their own.
    const side = join(f.repo, "..", "side");
    git(f.repo, "worktree", "add", "--quiet", side, "main");
    commitIn(side, { [WORKFLOW]: "name: other\n" }, "another workflow");
    const mainBefore = git(f.repo, "rev-parse", "main");

    await f.cli(ME, { action: "command", command: "merge", id, text: "" });
    await f.step();
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("does not merge cleanly");
    expect(reply).toContain(`- \`${WORKFLOW}\``);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
  });

  it("the base checked out with uncommitted changes: the merge applies, that checkout's HEAD, index and status stay, and the page says so", async () => {
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
    const page = (await renderItem(uiDeps(f.store), id))!;
    expect(page).toContain("not updated");
    expect(page).toContain(esc(realpathSync(side)));
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

  it("a merge from the status page goes through the same local merge: a conflict is refused on the request, then a clean merge closes the item", async () => {
    const f = await localFactory();
    const id = await f.toMergePending();
    const head = git(f.repo, "rev-parse", `refs/heads/factory/${id}`);
    const side = join(f.repo, "..", "side");
    git(f.repo, "worktree", "add", "--quiet", side, "main");
    commitIn(side, { [WORKFLOW]: "name: other\n" }, "another workflow");
    git(f.repo, "worktree", "remove", side);
    const conflicted = git(f.repo, "rev-parse", "main");

    const refused = await f.appMerge(ME, id);
    await f.step();
    const row = (await f.store.getAppCommandRequest(refused))!;
    expect(row.handled_at).not.toBeNull();
    expect(row.refusal).toContain("does not merge cleanly");
    expect(row.refusal).toContain(`- \`${WORKFLOW}\``);
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toContain("does not merge cleanly");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(conflicted);

    // A requester's merge from the page is refused on its request, naming the approver role.
    expect((await f.cli(ME, { action: "users_add", user: DEV, role: "requester" })).code).toBe(0);
    const denied = await f.appMerge(DEV, id);
    await f.step();
    expect((await f.store.getAppCommandRequest(denied))!.refusal).toContain(`factory users add ${DEV} --role approver`);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });

    // The owner drops the conflicting commit; the next merge from the page is clean.
    git(f.repo, "update-ref", "refs/heads/main", `${conflicted}~1`);
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

    expect(f.github.calls).toEqual([]);
    expect(f.forgeCalls).toEqual([]);
  });
});

/** The status page's dependencies, enough for the item page. */
function uiDeps(store: UiDeps["store"]): UiDeps {
  return {
    store, scanner: cleanScanner, clock: new FakeClock(), lease_ms: 60_000,
    health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], new FakeClock()),
  };
}
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
