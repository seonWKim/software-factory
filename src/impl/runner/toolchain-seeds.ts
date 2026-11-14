import { chmod, cp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copies each seed folder (`AgentRunSpec.toolchain_seeds`, design 05-sandbox.md) into `dest`, the run's own
 * `<TMPDIR>/toolchain/gradle/wrapper/dists`, before the agent starts. A local recursive copy: never a link (a
 * hardlink would share the owner's inode), links inside resolved to their content, nothing written to the source.
 * Files already in `dest` (an earlier step of the run) are kept. A seed that is not a folder is skipped. The copy's
 * folders are made owner-writable, so the wrapper can write its lock file beside the distribution.
 */
export async function copyToolchainSeeds(seeds: readonly string[], dest: string): Promise<void> {
  for (const seed of seeds) {
    const isDir = await stat(seed).then((s) => s.isDirectory(), () => false);
    if (!isDir) continue;
    await cp(seed, dest, { recursive: true, force: false, errorOnExist: false, dereference: true });
    await ownerWritable(dest);
  }
}

async function ownerWritable(dir: string): Promise<void> {
  await chmod(dir, ((await stat(dir)).mode & 0o7777) | 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await ownerWritable(join(dir, entry.name));
  }
}
