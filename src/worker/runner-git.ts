import type { WorkerDeps } from "./support.js";
import { NO_HOOKS, RunFailure, TRUSTED_GIT_ENV, gitVerb, untrustedGitConfig } from "./support.js";

/** The sandbox handle type, taken from the deps so this module imports no interface file. */
type SandboxHandle = Parameters<WorkerDeps["sandbox"]["destroy"]>[0];

/**
 * What the worker's git helpers read: the sandbox and tool env, and the run's repo settings. A Worker satisfies it.
 * The helpers below are stateless functions of this and their arguments; they keep nothing between calls.
 */
export interface GitCtx {
  readonly d: Pick<WorkerDeps, "sandbox" | "toolEnv">;
  readonly cfg: { readonly repo: { path: string; base_branch: string } };
}

export async function git(w: GitCtx, handle: SandboxHandle, args: string[]): Promise<string> {
  return gitWith(w, handle, args);
}

export async function gitWith(w: GitCtx, handle: SandboxHandle, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await gitRaw(w, handle, args, env);
  if (r.exit_code !== 0) throw new RunFailure("git_failed", `git ${gitVerb(args)}: ${r.stderr.trim()}`, true);
  return r.stdout;
}

/** Every worker git call in a run folder: the trusted env ranks above whatever the run's .git/config says. */
export function gitRaw(w: GitCtx, handle: SandboxHandle, args: string[], env: Record<string, string> = {}) {
  return w.d.sandbox.exec(handle, ["git", ...args], { env: { ...w.d.toolEnv, ...env, ...TRUSTED_GIT_ENV } });
}

/**
 * The base commit the gates diff against: the factory repo's origin/<base>, as the sandbox resolved it before
 * any agent ran. A sandbox that does not report it: origin/<base> in the run folder, still before the agent.
 */
export async function trustedBase(w: GitCtx, handle: SandboxHandle): Promise<string> {
  if (handle.base_sha) return handle.base_sha;
  const base = w.cfg.repo.base_branch;
  return (await git(w, handle, ["rev-parse", "--verify", "--end-of-options", `origin/${base}^{commit}`])).trim();
}

/** The run folder's git dir and common dir, as real paths. Taken before the agent, compared after. */
export async function gitDirs(w: GitCtx, handle: SandboxHandle): Promise<string> {
  return (await git(w, handle, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).trim();
}

/**
 * After an agent ran in the run folder, before any other worker or broker git call there. The git folder must
 * still be the one the sandbox made (not swapped for a link or a `gitdir:` file pointing elsewhere), and every
 * config key the agent added that is not plain data is removed, so no trusted call runs a program it named.
 */
export async function distrustAgentGit(w: GitCtx, handle: SandboxHandle, before: string): Promise<void> {
  const after = await gitDirs(w, handle);
  if (after !== before) throw new RunFailure("untrusted_git_dir", "the run's git folder changed while the agent ran");
  const file = `${after.split("\n")[0]}/config`;
  const list = () => git(w, handle, ["config", "--file", file, "--name-only", "--list", "-z"]);
  for (const key of untrustedGitConfig(await list())) {
    await git(w, handle, ["config", "--file", file, "--unset-all", key]);
  }
  const left = untrustedGitConfig(await list());
  if (left.length > 0) throw new RunFailure("untrusted_git_config", `git config keys left: ${left.join(", ")}`.slice(0, 500));
}

/**
 * The untracked, not ignored files in the live checkout (`repo.path`, the owner's checkout), from a trusted git
 * call through the sandbox. Null when git cannot list them (a sandbox that cannot see the host checkout): then
 * the check is skipped. Best effort, never a failure (design §5 Sandbox).
 */
export async function liveUntracked(w: GitCtx, handle: SandboxHandle): Promise<Set<string> | null> {
  const r = await w.d.sandbox.exec(handle, ["git", "-C", w.cfg.repo.path, "ls-files", "--others", "--exclude-standard", "-z"], {
    env: { ...w.d.toolEnv, ...TRUSTED_GIT_ENV },
  }).catch(() => null);
  return r?.exit_code === 0 ? new Set(r.stdout.split("\0").filter(Boolean)) : null;
}

/**
 * A run folder as src/core/mechanical.ts sees it. Reads come from the index (`ls-files -s`, then the blob), and
 * only for regular files; writes go through git (a blob, its index entry, then `checkout-index`), never
 * through a path in the working tree, so a symlink there cannot redirect them. Hooks stay off.
 */
export function mergeIO(w: GitCtx, handle: SandboxHandle) {
  const entries = async (path: string) => {
    const ls = await git(w, handle, ["ls-files", "-s", "-z", "--", path]);
    return ls.split("\0").filter(Boolean).flatMap((line) => {
      const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.*)$/s.exec(line);
      return m && m[4] === path ? [{ mode: m[1]!, sha: m[2]!, stage: Number(m[3]) }] : [];
    });
  };
  return {
    stage: async (path: string, n: number) => {
      const e = (await entries(path)).find((x) => x.stage === n);
      if (!e || !/^100(644|755)$/.test(e.mode)) return null;
      const blob = await gitRaw(w, handle, ["cat-file", "blob", e.sha]);
      return blob.exit_code === 0 && !blob.stdout.includes("\0") ? blob.stdout : null;
    },
    write: async (path: string, text: string) => {
      const mode = (await entries(path)).find((x) => x.stage === 2 || x.stage === 0)?.mode ?? "100644";
      const hashed = await w.d.sandbox.exec(handle, ["git", "hash-object", "-w", "--stdin"], {
        env: { ...w.d.toolEnv, ...TRUSTED_GIT_ENV },
        stdin: text,
      });
      const sha = hashed.stdout.trim();
      if (hashed.exit_code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
        throw new RunFailure("git_failed", `git hash-object: ${hashed.stderr.trim()}`, true);
      }
      await git(w, handle, ["update-index", "--cacheinfo", `${mode},${sha},${path}`]);
      await git(w, handle, [...NO_HOOKS, "checkout-index", "-f", "--", path]);
    },
  };
}
