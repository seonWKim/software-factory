import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalMergeSpec } from "../src/core/local-merge.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";

// The local merge's temporary worktree (design 05-sources, Local items beside a forge; issue #333): the merged result
// is checked in a detached worktree beside the run folders, never in the live checkout, which keeps its HEAD,
// index and status; a failed check moves nothing; two merges of one branch at once move the base once.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const commit = (dir: string, path: string, text: string, msg: string) => {
  writeFileSync(join(dir, path), text);
  git(dir, "add", "-A");
  git(dir, ...ident, "commit", "--quiet", "-m", msg);
};

/** A factory repo with `main` and the branch `factory/wi_1` one commit ahead, the owner on `work` with uncommitted changes. */
function repoWithBranch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-local-forge-")));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commit(repo, "README.md", "hi\n", "init");
  git(repo, "checkout", "--quiet", "-b", "factory/wi_1");
  commit(repo, "gate.txt", "the gate\n", "add the gate");
  git(repo, "checkout", "--quiet", "-b", "work", "main");
  writeFileSync(join(repo, "README.md"), "hi, edited\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const live = () => ({ head: git(repo, "rev-parse", "HEAD"), ref: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain") });
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const spec = (checks?: LocalMergeSpec["checks"]): LocalMergeSpec => ({
    repo, base_ref: "main", branch: "factory/wi_1", message: "Merge factory/wi_1 into main", identity: { name: "bot", email: "bot@example.com" },
    ...(checks ? { checks } : {}),
  });
  return { root, repo, live, sandbox, spec };
}

describe("the local merge's temporary worktree", { timeout: 30_000 }, () => {
  it("runs the checks on the merged result in a temporary worktree, removes it, and leaves the live checkout's HEAD and status unchanged", async () => {
    const r = repoWithBranch();
    const before = r.live();
    const mainBefore = git(r.repo, "rev-parse", "main");
    const seen = join(r.root, "seen.txt");
    // The check records where it ran and what it saw: the merged tree, with the branch's file.
    const merged = await r.sandbox.mergeLocal(r.spec({ commands: [["sh", "-c", `pwd > ${seen}; cat gate.txt >> ${seen}; git rev-parse HEAD >> ${seen}`]], timeout_ms: 30_000 }));
    expect(merged).toMatchObject({ merged: true, already: false });
    const sha = (merged as { sha: string }).sha;
    expect(git(r.repo, "rev-parse", "main")).toBe(sha);
    expect(git(r.repo, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1)).toEqual([mainBefore, git(r.repo, "rev-parse", "factory/wi_1")]);

    const [ranIn, gate, head] = readFileSync(seen, "utf8").trim().split("\n");
    expect(ranIn).not.toBe(r.repo);
    expect(ranIn!.startsWith(join(r.root, "wt"))).toBe(true);
    expect(gate).toBe("the gate");
    expect(head).toBe(sha);
    // The worktree is gone, from the disk and from git's list.
    expect(existsSync(ranIn!)).toBe(false);
    expect(git(r.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toEqual([`worktree ${r.repo}`]);
    expect(r.live()).toEqual(before);
  });

  it("a failing check moves nothing: the base branch, the live checkout and the worktree list are as before", async () => {
    const r = repoWithBranch();
    const before = r.live();
    const mainBefore = git(r.repo, "rev-parse", "main");
    const result = await r.sandbox.mergeLocal(r.spec({ commands: [["sh", "-c", "exit 0"], ["sh", "-c", "echo broken; exit 4"]], timeout_ms: 30_000 }));
    expect(result).toMatchObject({ merged: false, failed: { command: ["sh", "-c", "echo broken; exit 4"], ok: false, how: "exited 4" } });
    expect((result as { failed: { tail: string } }).failed.tail).toContain("broken");
    expect(git(r.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(r.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toEqual([`worktree ${r.repo}`]);
    expect(r.live()).toEqual(before);
  });

  it("two merges of the same branch at once move the base once; the other reports the branch merged", async () => {
    const r = repoWithBranch();
    const mainBefore = git(r.repo, "rev-parse", "main");
    const other = new NoOpSandbox(join(r.root, "wt2"), undefined, undefined, { local: true });
    const checks = { commands: [["sh", "-c", "exit 0"]], timeout_ms: 30_000 };
    const [a, b] = await Promise.all([r.sandbox.mergeLocal(r.spec(checks)), other.mergeLocal(r.spec(checks))]);
    const main = git(r.repo, "rev-parse", "main");
    expect([a, b]).toEqual(expect.arrayContaining([{ merged: true, sha: main, already: false }]));
    expect([a, b].filter((x) => x.merged && !x.already)).toHaveLength(1);
    expect([a, b].every((x) => x.merged && x.sha === main)).toBe(true);
    expect(git(r.repo, "rev-list", "--count", `${mainBefore}..main`)).toBe("2");
  });
});
