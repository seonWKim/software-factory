import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";

// The Changes tab's sandbox read (design 09-dashboard-item): the trusted base with its committer time, the files a head
// changes against it (`base...head`) with their counts, and one file's patch, cut at a byte limit. A local repo only:
// no remote is fetched, and no ref, index or working tree changes.

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

/** A repo whose `main` has a.txt and whose `factory/wi_1` changes a.txt, adds b.txt and a binary file. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "sf-changes-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "checkout", "--quiet", "-b", "factory/wi_1");
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(repo, "b file.txt"), `${"x".repeat(100)}\n`);
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "change");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "main");
  // The base moves after the branch: its own change is not in the head's diff (three dots).
  writeFileSync(join(repo, "c.txt"), "base only\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base moves");
  return { root, repo, head, base: git(repo, "rev-parse", "HEAD") };
}

describe("NoOpSandbox.readChanges", { timeout: 30_000 }, () => {
  it("reads the local base and its committer time, with no head", async () => {
    const r = repo();
    const sbx = new NoOpSandbox(join(r.root, "worktrees"), undefined, undefined, { local: true });
    const read = await sbx.readChanges({ repo: r.repo, base_ref: "main" });
    expect(read.base?.sha).toBe(r.base);
    expect(read.base?.committed_at).toBe(new Date(Number(git(r.repo, "log", "-1", "--format=%ct", r.base)) * 1000).toISOString());
    expect(read.files).toEqual([]);
    expect(read.patch).toBeNull();
  });

  it("lists each file the head changes against the merge base with its counts, a binary file's as null", async () => {
    const r = repo();
    const sbx = new NoOpSandbox(join(r.root, "worktrees"), undefined, undefined, { local: true });
    const read = await sbx.readChanges({ repo: r.repo, base_ref: "main", head_sha: r.head });
    expect(read.files).toEqual([
      { path: "a.txt", added: 2, removed: 1 },
      { path: "b file.txt", added: 1, removed: 0 },
      { path: "bin.dat", added: null, removed: null },
    ]);
    expect(read.files.map((f) => f.path)).not.toContain("c.txt");
    // Nothing moved: the checkout is still on main, clean.
    expect(git(r.repo, "branch", "--show-current")).toBe("main");
    expect(git(r.repo, "status", "--porcelain")).toBe("");
  });

  it("reads one file's patch, and cuts a longer one at max_bytes with truncated set", async () => {
    const r = repo();
    const sbx = new NoOpSandbox(join(r.root, "worktrees"), undefined, undefined, { local: true });
    const whole = await sbx.readChanges({ repo: r.repo, base_ref: "main", head_sha: r.head, path: "a.txt", max_bytes: 256 * 1024 });
    expect(whole.patch?.truncated).toBe(false);
    expect(whole.patch?.text).toContain("-two\n+TWO\n+three");
    expect(whole.patch?.text).not.toContain("b file.txt");
    const cut = await sbx.readChanges({ repo: r.repo, base_ref: "main", head_sha: r.head, path: "b file.txt", max_bytes: 40 });
    expect(cut.patch).toEqual({ text: expect.any(String), truncated: true });
    expect(Buffer.byteLength(cut.patch!.text)).toBeLessThanOrEqual(40);
  });

  it("returns no base for a missing base branch, and refuses a head that is not a sha", async () => {
    const r = repo();
    const sbx = new NoOpSandbox(join(r.root, "worktrees"), undefined, undefined, { local: true });
    expect(await sbx.readChanges({ repo: r.repo, base_ref: "nope" })).toEqual({ base: null, files: [], patch: null });
    await expect(sbx.readChanges({ repo: r.repo, base_ref: "main", head_sha: "--output=x" })).rejects.toThrow(/not a commit sha/);
  });

  it("reads origin/<base> when the sandbox fetches origin, without fetching", async () => {
    const r = repo();
    git(r.repo, "update-ref", "refs/remotes/origin/main", r.head);
    const sbx = new NoOpSandbox(join(r.root, "worktrees"));
    expect((await sbx.readChanges({ repo: r.repo, base_ref: "main" })).base?.sha).toBe(r.head);
  });
});
