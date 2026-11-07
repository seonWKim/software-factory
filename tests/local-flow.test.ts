import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { type CliAction, type LocalCliDeps, localIdentity, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { GitHubAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { GrantSource, Role } from "../src/interfaces/auth-provider.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, FakeForge, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, mallory, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// A local task end to end (issue #200): filed and approved from the CLI, read by the `local` source, applied by
// the controller, built, reviewed, merged. Since issue #318 local commands are authorized by the `local` auth
// plugin (local users in the store), GitHub comments by the GitHub one: here GitHubAuthProvider over a static grant
// and a remote grant standing in for GitHub, which can be made unreachable. Since issue #333 a local item uses the
// local broker and the local merge also while the GitHub plugin is selected: no push, no PR, no GitHub call.

const OWNER = "github:1" as UserId;
const ME = "local:me@example.com" as UserId;
const DEV = "local:dev@example.com" as UserId;
const ANON = "local:anonymous" as UserId;

/** The GitHub permission check: a remote grant that counts its calls and throws while GitHub is unreachable. */
class GitHubGrant implements GrantSource {
  readonly remote = true;
  calls = 0;
  reachable = true;
  async denies(): Promise<boolean> {
    return false;
  }
  async roles(): Promise<readonly Role[]> {
    this.calls++;
    if (!this.reachable) throw new Error("GitHub unreachable (rate limited)");
    return [];
  }
}

/** The GitHub source next to the local one, with fakes only: for the authorization tests, which stop before implement. */
async function factory() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const local = new LocalSource(store);
  const github = new GitHubGrant();
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} }), github];
  const auth = new GitHubAuthProvider(store, grants);
  const local_auth = new LocalAuthProvider(store, grants);
  const controller = new Controller({
    store, sources: [gh, local], forge, auth, local_auth, clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "the summary", next_steps: "the next steps" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new FakeBroker();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts,
    log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) => {
    const d: LocalCliDeps = {
      store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}`,
    };
    return runLocalCli(d, a);
  };
  const refusals = async (id: WorkItemId) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
  return { store, gh, github, step, cli, refusals };
}

/** Every call the fake GitHub saw from the broker, the source's writes and the forge's PR writes. */
function githubCalls(f: { ghBroker: FakeBroker; gh: FakeSource; forge: FakeForge; github: GitHubGrant }): number {
  const { ghBroker, gh, forge, github } = f;
  return ghBroker.calls.length + ghBroker.preflights.length + gh.comments.length + gh.reactions.length + gh.statusCalls.length
    + gh.subIssueCalls + gh.closed.length + forge.comments.length + forge.statusCalls.length + github.calls;
}

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
const GATE = ".github/workflows/gate.yml";

/**
 * A real factory repo (with a bare origin and the owner's dirty checkout on another branch), the local broker and the
 * local-mode sandbox. `github: false`: no GitHub plugin selected, so they are the selected broker and sandbox.
 * `github: true`: the GitHub source, forge and broker (fakes) are selected and the local ones are built beside them,
 * as compose does; GitHub items keep the fake GitHub broker and sandbox.
 */
async function gitFactory(opts: { github: boolean; test?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), "sf-local-flow-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(repo, "README.md"), "hi, edited\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const owner = () => ({ head: git(repo, "rev-parse", "HEAD"), ref: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain") });
  const remoteRefs = () => git(origin, "for-each-ref");

  const cfg: FactoryConfig = {
    ...config,
    ...(opts.github ? {} : { project: localProject({ owner: "o", name: "r" }), local_only: true as const }),
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: opts.test ?? ["sh", "-c", "exit 0"] },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const ghBroker = new FakeBroker();
  const github = new GitHubGrant();
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} }), github];
  const local_auth = new LocalAuthProvider(store, grants);
  const localBroker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const localSandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const controller = new Controller({
    store, sources: opts.github ? [gh, new LocalSource(store)] : [new LocalSource(store)], ...(opts.github ? { forge } : {}),
    auth: opts.github ? new GitHubAuthProvider(store, grants) : local_auth, local_auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    // The selected sandbox's merge path; with GitHub selected it fetches origin elsewhere, never in the local merge.
    sandbox: opts.github ? new NoOpSandbox(join(root, "wt")) : localSandbox, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      // The fake sandbox (GitHub items) has no folder; a local item's run folder is a real clone.
      if (existsSync(join(spec.sandbox.workdir, ".git"))) commitIn(spec.sandbox.workdir, { [GATE]: "the gate\n" }, "add the gate");
      return { output: { summary: "added the gate", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const worker = new Worker({
    id: "w1" as WorkerId, store, runner, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent, scanner: cleanScanner,
    toolEnv, awake: new NoKeepAwake(),
    ...(opts.github
      ? { broker: ghBroker, sandbox: new FakeSandbox(), local: { broker: localBroker, sandbox: localSandbox } }
      : { broker: localBroker, sandbox: localSandbox }),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) =>
    runLocalCli({ store, identity: { user, from: "git user.email" }, project: async () => cfg.project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const messages = async (id: WorkItemId, prefix: string) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  /** A local task through triage, approval, implement and review, waiting for its merge. */
  const toMergePending = async () => {
    const id = (await cli(ME, { action: "create", title: "Add the gate", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli(ME, { action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    return id;
  };
  return { root, repo, cfg, owner, remoteRefs, store, gh, forge, ghBroker, github, controller, step, cli, messages, toMergePending };
}

type GitFactory = Awaited<ReturnType<typeof gitFactory>>;

/** `factory merge <id>` by the local owner, applied by the next tick. */
async function merge(f: GitFactory, id: WorkItemId): Promise<void> {
  expect((await f.cli(ME, { action: "command", command: "merge", id, text: "" })).code).toBe(0);
  await f.step();
}

/** The local item went create → triage → approve → implement → review → `factory merge` into the local base. */
async function expectLocalMerge(f: GitFactory, id: WorkItemId, mainBefore: string): Promise<void> {
  const head = git(f.repo, "rev-parse", `refs/heads/factory/${id}`);
  const main = git(f.repo, "rev-parse", "main");
  expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main, pr_number: null });
  expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, head]);
  expect(git(f.repo, "show", `main:${GATE}`)).toBe("the gate");
  const reasons = (await f.store.listStateChanges(id)).map((c) => c.reason);
  const at = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "local_merged"].map((r) => reasons.indexOf(r));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(reasons).not.toContain("pr_merged");
}

describe("local task flow", { timeout: 60_000 }, () => {
  it("solo, no GitHub plugin: create → triage → approve → implement → review → factory merge into the local base; no GitHub call, no push", async () => {
    const f = await gitFactory({ github: false });
    const [ownerBefore, remoteBefore, mainBefore] = [f.owner(), f.remoteRefs(), git(f.repo, "rev-parse", "main")];
    const id = await f.toMergePending();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: null });
    await merge(f, id);
    await expectLocalMerge(f, id, mainBefore);
    expect(githubCalls(f)).toBe(0);
    expect(f.ghBroker.calls.filter((c) => c.name === "github.push_branch")).toEqual([]);
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.owner()).toEqual(ownerBefore);
  });

  it("with the GitHub plugin selected, a local item still uses the local broker and merge: zero GitHub calls from create to merge, no push", async () => {
    const f = await gitFactory({ github: true });
    f.github.reachable = false;
    const [ownerBefore, remoteBefore, mainBefore] = [f.owner(), f.remoteRefs(), git(f.repo, "rev-parse", "main")];
    const id = await f.toMergePending();
    // No PR: the branch is local and the review read it.
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: null });
    expect(git(f.repo, "show", `refs/heads/factory/${id}:${GATE}`)).toBe("the gate");
    expect((await f.messages(id, "<!-- factory:merge:")).join("\n")).toContain(`factory merge ${id}`);
    await merge(f, id);
    await expectLocalMerge(f, id, mainBefore);
    expect(githubCalls(f)).toBe(0);
    expect(f.ghBroker.calls.filter((c) => c.name === "github.push_branch")).toEqual([]);
    expect(f.remoteRefs()).toBe(remoteBefore);
    expect(f.owner()).toEqual(ownerBefore);
  });

  it("with the GitHub plugin selected, a GitHub issue item still pushes and opens its PR through the GitHub broker", async () => {
    const f = await gitFactory({ github: true });
    f.gh.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(5).id))!;
    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "900", approver: alice, note: "" });
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    const names = f.ghBroker.calls.filter((c) => c.ctx.work_item_id === item.id).map((c) => c.name);
    expect(names.indexOf("github.push_branch")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("github.open_pr")).toBeGreaterThan(names.indexOf("github.push_branch"));
    expect(f.ghBroker.preflights.some((c) => c.ctx.work_item_id === item.id)).toBe(true);
    // Nothing of it reached the factory repo's local branches.
    expect(git(f.repo, "for-each-ref", "--format=%(refname)", `refs/heads/factory/${item.id}`)).toBe("");
  });

  it("a local item whose repo.test_command fails on the merged result is not merged; the base branch is unchanged", async () => {
    // The worker's own gates run the same command in the run folder and pass; it fails from the merge on.
    const broken = join(mkdtempSync(join(tmpdir(), "sf-broken-")), "broken");
    const f = await gitFactory({ github: true, test: ["sh", "-c", `test ! -e ${broken} || { echo the gate breaks the tests; exit 3; }`] });
    const ownerBefore = f.owner();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.toMergePending();
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_reason: "merge_pending" });
    writeFileSync(broken, "");
    await merge(f, id);
    const reply = (await f.messages(id, "<!-- factory:refused:")).at(-1)!;
    expect(reply).toContain("exited 3");
    expect(reply).toContain("the gate breaks the tests");
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(f.owner()).toEqual(ownerBefore);
    expect(githubCalls(f)).toBe(0);
  });

  it("two controllers merging the same local item at once: one merge into the base, one close, one reply", async () => {
    const f = await gitFactory({ github: false });
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.toMergePending();
    const other = new Controller({
      store: f.store, sources: [new LocalSource(f.store)], auth: new LocalAuthProvider(f.store, []), local_auth: new LocalAuthProvider(f.store, []),
      clock: new FakeClock(), config: f.cfg, log: silent, scanner: cleanScanner, sandbox: new NoOpSandbox(join(f.root, "wt2"), undefined, undefined, { local: true }),
      repeated_failure_rule: false,
    });
    const who = localIdentity(ME);
    await Promise.all([f.controller.mergeLocal(id, who, "k1"), other.mergeLocal(id, who, "k2")]);
    await expectLocalMerge(f, id, mainBefore);
    expect(git(f.repo, "rev-list", "--count", `${mainBefore}..main`)).toBe(String(Number(git(f.repo, "rev-list", "--count", `${mainBefore}..factory/${id}`)) + 1));
    expect((await f.store.listStateChanges(id)).filter((c) => c.reason === "local_merged")).toHaveLength(1);
    expect(await f.messages(id, "<!-- factory:local-merged:")).toHaveLength(1);
    expect(await f.messages(id, "<!-- factory:refused:")).toEqual([]);
  });

  it("a GitHub comment is still authorized by the GitHub auth plugin", async () => {
    const f = await factory();
    await f.cli(ME, { action: "create", title: "t", bodyFile: "b" }); // a local owner exists; it is not a GitHub approver
    f.gh.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(5).id))!;
    expect(item).toMatchObject({ blocked_reason: "spec_pending" });

    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "900", approver: mallory, note: "" });
    await f.step();
    expect(f.gh.comments.find((c) => c.marker === "<!-- factory:refused:900 -->")!.body).toContain("needs write permission");
    expect(f.github.calls).toBeGreaterThan(0);
    // A local identity sent as a GitHub account is a GitHub account: the local owner row does not count there.
    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "901", approver: { provider: "github", subject: "1" }, note: "" });
    await f.step();
    expect((await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!.actor).toEqual({ kind: "user", id: OWNER });
  });

  it("enterprise: a local user without a role is refused; once the owner grants approver, the same command is applied", async () => {
    const f = await factory();
    const id = (await f.cli(ME, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    expect((await f.cli(DEV, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await f.step();
    const [refusal] = await f.refusals(id);
    expect(refusal).toContain(`factory users add ${DEV} --role approver`);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });

    expect((await f.cli(DEV, { action: "users_add", user: DEV, role: "approver" })).code).toBe(1);
    expect((await f.cli(ME, { action: "users_add", user: DEV, role: "approver" })).code).toBe(0);
    expect((await f.cli(DEV, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await f.step();
    const approval = (await f.store.listStateChanges(id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: DEV });
  });

  it("anonymous may file a task but its approve is refused, and it never becomes the owner", async () => {
    const f = await factory();
    const id = (await f.cli(ANON, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    await f.cli(ANON, { action: "command", command: "approve", id, text: "" });
    await f.step();
    expect(await f.refusals(id)).toHaveLength(1);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(await f.store.listLocalUsers()).toEqual([]);
  });
});
