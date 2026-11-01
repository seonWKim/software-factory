import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { EMPTY_HOOKS_DIR, NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { Secret } from "../src/interfaces/secret-store.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Issue #78: a run's working copy must not share the owner's git folder, and the worker's and broker's own git
// calls in a run folder must not run anything the agent configured there.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const real = (p: string) => realpathSync(p);
const under = (p: string, dir: string) => !relative(real(dir), p).startsWith("..");

function commit(dir: string, path: string, content: string, msg: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, "add", "--", path);
  git(dir, "-c", "user.name=bot", "-c", "user.email=bot@example.com", "commit", "--quiet", "-m", msg);
}

/** A bare origin and the factory repo cloned from it, with main pushed; plus a decoy bare repo. */
function factoryRepo() {
  const root = mkdtempSync(join(tmpdir(), "sf-iso-"));
  const origin = join(root, "origin.git");
  const decoy = join(root, "decoy.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "--bare", "-b", "main", decoy);
  git(root, "clone", "--quiet", origin, repo);
  commit(repo, "README.md", "hi\n", "init");
  commit(repo, "src/a.txt", "a\n", "a");
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "fetch", "--quiet", "origin");
  return { root, origin, decoy, repo, worktrees: join(repo, ".worktrees") };
}

/** The factory repo's git state an agent must never change. */
function factoryState(repo: string) {
  return {
    branches: git(repo, "branch", "--list"),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: git(repo, "symbolic-ref", "HEAD") + git(repo, "rev-parse", "HEAD"),
    config: readFileSync(join(repo, ".git", "config"), "utf8"),
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
    hooks: readdirSync(join(repo, ".git", "hooks")).join(","),
  };
}

/**
 * Plants, in a run folder's own .git, every way to make a later git call run a program: core.fsmonitor,
 * core.hooksPath to a folder of hooks, a hook in .git/hooks, and a textconv driver every file uses. Each writes
 * a marker file in `root` when it runs.
 */
