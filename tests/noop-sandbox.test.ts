import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { EMPTY_HOOKS_DIR, NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function repoWithOrigin() {
  const root = mkdtempSync(join(tmpdir(), "sf-sbx-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "main");
  return { root, repo, origin };
}

describe("NoOpSandbox", () => {
  it("creates its own clone on a new branch from base, runs commands with only the given env, and destroys it without a trace", async () => {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_1", base_ref: "main" });
    expect(existsSync(join(h.workdir, "README.md"))).toBe(true);

    const r = await sbx.exec(h, ["sh", "-c", 'echo "$SECRET_FROM_WORKER-$ONLY"'], { env: { PATH: process.env.PATH!, ONLY: "x" } });
    expect(r.stdout.trim()).toBe("-x");
    expect((await sbx.exec(h, ["git", "branch", "--show-current"], { env: { PATH: process.env.PATH! } })).stdout.trim()).toBe(
      "factory/wi_1",
    );

    // Its own clone: the git folder is inside the run folder, and the factory repo has no worktree for it.
    expect(statSync(join(h.workdir, ".git")).isDirectory()).toBe(true);
    expect(git(h.workdir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()).toBe(realpathSync(join(h.workdir, ".git")));
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(h.id);
    expect(h.base_sha).toBe(git(repo, "rev-parse", "origin/main").trim());

    await sbx.destroy(h);
    expect(existsSync(h.workdir)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, "branch", "--list")).not.toContain("factory/wi_1");
    await sbx.destroy(h); // idempotent: a second destroy is a no-op
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("checks out base detached for a read-only run, with the factory repo's origin/<base> as base_sha", async () => {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: null, base_ref: "main" });
    expect(git(h.workdir, "rev-parse", "HEAD").trim()).toBe(h.base_sha);
    expect(git(h.workdir, "branch", "--show-current").trim()).toBe("");
    await sbx.destroy(h);
  });

  it("refuses to point a clone at a hooks folder someone put a file in", async () => {
    const { root, repo } = repoWithOrigin();
    const worktrees = join(root, "worktrees");
    const sbx = new NoOpSandbox(worktrees);
    await sbx.destroy(await sbx.create({ repo, branch: null, base_ref: "main" }));
    const hooks = join(worktrees, EMPTY_HOOKS_DIR);
    chmodSync(hooks, 0o755);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n");
    await expect(sbx.create({ repo, branch: null, base_ref: "main" })).rejects.toThrow(/not empty/);
  });

  it("resumes from the remote branch when it exists", async () => {
    const { root, repo } = repoWithOrigin();
    git(repo, "checkout", "--quiet", "-b", "factory/wi_2");
    writeFileSync(join(repo, "work.txt"), "w\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "work");
    git(repo, "push", "--quiet", "origin", "factory/wi_2");
    git(repo, "checkout", "--quiet", "main");

    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_2", base_ref: "main" });
    expect(existsSync(join(h.workdir, "work.txt"))).toBe(true);
    await sbx.destroy(h);
  });
});

type Call = { args: string[] };
const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
const fail = (stderr: string): ExecResult => ({ exit_code: 1, signal: null, stdout: "", stderr, timed_out: false });
const noWait = async () => {};

/** A fake runner: `fetch` answers from `onFetch`, `rev-parse` answers a fixed sha. Records every git call's args. */
function fakeRunner(onFetch: (n: number) => Promise<ExecResult> | ExecResult) {
  const calls: Call[] = [];
  let fetches = 0;
  const run = async (cmd: readonly string[]): Promise<ExecResult> => {
    const args = cmd.slice(3); // drop "git", "-C", <cwd>
    calls.push({ args });
    if (args[0] === "fetch") return onFetch(fetches++);
    if (args[0] === "rev-parse") return ok("abc123\n");
    return ok();
  };
  return { run, calls, fetchCount: () => fetches };
}

function uniqueRepo() {
  return mkdtempSync(join(tmpdir(), "sf-sbx-fake-"));
}

describe("NoOpSandbox.updateBase", () => {
  it("fetches only the base branch, with no --prune", async () => {
    const f = fakeRunner(() => ok());
    const sbx = new NoOpSandbox("/unused", f.run, noWait);
    expect(await sbx.updateBase({ repo: uniqueRepo(), base_ref: "main" })).toBe("abc123");
    const fetches = f.calls.filter((c) => c.args[0] === "fetch");
    expect(fetches).toEqual([
      { args: ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"] },
    ]);
  });

  it("never runs two fetches for the same repo at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const f = fakeRunner(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return ok();
    });
    const repo = uniqueRepo();
    const a = new NoOpSandbox("/unused", f.run, noWait);
    const b = new NoOpSandbox("/unused", f.run, noWait);
    await Promise.all([a.updateBase({ repo, base_ref: "main" }), b.updateBase({ repo, base_ref: "main" })]);
    expect(f.fetchCount()).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it.each(["incorrect old value provided", "cannot lock ref 'refs/remotes/origin/x'", "unable to update local ref"])(
    "retries a ref-lock failure (%s) and succeeds when a later attempt works",
    async (msg) => {
      const f = fakeRunner((n) => (n < 2 ? fail(`error: ${msg}`) : ok()));
      const waits: number[] = [];
      const sbx = new NoOpSandbox("/unused", f.run, async (ms) => void waits.push(ms));
      expect(await sbx.updateBase({ repo: uniqueRepo(), base_ref: "main" })).toBe("abc123");
      expect(f.fetchCount()).toBe(3);
      expect(waits).toHaveLength(2);
    },
  );

  it("throws a persistent ref-lock error after 3 retries, in the usual git <cmd> failed format", async () => {
    const f = fakeRunner(() => fail("error: cannot lock ref 'refs/remotes/origin/main'\n"));
    const sbx = new NoOpSandbox("/unused", f.run, noWait);
    await expect(sbx.updateBase({ repo: uniqueRepo(), base_ref: "main" })).rejects.toThrow(
      new Error("git fetch failed: error: cannot lock ref 'refs/remotes/origin/main'"),
    );
    expect(f.fetchCount()).toBe(4);
  });

  it("throws any other git error on the first attempt, with no retry", async () => {
    const f = fakeRunner(() => fail("fatal: repository not found"));
    const waits: number[] = [];
    const sbx = new NoOpSandbox("/unused", f.run, async (ms) => void waits.push(ms));
    await expect(sbx.updateBase({ repo: uniqueRepo(), base_ref: "main" })).rejects.toThrow("git fetch failed: fatal: repository not found");
    expect(f.fetchCount()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("serializes and retries create's fetch too, keeping its full --prune fetch", async () => {
    const f = fakeRunner((n) => (n === 0 ? fail("error: cannot lock ref 'refs/remotes/origin/x'") : ok()));
    const root = uniqueRepo();
    const sbx = new NoOpSandbox(join(root, "worktrees"), f.run, noWait);
    // The fake makes no clone, so create fails later; the factory-repo fetch is what this checks.
    await sbx.create({ repo: root, branch: null, base_ref: "main" }).catch(() => {});
    const fetches = f.calls.filter((c) => c.args[0] === "fetch" && c.args[3] === "origin");
    expect(fetches.map((c) => c.args)).toEqual([
      ["fetch", "--quiet", "--prune", "origin"],
      ["fetch", "--quiet", "--prune", "origin"],
    ]);
  });

  it("changes only refs/remotes/origin/<base> in the factory checkout", async () => {
    const { root, repo, origin } = repoWithOrigin();
    git(repo, "push", "--quiet", "origin", "main:feature");
    git(repo, "fetch", "--quiet", "origin");
    const before = git(repo, "rev-parse", "refs/remotes/origin/feature").trim();

    // Move both branches on the remote from another clone, and delete nothing.
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "t");
    git(other, "commit", "--quiet", "--allow-empty", "-m", "next");
    git(other, "push", "--quiet", "origin", "HEAD:main", "HEAD:feature", "HEAD:extra");

    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const sha = await sbx.updateBase({ repo, base_ref: "main" });
    expect(sha).toBe(git(origin, "rev-parse", "main").trim());
    expect(git(repo, "rev-parse", "refs/remotes/origin/main").trim()).toBe(sha);
    expect(git(repo, "rev-parse", "refs/remotes/origin/feature").trim()).toBe(before);
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/")).not.toContain("extra");
  });

  it("10 parallel calls all succeed while the remote's branches move, each returning the remote's base commit", async () => {
    const { root, repo, origin } = repoWithOrigin();
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "t");
    for (let i = 0; i < 5; i++) git(other, "push", "--quiet", "origin", `HEAD:refs/heads/b${i}`);
    git(repo, "fetch", "--quiet", "origin");
    const base = git(origin, "rev-parse", "main").trim();

    let moving = true;
    const mover = (async () => {
      for (let i = 0; moving; i++) {
        git(other, "commit", "--quiet", "--allow-empty", "-m", `m${i}`);
        git(other, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/b${i % 5}`);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const results = await Promise.all(Array.from({ length: 10 }, () => sbx.updateBase({ repo, base_ref: "main" })));
    moving = false;
    await mover;
    expect(results).toEqual(Array(10).fill(base));
  });
});
