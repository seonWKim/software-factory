// The checks before a run folder or a branch is removed (design 08-cleanup, 08-teardown): one helper, used by the
// cleanup's handlers and by `factory teardown`. A folder is safe to drop when it has no uncommitted changes and (a
// clone) no commit the repository lacks; a branch when it is merged into the base branch (local or origin's).

import type { CommandRunner } from "../interfaces/updater.js";
import { baseEnv } from "../impl/process/run-process.js";
import { PID_FILE } from "../impl/updater/git-worktree.js";

function git(run: CommandRunner, cwd: string, args: readonly string[]) {
  return run(["git", ...args], { cwd, env: baseEnv() });
}

/**
 * Why the folder `dir`'s work is not safe to drop, or null: its git status cannot be read, it has uncommitted
 * changes (a version copy's pid file aside), or (`clone`: a folder with its own git) it holds commits `repo` lacks.
 */
export async function folderUnsafe(run: CommandRunner, repo: string, dir: string, clone: boolean): Promise<string | null> {
  const status = await git(run, dir, ["status", "--porcelain"]);
  if (status.exit_code !== 0) return "its git status could not be read";
  if (status.stdout.split("\n").some((l) => l.trim() !== "" && l !== `?? ${PID_FILE}`)) return "it has uncommitted changes";
  if (!clone) return null;
  const heads = (await git(run, dir, ["for-each-ref", "--format=%(objectname)", "refs/heads/"])).stdout.split("\n");
  const head = await git(run, dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  for (const sha of new Set([...heads, head.stdout].map((s) => s.trim()).filter(Boolean))) {
    if ((await git(run, repo, ["cat-file", "-e", `${sha}^{commit}`])).exit_code !== 0) return "it holds commits the repository does not have";
  }
  return null;
}

/** The merged-branch rule: `merged(sha)` is true when `sha` is in the local base branch or origin's. */
export interface MergedRule {
  /** The base refs that exist in the repository: `refs/heads/<base>`, `refs/remotes/origin/<base>`. */
  readonly bases: readonly string[];
  merged(sha: string): Promise<boolean>;
}

/** The merged-branch rule of `repo` for the base branch `base`. A repository with neither base ref merges nothing. */
export async function mergedRule(run: CommandRunner, repo: string, base: string): Promise<MergedRule> {
  const bases: string[] = [];
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    if ((await git(run, repo, ["rev-parse", "--verify", "--quiet", ref])).exit_code === 0) bases.push(ref);
  }
  return {
    bases,
    async merged(sha) {
      for (const b of bases) if ((await git(run, repo, ["merge-base", "--is-ancestor", sha, b])).exit_code === 0) return true;
      return false;
    },
  };
}
