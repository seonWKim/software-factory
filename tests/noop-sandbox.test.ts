import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
