// Run folders (design 08-cleanup): each `sbx_<8 hex>` clone in this host's worktrees folder, owned by the item
// whose branch (`<prefix><id>`) it has checked out. A detached folder (a triage run) belongs to no item and stays.
// It goes only when the shared safety check passes: no uncommitted changes, no commits the repository lacks.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { folderSize } from "../../folder-size.js";
import { type Resource, defineCleanupHandler } from "../../handler.js";
import { folderUnsafe } from "../../removal-safety.js";

const KIND = "run-folder";

/** The branch a clone has checked out (from its `.git/HEAD`), or null when detached or unreadable. */
async function checkedOut(dir: string): Promise<string | null> {
  const head = await readFile(join(dir, ".git", "HEAD"), "utf8").catch(() => "");
  return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
}

export default defineCleanupHandler({
  name: KIND,
  order: 20,
  async list(env) {
    const out: Resource[] = [];
    for (const name of (await readdir(env.worktreesDir).catch(() => [] as string[])).sort()) {
      const path = join(env.worktreesDir, name);
      if (!env.runFolder.test(name) || !(await stat(join(path, ".git")).catch(() => null))?.isDirectory()) continue;
      const branch = await checkedOut(path);
      const base = { kind: KIND, key: path, label: `run folder ${path}`, data: { path, branch: branch ?? "" } };
      if (branch === null) out.push({ ...base, item_id: null, unowned: "detached (a triage run): no item branch" });
      else if (!branch.startsWith(env.branchPrefix)) out.push({ ...base, item_id: null, unowned: `on ${branch}, not an item branch` });
      else out.push({ ...base, item_id: branch.slice(env.branchPrefix.length) });
    }
    return out;
  },
  accepts: (r) => r.kind === KIND && typeof r.data.path === "string",
  keep: (r, env) => folderUnsafe(env.run, env.repo, String(r.data.path), true),
  async cleanup(r, env) {
    const path = String(r.data.path);
    const bytes = await folderSize(env, path);
    await rm(path, { recursive: true });
    return { bytes };
  },
});
