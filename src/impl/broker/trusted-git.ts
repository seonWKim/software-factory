// The trusted-git checks both brokers run before they move a run's branch anywhere (design §5): the trusted base
// and remote come from the factory repo, never from the run folder; git in the run folder runs only on its own git
// folder, with no config key that could run a program, under TRUSTED_GIT_ENV; and the branch's commits, diff and
// `.env.example` files are scanned before anything leaves the run folder (G5).

import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ENV_EXAMPLE } from "../../core/tools/guard.js";
import { TRUSTED_GIT_ENV, untrustedGitConfig } from "../../worker/index.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { ExecResult } from "../../interfaces/sandbox.js";
import type { ToolCallContext, ToolResult } from "../../interfaces/tool-broker.js";
import { envExampleValueLines } from "../egress/pattern-egress-scanner.js";
import { baseEnv, runProcess } from "../process/run-process.js";

/** A failed tool result. */
export type ToolFailure = Extract<ToolResult, { ok: false }>;

/** Git in a checked run folder: its own git folder, TRUSTED_GIT_ENV, `extra` env added (a push credential). */
export type RunFolderGit = (args: string[], extra?: Record<string, string>) => Promise<ExecResult>;

/**
 * Lease fencing, the store's rule: status and token fence the caller, not the clock. A run whose lease ran out
 * during a host sleep but was not reaped still holds it; after a requeue or reclaim it does not.
 */
export async function holdsLease(store: Pick<FactoryStore, "getRun">, ctx: ToolCallContext): Promise<boolean> {
  const run = await store.getRun(ctx.run_id);
  return run !== null && run.work_item_id === ctx.work_item_id && run.status === "running" && run.lease?.token === ctx.lease_token;
}

/** Refuses a branch outside the factory's prefix: brokers move factory branches only. */
export function branchAllowed(branch: string, prefix: string): ToolFailure | null {
  return branch.startsWith(prefix) ? null : { ok: false, error_code: "branch_not_allowed", message: `only ${prefix}* branches` };
}

/** Git in the factory repo itself (trusted: the owner's config), with no prompt. */
export function factoryGit(repo: string, args: string[], extra: Record<string, string> = {}): Promise<ExecResult> {
  return runProcess(["git", "-C", repo, ...args], { cwd: repo, env: baseEnv({ GIT_TERMINAL_PROMPT: "0", ...extra }) });
}