function plantTraps(workdir: string, root: string) {
  const markers = join(root, "markers");
  mkdirSync(markers, { recursive: true });
  const script = (name: string) => {
    const p = join(root, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${join(markers, name)}"\n${name === "textconv" ? 'cat "$1"\n' : ""}exit 0\n`);
    chmodSync(p, 0o755);
    return p;
  };
  mkdirSync(join(workdir, ".git", "hooks"), { recursive: true });
  const evilHooks = join(root, "evil-hooks");
  mkdirSync(evilHooks, { recursive: true });
  for (const h of ["pre-commit", "post-commit", "pre-push", "reference-transaction", "post-checkout", "post-merge"]) {
    writeFileSync(join(evilHooks, h), `#!/bin/sh\ntouch "${join(markers, `hookspath-${h}`)}"\n`);
    chmodSync(join(evilHooks, h), 0o755);
    writeFileSync(join(workdir, ".git", "hooks", h), `#!/bin/sh\ntouch "${join(markers, `githooks-${h}`)}"\n`);
    chmodSync(join(workdir, ".git", "hooks", h), 0o755);
  }
  git(workdir, "config", "core.fsmonitor", script("fsmonitor"));
  git(workdir, "config", "core.hooksPath", evilHooks);
  git(workdir, "config", "diff.evil.textconv", script("textconv"));
  mkdirSync(join(workdir, ".git", "info"), { recursive: true });
  writeFileSync(join(workdir, ".git", "info", "attributes"), "* diff=evil\n");
  return { markers, fired: () => readdirSync(markers) };
}

const identity = { GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "b@e", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "b@e" };
const sbxEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", ...identity };

function brokerFor(repo: string, store: Awaited<ReturnType<typeof newStore>>["store"], clock: FakeClock) {
  const client = {
    request: async (method: string) => (method === "GET" ? [] : { number: 42, html_url: "https://example.com/pr/42" }),
    commentOnce: async () => ({ created: true }),
  } as unknown as GitHubClient;
  return new GitHubToolBroker({
    client, store, clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/", repoPath: repo,
    secrets: { get: async () => ({ reveal: () => "not-a-real-token" }) as unknown as Secret, valuesForScan: async () => [] },
    scanner: cleanScanner,
  });
}

describe("run folder isolation (NoOpSandbox)", () => {
  it("gives the run its own git folder: its branches, index, HEAD, refs and config never reach the factory repo", async () => {
    const f = factoryRepo();
    const before = factoryState(f.repo);
    const sbx = new NoOpSandbox(f.worktrees);
    const h = await sbx.create({ repo: f.repo, branch: "factory/wi_iso", base_ref: "main" });

    const common = git(h.workdir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(common).toBe(real(join(h.workdir, ".git")));
    expect(common).not.toBe(real(join(f.repo, ".git")));
    expect(under(common, h.workdir)).toBe(true);

    // What an agent might do in its run folder.
    git(h.workdir, "branch", "planted");
    git(h.workdir, "checkout", "--quiet", "-b", "factory/also-planted");
    commit(h.workdir, "src/new.txt", "n\n", "agent work");
    writeFileSync(join(h.workdir, "README.md"), "staged\n");
    git(h.workdir, "add", "README.md");
    git(h.workdir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(h.workdir, "update-ref", "refs/heads/main", "HEAD");
    git(h.workdir, "symbolic-ref", "HEAD", "refs/heads/planted");
    git(h.workdir, "config", "user.name", "agent");
    git(h.workdir, "config", "core.sshCommand", "touch /tmp/never");
    mkdirSync(join(h.workdir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(h.workdir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");

    expect(factoryState(f.repo)).toEqual(before);
    expect(git(f.repo, "branch", "--list")).not.toContain("planted");
    expect(git(f.repo, "branch", "--list")).not.toContain("factory/");
    await sbx.destroy(h);
  });

  it("borrows the factory repo's objects instead of copying them", async () => {
    const f = factoryRepo();
    const sbx = new NoOpSandbox(f.worktrees);
    const h = await sbx.create({ repo: f.repo, branch: null, base_ref: "main" });
    const alternates = readFileSync(join(h.workdir, ".git", "objects", "info", "alternates"), "utf8").trim();
    expect(real(alternates)).toBe(real(join(f.repo, ".git", "objects")));
    expect(git(h.workdir, "count-objects", "-v")).toMatch(/^count: 0$[\s\S]*^in-pack: 0$/m);
    await sbx.destroy(h);
  });

  it("points core.hooksPath at an empty folder outside the run folder, so a hook in .git/hooks never runs on a commit", async () => {
    const f = factoryRepo();
    const sbx = new NoOpSandbox(f.worktrees);
    const h = await sbx.create({ repo: f.repo, branch: "factory/wi_hooks", base_ref: "main" });

    const hooks = git(h.workdir, "config", "core.hooksPath");
    expect(hooks).toBe(join(f.worktrees, EMPTY_HOOKS_DIR));
    expect(readdirSync(hooks)).toEqual([]);
    expect(under(real(hooks), h.workdir)).toBe(false);

    const marker = join(f.root, "hook-ran");
    expect(existsSync(join(h.workdir, ".git", "hooks"))).toBe(false); // no template hooks copied in
    mkdirSync(join(h.workdir, ".git", "hooks"));
    writeFileSync(join(h.workdir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(h.workdir, ".git", "hooks", "pre-commit"), 0o755);
    const r = await sbx.exec(h, ["git", "commit", "--quiet", "--allow-empty", "-m", "x"], { env: sbxEnv });
    expect(r.exit_code).toBe(0);
    expect(existsSync(marker)).toBe(false);

    // Control: the same hook does run when git is pointed at .git/hooks.
    await sbx.exec(h, ["git", "-c", "core.hooksPath=.git/hooks", "commit", "--quiet", "--allow-empty", "-m", "y"], { env: sbxEnv });
    expect(existsSync(marker)).toBe(true);
    await sbx.destroy(h);
  });

  it("the traps fire for plain git in a run folder (control for the tests below)", async () => {
    const f = factoryRepo();
    const sbx = new NoOpSandbox(f.worktrees);
    const h = await sbx.create({ repo: f.repo, branch: "factory/wi_ctl", base_ref: "main" });
    commit(h.workdir, "src/a.txt", "changed\n", "change");
    const t = plantTraps(h.workdir, f.root);
    git(h.workdir, "status", "--short");
    git(h.workdir, "diff", "HEAD~1", "HEAD");
    git(h.workdir, "commit", "--quiet", "--allow-empty", "-m", "z");
    expect(t.fired()).toEqual(expect.arrayContaining(["fsmonitor", "textconv", "hookspath-pre-commit"]));
    await sbx.destroy(h);
  });
});

describe("the broker in a run folder", () => {
  async function setup() {
    const f = factoryRepo();
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    const ctx = { run_id: run.id, work_item_id: item.id, lease_token: run.lease!.token };
    const sbx = new NoOpSandbox(f.worktrees);
    const h = await sbx.create({ repo: f.repo, branch: "factory/wi_b", base_ref: "main" });
    const broker = brokerFor(f.repo, store, clock);
    const push = () => broker.call(ctx, "github.push_branch", { workdir: h.workdir, branch: "factory/wi_b", base_ref: "main" });
    const remoteHas = (bare: string) => git(bare, "for-each-ref", "refs/heads/factory/wi_b") !== "";
    return { f, h, push, remoteHas };
  }

  it("pushes to the factory repo's remote, not to the origin the run folder's config names", async () => {
    const { f, h, push, remoteHas } = await setup();
    commit(h.workdir, "src/b.txt", "b\n", "b");
    git(h.workdir, "remote", "set-url", "origin", f.decoy);
    expect(git(h.workdir, "remote", "get-url", "origin")).toBe(f.decoy);

    const r = await push();
    expect(r).toMatchObject({ ok: true });
    expect(remoteHas(f.origin)).toBe(true);
    expect(remoteHas(f.decoy)).toBe(false);
    expect(git(f.origin, "rev-parse", "refs/heads/factory/wi_b")).toBe(git(h.workdir, "rev-parse", "HEAD"));
  });

  it("scans the diff from the factory repo's origin/<base>, even when the run folder moved its own origin/<base>", async () => {
    const { h, push, f, remoteHas } = await setup();
    const token = ["ghp", "A".repeat(36)].join("_"); // built at runtime so this file holds no token-shaped text
    commit(h.workdir, "src/leak.txt", `${token}\n`, "leak");
    commit(h.workdir, "src/more.txt", "m\n", "more");
    // Hide the leak: base now looks like HEAD, so a diff from the run folder's origin/main would be empty.
    git(h.workdir, "update-ref", "refs/remotes/origin/main", "HEAD");

    const r = await push();
    expect(r).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(remoteHas(f.origin)).toBe(false);
  });

  it("refuses a run folder whose config names a program, and runs none of it during push, diff or rev-parse", async () => {
    const { h, push, f, remoteHas } = await setup();
    commit(h.workdir, "src/b.txt", "b\n", "b");
    const t = plantTraps(h.workdir, f.root);
    git(h.workdir, "config", `url.${f.decoy}.insteadOf`, f.origin);

    const r = await push();
    expect(r).toMatchObject({ ok: false, error_code: "untrusted_git_config" });
    expect(t.fired()).toEqual([]);
    expect(remoteHas(f.origin)).toBe(false);
    expect(remoteHas(f.decoy)).toBe(false);
  });

  it("refuses a run folder whose .git was swapped for a link to another git folder", async () => {
    const { h, push, f } = await setup();
    const other = join(f.root, "other");
    git(f.root, "clone", "--quiet", f.origin, other);
    execFileSync("rm", ["-rf", join(h.workdir, ".git")]);
    execFileSync("ln", ["-s", join(other, ".git"), join(h.workdir, ".git")]);
    expect(await push()).toMatchObject({ ok: false, error_code: "untrusted_git_dir" });
  });
});

describe("the worker's implement run in a real clone", () => {
  /** One implement run through the real NoOpSandbox and GitHubToolBroker; `agent` acts in the run folder. */
  async function implement(
    agent: (workdir: string, root: string) => void,
    cfgPatch: Partial<FactoryConfig> = {},
    Sbx: typeof NoOpSandbox = NoOpSandbox,
  ) {
    const f = factoryRepo();
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item: created } = await store.createWorkItem(issue(78), system);
    const moved = await store.transition({
      id: created.id, expected_version: created.version, actor: system, reason: "test_setup",
      patch: { stage: "RUNNING", allowed_paths: ["src/"], done_criteria: ["works"], scope: "s", tier: 1 },
      enqueue: { kind: "implement", idempotency_key: "impl-1" },
    });
    if (!moved.ok) throw new Error("setup");
    const before = factoryState(f.repo);
    const cfg: FactoryConfig = { ...config, ...cfgPatch, repo: { ...config.repo, path: f.repo } };
    const runner = new FakeRunner({
      implement: (spec: AgentRunSpec) => {
        agent(spec.sandbox.workdir, f.root);
        return { output: { summary: "did it", next_steps: "none" } };
      },
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new Sbx(f.worktrees), runner, broker: brokerFor(f.repo, store, clock),
      storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent, scanner: cleanScanner, awake: new NoKeepAwake(),
      toolEnv: { PATH: process.env.PATH ?? "", HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(await worker.tick()).toBe(true);
    const run = (await store.listRuns(created.id)).find((r) => r.kind === "implement")!;
    const branch = `factory/${created.id}`;
    const remote = (bare: string) => git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
    return { f, run, spec: runner.specs[0]!, before, remote, branch };
  }

  const agentCommits = (wd: string) => commit(wd, "src/b.txt", "b\n", "add b");

  it("gives the agent no writable path in the factory repo, then pushes and opens the PR", async () => {
    let workdir = "";
    const r = await implement((wd) => {
      workdir = wd;
      agentCommits(wd);
    });
    expect(r.run.outcome).toMatchObject({ status: "succeeded", data: { pr_number: 42, commits: 1 } });
    expect(r.spec.writable_paths).toEqual([]);
    for (const p of r.spec.writable_paths) {
      expect(under(p, r.f.repo)).toBe(false);
    }
    expect(under(real(join(r.f.worktrees, EMPTY_HOOKS_DIR)), r.f.worktrees)).toBe(true);
    expect(r.spec.writable_paths).not.toContain(join(r.f.worktrees, EMPTY_HOOKS_DIR));
    expect(r.remote(r.f.origin)).not.toBe("");
    // The run's own branch never shows up in the factory repo, and destroy removed the run folder.
    expect(git(r.f.repo, "branch", "--list")).not.toContain("factory/");
    expect(existsSync(workdir)).toBe(false);
    expect(factoryState(r.f.repo)).toEqual(r.before);
  });

  it("runs no fsmonitor, hook or textconv the agent configured, and pushes to the trusted remote", async () => {
    let fired: () => string[] = () => [];
    let gone = "";
    const r = await implement((wd, root) => {
      agentCommits(wd);
      fired = plantTraps(wd, root).fired;
      git(wd, "remote", "set-url", "origin", join(root, "decoy.git"));
      gone = wd;
    });
    expect(r.run.outcome).toMatchObject({ status: "succeeded", data: { pr_number: 42 } });
    expect(fired()).toEqual([]);
    expect(r.remote(r.f.origin)).not.toBe("");
    expect(r.remote(r.f.decoy)).toBe("");
    expect(existsSync(gone)).toBe(false);
  });

  it("diffs the scope, size and floor gates from the factory repo's origin/<base>, not the run folder's", async () => {
    const r = await implement((wd) => {
      commit(wd, "README.md", "changed outside allowed paths\n", "readme");
      git(wd, "update-ref", "refs/remotes/origin/main", "HEAD");
    });
    expect(r.run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });
    if (r.run.outcome?.status === "failed") expect(r.run.outcome.detail).toContain("README.md");
    expect(r.remote(r.f.origin)).toBe("");
  });

  it("takes the base from the factory repo (the sandbox's base_sha), even when the run folder's ref differs from the start", async () => {
    /** A run folder whose origin/main already points past the factory repo's when the worker first looks. */
    class SkewedSandbox extends NoOpSandbox {
      override async create(spec: Parameters<NoOpSandbox["create"]>[0]) {
        const h = await super.create(spec);
        commit(h.workdir, "README.md", "outside allowed paths\n", "readme");
        git(h.workdir, "update-ref", "refs/remotes/origin/main", "HEAD");
        return h;
      }
    }
    const r = await implement(agentCommits, {}, SkewedSandbox);
    expect(r.run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });
    if (r.run.outcome?.status === "failed") expect(r.run.outcome.detail).toContain("README.md");
  });

  it("the size gate also counts from the trusted base", async () => {
    const r = await implement(
      (wd) => {
        commit(wd, "src/big.txt", "x\n".repeat(20), "big");
        git(wd, "update-ref", "refs/remotes/origin/main", "HEAD");
      },
      { max_diff_lines: 5 },
    );
    expect(r.run.outcome).toMatchObject({ status: "failed", error_code: "diff_too_large" });
  });

  it("the floor check also reads from the trusted base", async () => {
    const r = await implement((wd) => {
      commit(wd, "src/impl/broker/x.ts", "x\n", "floor file");
      git(wd, "update-ref", "refs/remotes/origin/main", "HEAD");
    });
    expect(r.run.outcome).toMatchObject({ status: "succeeded", data: { floor_block: true } });
    expect(r.remote(r.f.origin)).toBe("");
  });
});
