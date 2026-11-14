import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { readOnlyOverlaps } from "../../core/config.js";
import { isUnder } from "../../core/tools/paths.js";

type Warn = (message: string) => void;

/**
 * Copies each seed folder (`AgentRunSpec.toolchain_seeds`, design 05-sandbox.md) into `dest`, the run's own
 * `<TMPDIR>/toolchain/gradle/wrapper/dists`, before the agent starts. A local walk that copies files and folders and
 * never follows a link: a link whose resolved target stays inside the seed is made again in `dest` as a relative link
 * (so it points at the copy); a link that resolves outside the seed, into a `deny_paths` entry, or nowhere is
 * skipped and named in a warning (its link path only). Never a hardlink, nothing written to the source. Files
 * already in `dest` (an earlier step of the run) are kept. A seed that is not a folder, or overlaps `denied`, is
 * skipped. The copy's folders are owner-writable, so the wrapper can write its lock file beside the distribution.
 */
export async function copyToolchainSeeds(
  seeds: readonly string[], dest: string, denied: readonly string[], warn: Warn = (m) => console.warn(m),
): Promise<void> {
  if (seeds.length === 0) return;
  // Both the configured and the resolved form of each denied path, so a link's resolved target matches either.
  const deny = [...denied, ...(await Promise.all(denied.map((d) => realpath(d).catch(() => d))))];
  for (const seed of seeds) {
    const root = await realpath(seed).catch(() => null);
    if (!root || !(await stat(root)).isDirectory() || readOnlyOverlaps([root], deny).length > 0) continue;
    await copyTree(root, dest, root, deny, warn);
  }
}

async function copyTree(src: string, dest: string, root: string, deny: readonly string[], warn: Warn): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, root, deny, warn);
    else if (entry.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL).catch(keepExisting);
    else if (entry.isSymbolicLink()) {
      const target = await realpath(from).catch(() => null);
      if (!target || !isUnder(target, root) || readOnlyOverlaps([target], deny).length > 0) {
        warn(`toolchain seed: skipped the link ${from} (it resolves outside the seed or into a denied path)`);
      } else await symlink(relative(src, target) || ".", to).catch(keepExisting);
    }
  }
  await chmod(dest, ((await stat(dest)).mode & 0o7777) | 0o700);
}

function keepExisting(e: NodeJS.ErrnoException): void {
  if (e.code !== "EEXIST") throw e;
}