/** The commit `ref` names in the factory repo (e.g. `origin/main`, `refs/heads/main`), or a git_failed result. */
export async function factoryCommit(repo: string, ref: string): Promise<{ sha: string } | ToolFailure> {
  const r = await factoryGit(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (r.exit_code !== 0) return { ok: false, error_code: "git_failed", message: r.stderr.trim().slice(0, 500) };
  return { sha: r.stdout.trim() };
}

/** The factory repo's push URL for origin: the only remote a push goes to, never the run folder's `origin`. */
export async function factoryRemoteUrl(repo: string): Promise<{ url: string } | ToolFailure> {
  const r = await factoryGit(repo, ["remote", "get-url", "--push", "origin"]);
  if (r.exit_code !== 0) return { ok: false, error_code: "git_failed", message: r.stderr.trim().slice(0, 500) };
  return { url: r.stdout.trim() };
}

/**
 * The run folder's git folder, as a real path, if it is the clone's own: a directory (not a link or a `gitdir:`
 * file) with no `commondir` or `config.worktree` that would make git read another folder's config.
 */
async function runFolderGitDir(workdir: string): Promise<string | null> {
  const dir = join(workdir, ".git");
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return null;
  for (const f of ["commondir", "config.worktree"]) {
    if (await lstat(join(dir, f)).then(() => true, () => false)) return null;
  }
  const cfg = await lstat(join(dir, "config")).catch(() => null);
  if (!cfg?.isFile()) return null;
  return realpath(dir);
}

/**
 * Git in the run folder, once its git folder is its own and its config holds no key that could run a program
 * (hooks, fsmonitor, textconv, URL rewrites, credential helpers): `untrusted_git_dir` or `untrusted_git_config`
 * otherwise.
 */
export async function trustedRunFolder(workdir: string): Promise<{ git: RunFolderGit; gitDir: string } | ToolFailure> {
  const gitDir = await runFolderGitDir(workdir);
  if (!gitDir) return { ok: false, error_code: "untrusted_git_dir", message: "the run folder's .git is not its own git folder" };
  const git: RunFolderGit = (args, extra = {}) =>
    runProcess(["git", ...args], {
      cwd: workdir,
      env: baseEnv({ ...extra, ...TRUSTED_GIT_ENV, GIT_DIR: gitDir, GIT_WORK_TREE: workdir }),
    });
  const names = await git(["config", "--file", join(gitDir, "config"), "--name-only", "--list", "-z"]);
  if (names.exit_code !== 0) return { ok: false, error_code: "git_failed", message: names.stderr.trim().slice(0, 500) };
  const untrusted = untrustedGitConfig(names.stdout);
  if (untrusted.length > 0) return { ok: false, error_code: "untrusted_git_config", message: untrusted.join(", ").slice(0, 500) };
  return { git, gitDir };
}

/** Where `storeBranch` writes a run's branch in the factory repo, and the trusted base its scan diffs from. */
export interface StoreTarget {
  readonly repo: string;
  /** The base the branch's scan starts from, as the factory repo names it (`refs/heads/main`, `origin/main`). */
  readonly base: string;
  /** The ref written: `refs/heads/<branch>` (a local item's final branch) or outbound's staging ref. */
  readonly ref: string;
  /** Moves the ref wherever it was: only for a staging ref no person writes. */
  readonly force: boolean;
}

/**
 * Writes the run folder's HEAD to `to.ref` of the factory repo with a push to the repo's own path (git's local
 * transport: the factory repo receives with its own config, the run folder's is never read there), after the
 * trusted-git checks and the G5 branch scan. Never a remote, never a credential. Unforced, a ref that moved
 * elsewhere is refused (`push_failed`). Returns the stored sha.
 */
export async function storeBranch(workdir: string, to: StoreTarget, scanner: EgressScanner): Promise<{ sha: string } | ToolFailure> {
  const base = await factoryCommit(to.repo, to.base);
  if (!("sha" in base)) return base;
  const folder = await trustedRunFolder(workdir);
  if (!("git" in folder)) return folder;
  const blocked = await scanBranch(folder.git, base.sha, scanner);
  if (blocked) return blocked;
  const r = await folder.git(["-c", "credential.helper=", "push", "--quiet", "--no-verify", to.repo, `${to.force ? "+" : ""}HEAD:${to.ref}`]);
  if (r.exit_code !== 0) return { ok: false, error_code: "push_failed", message: r.stderr.trim().slice(0, 500) };
  const head = await folder.git(["rev-parse", "HEAD"]);
  return { sha: head.stdout.trim() };
}

/**
 * G5 on what a branch would carry out of the run folder: the commit messages and the diff from the trusted `base`
 * to HEAD (`commit` channel), then every `.env.example` in HEAD's tree. Null when all are clean; else the result
 * to return (`egress_blocked`, or `git_failed`).
 */
export async function scanBranch(git: RunFolderGit, base: string, scanner: EgressScanner): Promise<ToolFailure | null> {
  const range = `${base}...HEAD`;
  const [log, diff] = await Promise.all([
    git(["log", "--no-textconv", "--format=%B", range]),
    git(["diff", "--no-textconv", "--no-ext-diff", range]),
  ]);
  if (log.exit_code !== 0 || diff.exit_code !== 0) {
    return { ok: false, error_code: "git_failed", message: (log.stderr + diff.stderr).trim() };
  }
  for (const content of [log.stdout, diff.stdout]) {
    const scan = await scanner.scan("commit", content);
    if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };
  }
  return checkEnvExample(git);
}

/**
 * The value check for `.env.example` (architecture §5): agents may edit it, so before a branch leaves the run
 * folder every `.env.example` in HEAD's tree must hold names only. The egress scan sees text without file names,
 * so this runs here, where the name is known. It checks HEAD, not the diff: a value in the tree is refused
 * wherever it came from. A committed symlink is refused too: on checkout it could point anywhere. Findings name
 * the file and line numbers, never the text.
 */
async function checkEnvExample(git: RunFolderGit): Promise<ToolFailure | null> {
  const tree = await git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  if (tree.exit_code !== 0) return { ok: false, error_code: "git_failed", message: tree.stderr.trim().slice(0, 500) };
  for (const entry of tree.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const path = entry.slice(tab + 1);
    if (path.slice(path.lastIndexOf("/") + 1) !== ENV_EXAMPLE) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    if (mode === "120000") return { ok: false, error_code: "egress_blocked", message: `env_example_symlink:${path}` };
    if (type !== "blob" || !sha) continue;
    const blob = await git(["cat-file", "blob", sha]);
    if (blob.exit_code !== 0) return { ok: false, error_code: "git_failed", message: blob.stderr.trim().slice(0, 500) };
    const lines = envExampleValueLines(blob.stdout);
    if (lines.length > 0) {
      return { ok: false, error_code: "egress_blocked", message: `env_example_value:${path}:${lines.join(",")}`.slice(0, 500) };
    }
  }
  return null;
}
