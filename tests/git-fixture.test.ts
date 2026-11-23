import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_ENV, git } from "./helpers/git-fixture.js";

describe("git fixture", () => {
  // Bug: a template's last commit starts a detached `git maintenance run --auto`, which creates and removes
  // .git/objects/maintenance.lock while copy() lists the template, so the copy fails with ENOENT.
  it("a commit with git()'s environment starts no background maintenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-git-fixture-"));
    const repo = join(dir, "repo");
    git(dir, "init", "--quiet", "-b", "main", "repo");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    const trace = join(dir, "trace.txt");
    execFileSync("git", ["commit", "--quiet", "-m", "a"], { cwd: repo, env: { ...GIT_ENV, GIT_TRACE: trace } });
    const log = readFileSync(trace, "utf8");
    expect(log).toMatch(/built-in: git commit/);
    expect(log).not.toMatch(/maintenance run|gc --auto/);
  });
});
