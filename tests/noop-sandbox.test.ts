import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";

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
  it("creates a worktree on a new branch from base, runs commands with only the given env, and destroys it", async () => {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_1", base_ref: "main" });
    expect(existsSync(join(h.workdir, "README.md"))).toBe(true);

    const r = await sbx.exec(h, ["sh", "-c", 'echo "$SECRET_FROM_WORKER-$ONLY"'], { env: { PATH: process.env.PATH!, ONLY: "x" } });
    expect(r.stdout.trim()).toBe("-x");
    expect((await sbx.exec(h, ["git", "branch", "--show-current"], { env: { PATH: process.env.PATH! } })).stdout.trim()).toBe(
      "factory/wi_1",
    );

    await sbx.destroy(h);
    expect(existsSync(h.workdir)).toBe(false);
    await sbx.destroy(h); // idempotent
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
