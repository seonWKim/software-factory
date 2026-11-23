// The shared removal-safety helper (design 08-cleanup, 08-teardown): one set of checks before a run folder or a branch
// goes, used by the cleanup's handlers and by `factory teardown`. Real git in temporary repositories.

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderUnsafe, mergedRule } from "../src/cleanup/index.js";
import { runProcess } from "../src/impl/process/run-process.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { git } from "./helpers/git-fixture.js";

async function repoWithClone() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-safety-")));
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  git(dir, "branch", "factory/wi_1");
  const clone = (await new NoOpSandbox(join(dir, ".worktrees"), runProcess, undefined, { local: true }).create({ repo: dir, branch: "factory/wi_1", base_ref: "main" })).workdir;
  return { dir, clone };
}

describe("folderUnsafe", () => {
  it("is null for a clean clone whose commits the repository has", async () => {
    const { dir, clone } = await repoWithClone();
    expect(await folderUnsafe(runProcess, dir, clone, true)).toBeNull();
  });

  it("names uncommitted changes, and commits the repository lacks (a clone only)", async () => {
    const { dir, clone } = await repoWithClone();
    git(clone, "commit", "--quiet", "--allow-empty", "-m", "local only");
    expect(await folderUnsafe(runProcess, dir, clone, true)).toBe("it holds commits the repository does not have");
    expect(await folderUnsafe(runProcess, dir, clone, false)).toBeNull();
    writeFileSync(join(clone, "x.txt"), "x\n");
    expect(await folderUnsafe(runProcess, dir, clone, true)).toBe("it has uncommitted changes");
  });

  it("names a folder whose git status cannot be read", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-safety-nogit-")));
    expect(await folderUnsafe(runProcess, dir, dir, true)).toBe("its git status could not be read");
  });
});

describe("mergedRule", () => {
  it("a sha in the base branch is merged; one past it is not", async () => {
    const { dir } = await repoWithClone();
    const rule = await mergedRule(runProcess, dir, "main");
    expect(rule.bases).toEqual(["refs/heads/main"]);
    expect(await rule.merged(git(dir, "rev-parse", "HEAD"))).toBe(true);
    expect(await rule.merged(git(dir, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "x"))).toBe(false);
  });

  it("a repository without the base branch merges nothing", async () => {
    const { dir } = await repoWithClone();
    const rule = await mergedRule(runProcess, dir, "trunk");
    expect(rule.bases).toEqual([]);
    expect(await rule.merged(git(dir, "rev-parse", "HEAD"))).toBe(false);
  });

  it("is the helper teardown imports", () => {
    const teardown = readFileSync(join(import.meta.dirname, "..", "src", "teardown.ts"), "utf8");
    expect(teardown).toMatch(/import \{ folderUnsafe, mergedRule \} from "\.\/cleanup\/index\.js";/);
  });
});
