import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import { Sessions } from "../src/core/session.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { GitHubAuthProvider } from "../src/impl/github/github-auth-provider.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { GrantSource, Role } from "../src/interfaces/auth-provider.js";
import {
  FakeAuth, FakeBroker, FakeIssues, FakeRunner, FakeSandbox, FakeForge, FakeSource, MemorySessionFiles, MemoryStorage, alice, cleanScanner, config, issueRef,
  mallory, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// A local task end to end (issue #200): filed and approved from the CLI, read by the `local` source, applied by
// the controller, built, reviewed, merged. Since issue #318 local commands are authorized by the `local` auth
// plugin (local users in the store), GitHub comments by the GitHub one: here GitHubAuthProvider over a static grant
// and a remote grant standing in for GitHub, which can be made unreachable. Since issue #333 a local item takes
// the local broker and sandbox by its source type, with or without a GitHub plugin selected, and `factory merge`
// merges it into the local base branch: the flows below run over a real git repo.

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

/** `sync: false`: no sync plugin is selected (the `local` source only); the fake forge still stands in for the merge. */
async function factory(opts: { sync?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const forge = new FakeForge(opts.sync === false ? null : gh);
  const local = new LocalSource(store);
  const github = new GitHubGrant();
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} }), github];
  const auth = new GitHubAuthProvider(store, grants);
  const local_auth = new LocalAuthProvider(store, grants);
  const controller = new Controller({
    store, sources: opts.sync === false ? [local] : [gh, local], forge, auth, local_auth, clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
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
  return { clock, store, gh, forge, github, controller, broker, step, cli, refusals };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", msg);
};
const ADDED = ".github/workflows/scope.yml";

/**
 * Over a real git repo with an origin remote. `github: true`: the GitHub plugins are selected (a GitHub source and
 * forge, a recording fake as the GitHub broker, an origin-fetching sandbox) and the local route sits beside them,
 * as compose builds it. `github: false`: only local plugins, the local broker and the local sandbox. Every check
 * command logs the folder it ran in, and fails while the `fail` marker file exists.
 */
async function gitFactory(o: { github: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "sf-local-flow-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "fetch", "--quiet", "origin");
  // The owner's live checkout: another branch, with uncommitted and untracked changes the merge must leave alone.
  git(repo, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(repo, "README.md"), "hi, edited\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const owner = () => ({ head: git(repo, "rev-parse", "HEAD"), ref: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain") });
  const pushes = () => git(origin, "for-each-ref");
  const cwds = join(root, "check-cwds.txt");
  const fail = join(root, "fail");
  const check = ["sh", "-c", `pwd >> '${cwds}'; test ! -e '${fail}'`];

  const project = localProject({ owner: "o", name: "r" });
  const cfg: FactoryConfig = {
    ...config,
    ...(o.github ? {} : { project, local_only: true as const }),
    repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: check },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const github = new GitHubGrant();
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} }), github];
  const local_auth = new LocalAuthProvider(store, grants);
  const auth = o.github ? new GitHubAuthProvider(store, grants) : local_auth;
  const wt = join(root, "wt");
  const localRoute = {
    broker: new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo }),
    sandbox: new NoOpSandbox(wt, undefined, undefined, { local: true }),
  };
  // The GitHub broker: a recording fake whose calls are the GitHub calls. With GitHub selected, the selected sandbox fetches origin.
  const ghBroker = new FakeBroker();
  const sandbox = o.github ? new NoOpSandbox(wt) : localRoute.sandbox;
  const controller = new Controller({
    store, sources: o.github ? [gh, new LocalSource(store)] : [new LocalSource(store)], ...(o.github ? { forge } : {}), auth, local_auth, clock, config: cfg,
    log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (spec) => {
      commitIn(spec.sandbox.workdir, { [ADDED]: "name: scope\n" }, "add the scope check");
      return { output: { summary: "added the scope check", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const toolEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" };
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: o.github ? ghBroker : localRoute.broker, local: localRoute, storage: new MemoryStorage(), clock,
    config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) =>
    runLocalCli({ store, identity: { user, from: "git user.email" }, project: async () => cfg.project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const toMergePending = async () => {
    const id = (await cli(ME, { action: "create", title: "Add a scope check", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect((await cli(ME, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: null });
    return id;
  };
  const merge = async (id: WorkItemId) => {
    expect((await cli(ME, { action: "command", command: "merge", id, text: "" })).code).toBe(0);
    await step();
  };
  /** Every GitHub call the fakes saw for local items: broker calls and preflights, permission reads, issue and PR writes. */
  const githubCalls = () =>
    ghBroker.calls.length + ghBroker.preflights.length + github.calls + gh.subIssueCalls
    + gh.comments.filter((c) => c.source.type === "local").length + forge.comments.length + forge.statusCalls.length;
  const messages = async (id: WorkItemId, prefix: string) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const checkedIn = () => (existsSync(cwds) ? readFileSync(cwds, "utf8").split("\n").filter(Boolean) : []);
  return { root, repo, fail, store, gh, ghBroker, owner, pushes, step, cli, toMergePending, merge, githubCalls, messages, checkedIn };
}

/** The flow's state changes are all there and in this order. */
async function expectReasons(store: Awaited<ReturnType<typeof newStore>>["store"], id: WorkItemId, order: string[]) {
  const reasons = (await store.listStateChanges(id)).map((c) => c.reason);
  const at = order.map((r) => reasons.indexOf(r));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
}

const LOCAL_FLOW = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "local_merged"];

describe("local task flow, over git", { timeout: 60_000 }, () => {
  for (const github of [false, true]) {
    it(`${github ? "GitHub selected" : "no GitHub plugin"}: create → triage → implement → review → factory merge into the local main, with no GitHub call and no push`, async () => {
      const f = await gitFactory({ github });
      const ownerBefore = f.owner();
      const pushesBefore = f.pushes();
      const mainBefore = git(f.repo, "rev-parse", "main");

      const id = await f.toMergePending();
      const head = git(f.repo, "rev-parse", `refs/heads/factory/${id}`);
      const checks = f.checkedIn().length;
      await f.merge(id);

      const main = git(f.repo, "rev-parse", "main");
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main, change_ref: null });
      expect(git(f.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, head]);
      expect(git(f.repo, "show", `main:${ADDED}`)).toBe("name: scope");
      await expectReasons(f.store, id, LOCAL_FLOW);
      // The merge ran the test command in a temporary worktree, now gone, never in the live checkout.
      const merged = f.checkedIn().slice(checks);
      expect(merged).toHaveLength(1);
      expect(merged[0]).not.toBe(f.repo);
      expect(existsSync(merged[0]!)).toBe(false);
      expect(git(f.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
      expect(f.owner()).toEqual(ownerBefore);
      // No GitHub call and no push, from create to merge.
      expect(f.githubCalls()).toBe(0);
      expect(f.pushes()).toBe(pushesBefore);
    });
  }

  it("a failing test command on the merged commit merges nothing: main is unchanged and the item still waits", async () => {
    const f = await gitFactory({ github: false });
    const pushesBefore = f.pushes();
    const id = await f.toMergePending();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const ownerBefore = f.owner();
    writeFileSync(f.fail, "");
    await f.merge(id);

    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", merge_sha: null });
    expect((await f.messages(id, "<!-- factory:refused:")).at(-1)).toContain("on the merged commit, so `main` did not move");
    expect(f.owner()).toEqual(ownerBefore);
    expect(f.pushes()).toBe(pushesBefore);
    expect(f.githubCalls()).toBe(0);
  });

  it("GitHub selected: a GitHub issue still pushes and opens its PR through the GitHub broker; the local route is not used", async () => {
    const f = await gitFactory({ github: true });
    f.gh.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(5).id))!;
    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "900", approver: { provider: "github", subject: "1" }, note: "" });
    await f.step();
    await f.step();
    const names = f.ghBroker.calls.map((c) => c.name);
    expect(names.indexOf("github.push_branch")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("github.open_pr")).toBeGreaterThan(names.indexOf("github.push_branch"));
    expect(f.ghBroker.preflights.length).toBeGreaterThan(0);
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "REVIEW", change_ref: "42" });
    // Nothing was committed to a local factory branch for it.
    expect(git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/factory/")).toBe("");
  });
});

describe("local task flow", () => {
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

describe("factory session on a local item, with the GitHub broker selected", () => {
  async function sessions(o: { local: boolean }) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const sandbox = new FakeSandbox();
    sandbox.changedFiles = ["src/a/x.ts"];
    const ghBroker = new FakeBroker();
    // The local broker's one tool: it commits the local branch and has no PR tool.
    const localBroker = new FakeBroker();
    localBroker.tools = localBroker.tools.filter((t) => t.name === "forge.push_branch");
    const s = new Sessions({
      store, sandbox, broker: ghBroker, scanner: cleanScanner, auth: new FakeAuth(), clock, config, log: silent, files: new MemorySessionFiles(),
      issues: new FakeIssues({}), toolEnv: {}, owner: "session:host:1", ...(o.local ? { local: { broker: localBroker, sandbox } } : {}),
    });
    const controller = new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const { item } = await store.createWorkItem({ ...issue(1), source: { type: "local", id: "local:1", link: "" } }, system);
    const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { stage: "RUNNING", allowed_paths: ["src/a/"], tier: 2, done_criteria: ["x"] } });
    expect(r.ok).toBe(true);
    return { store, s, ghBroker, localBroker, controller, id: item.id };
  }

  it("finish commits the local branch through the local broker, opens no PR, and the item goes to review with no change_ref", async () => {
    const h = await sessions({ local: true });
    expect((await h.s.start({ target: h.id, person: alice })).ok).toBe(true);
    const done = await h.s.finish({});
    expect(done.ok).toBe(true);
    expect(done.lines.at(-1)).toContain("no push, no PR");
    expect(h.localBroker.calls.map((c) => c.name)).toEqual(["github.push_branch"]);
    expect([h.ghBroker.calls, h.ghBroker.preflights]).toEqual([[], []]);
    await h.controller.tickRuns();
    expect(await h.store.getWorkItem(h.id)).toMatchObject({ stage: "REVIEW", change_ref: null });
  });

  it("with no local route given, a local item's session is refused before any broker call", async () => {
    const h = await sessions({ local: false });
    const r = await h.s.start({ target: h.id, person: alice });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("only through the local broker");
    expect([h.ghBroker.calls, h.ghBroker.preflights]).toEqual([[], []]);
  });
});
