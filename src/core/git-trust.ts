// Which keys of a run's .git/config trusted git calls may read (design §5). Kernel code (RFC 0023 §3): the tool
// broker's trusted git and the worker share it without the broker importing the worker component.

export const TRUSTED_GIT_KEYS = new Set([
  "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase",
  "core.precomposeunicode", "core.symlinks", "core.hookspath", "extensions.objectformat", "extensions.refstorage",
  "remote.origin.url", "remote.origin.fetch", "user.name", "user.email",
]);

/**
 * The keys in a run's `.git/config` (`git config --name-only --list -z` output) that are not plain data a sandbox
 * or git itself writes there. Anything else may make git run a program (filters, textconv, fsmonitor, ssh,
 * credential helpers, includes, URL rewrites), so trusted git calls never read it (design §5).
 */
export function untrustedGitConfig(names: string): string[] {
  const keys = names.split("\0").filter(Boolean);
  return [...new Set(keys.filter((k) => !TRUSTED_GIT_KEYS.has(k) && !/^branch\.[^\n]+\.(remote|merge)$/.test(k)))];
}
