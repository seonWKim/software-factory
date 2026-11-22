// The run-side install cache (design 05-sandbox.md): a run folder's `repo.install_command` step first clones the
// node_modules cached for its lock file, `<state_dir>/run-deps/<hash of package-lock.json>/node_modules`, into the
// folder as a real directory (a copy-on-write clone, never a symlink), and skips the install command on a hit. A
// miss, or a clone that fails or is not supported (a sandbox that cannot see host paths), runs the install command
// as before; a passing install is then cloned into the cache under a temporary name and renamed into place, so a
// partial install is never an entry. Storing keeps the 3 most recently used entries. `run-deps/` is the run side's
// own folder: the updater's `deps/` cleanup never reaches it. Clone and copy go through `Sandbox.exec`; a failure
// of the cache itself is a warning, never a run failure.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerDeps } from "./support.js";

/** Entries kept in `run-deps/` after a new one is stored: the most recently used. */
export const RUN_DEPS_KEEP = 3;
const MODULES = "node_modules";
const TMP = ".tmp-";

/** A copy-on-write clone of a folder: `cp -c -R` on macOS (APFS), `cp --reflink=auto -R` elsewhere (Linux). */
export function cloneArgv(platform: NodeJS.Platform, from: string, to: string): string[] {
  return platform === "darwin" ? ["cp", "-c", "-R", "--", from, to] : ["cp", "--reflink=auto", "-R", "--", from, to];
}

/** Whether a command is the repo's install command, the only one the cache stands in for (decision 1). */
export function isInstallCommand(cmd: readonly string[], install: readonly string[]): boolean {
  return cmd.length === install.length && cmd.every((a, i) => a === install[i]);
}

type CacheDeps = Pick<WorkerDeps, "install_cache" | "sandbox" | "toolEnv" | "log">;
type SandboxHandle = Parameters<WorkerDeps["sandbox"]["exec"]>[0];

/**
 * The install step in `handle`'s run folder through the cache: null when the cached node_modules was cloned in (the
 * install command did not run), else `install()`'s result, whose node_modules is stored when it did not fail.
 * No cache dir (`install_cache` unset) or no package-lock.json: `install()` as before.
 */
export async function cachedInstall<R extends { failed: unknown }>(
  w: { d: CacheDeps },
  handle: SandboxHandle,
  install: () => Promise<R>,
  platform: NodeJS.Platform = process.platform,
): Promise<R | null> {
  const root = w.d.install_cache;
  const exec = (argv: string[]) => w.d.sandbox.exec(handle, argv, { env: w.d.toolEnv });
  const lock = root ? await exec(["cat", "--", "package-lock.json"]).catch(() => null) : null;
  if (!root || !lock || lock.exit_code !== 0) return install();
  const hash = createHash("sha256").update(lock.stdout).digest("hex").slice(0, 16);
  const entry = join(root, hash);
  const hit = existsSync(join(entry, MODULES));
  if (hit) {
    const cloned = await exec(["rm", "-rf", "--", MODULES])
      .then((r) => (r.exit_code === 0 ? exec(cloneArgv(platform, join(entry, MODULES), MODULES)) : r))
      .catch(() => null);
    if (cloned?.exit_code === 0) {
      await exec(["touch", "--", entry]).catch(() => null); // most recently used, for pruning
      return null;
    }
    w.d.log.warn("install cache: clone failed; running the install command", { lock_hash: hash, error: cloned?.stderr.trim() ?? "could not run" });
    await exec(["rm", "-rf", "--", MODULES]).catch(() => null);
  }
  const r = await install();
  if (r.failed || hit) return r;
  await store(w.d, exec, platform, root, hash).catch((err: unknown) => {
    w.d.log.warn("install cache: storing failed", { lock_hash: hash, error: err instanceof Error ? err.message : String(err) });
  });
  return r;
}

/** The run folder's node_modules into `<root>/<hash>`: cloned into a temporary folder, then renamed into place; then pruned. */
async function store(d: CacheDeps, exec: (argv: string[]) => Promise<{ exit_code: number | null; stderr: string }>, platform: NodeJS.Platform, root: string, hash: string): Promise<void> {
  const tmp = join(root, `${TMP}${hash}-${randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const cp = await exec(cloneArgv(platform, MODULES, join(tmp, MODULES)));
    if (cp.exit_code !== 0 || !existsSync(join(tmp, MODULES))) throw new Error(`clone into the cache: ${cp.stderr.trim() || "no node_modules copied"}`);
    // Two runs that missed at once: the first rename wins, the other's copy is dropped.
    if (!existsSync(join(root, hash))) await rename(tmp, join(root, hash)).catch(() => undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  d.log.info("install cache: stored", { lock_hash: hash });
  await prune(root);
}

/** Removes every entry beyond the RUN_DEPS_KEEP most recently used (by folder mtime); temporary folders are left. */
export async function prune(root: string, keep = RUN_DEPS_KEEP): Promise<void> {
  const names = (await readdir(root)).filter((n) => !n.startsWith(TMP));
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(root, n)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.t - a.t);
  for (const { n } of dated.slice(keep)) await rm(join(root, n), { recursive: true, force: true });
}
