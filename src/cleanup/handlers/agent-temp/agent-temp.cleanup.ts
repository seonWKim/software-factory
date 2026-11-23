// The agent runtime's temp folder of a run folder (design 08-cleanup): Claude Code, run in `<worktrees>/sbx_<x>`,
// leaves `<temp root>/<that path, every character but a letter or digit a dash>`. Keyed by the run folder's path:
// while that folder is there the temp folder lives in it (it goes only in a pass that removes the run folder, so
// never while its run runs); once the run folder is gone its run ended, and the temp folder goes when it was not
// used for `cleanup.keep_hours`.

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { folderSize } from "../../folder-size.js";
import { type CleanupEnv, type Resource, defineCleanupHandler } from "../../handler.js";

const KIND = "agent-temp";

/** The name Claude Code gives the temp folder of a working folder: only letters, digits and dashes. */
const tempName = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** The latest change time of the folder and of what is directly in it (ms). */
async function lastUsed(dir: string): Promise<number> {
  let at = (await lstat(dir)).mtimeMs;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const s = await lstat(join(dir, name)).catch(() => null);
    if (s) at = Math.max(at, s.mtimeMs);
  }
  return at;
}

async function list(env: CleanupEnv): Promise<Resource[]> {
  const match = new RegExp(`^${tempName(env.worktreesDir)}-sbx-([0-9a-f]{8})$`);
  const runFolders = new Set(await readdir(env.worktreesDir).catch(() => [] as string[]));
  const out: Resource[] = [];
  for (const root of env.agentTempRoots) {
    for (const name of (await readdir(root).catch(() => [] as string[])).sort()) {
      const hex = match.exec(name)?.[1];
      const path = join(root, name);
      if (!hex || !(await lstat(path).catch(() => null))?.isDirectory()) continue;
      const runFolder = join(env.worktreesDir, `sbx_${hex}`);
      const base = { kind: KIND, key: path, label: `agent temp folder ${path}`, item_id: null, data: { path, run_folder: runFolder } };
      if (runFolders.has(`sbx_${hex}`)) out.push({ ...base, unowned: "kept with its run folder", parent: runFolder });
      else out.push({ ...base, idle_since: await lastUsed(path) });
    }
  }
  return out;
}

export default defineCleanupHandler({
  name: KIND,
  order: 15,
  list,
  accepts: (r) => r.kind === KIND && typeof r.data.path === "string" && typeof r.data.run_folder === "string",
  keep: async () => null,
  async cleanup(r, env) {
    const path = String(r.data.path);
    const bytes = await folderSize(env, path);
    await rm(path, { recursive: true });
    return { bytes };
  },
});
