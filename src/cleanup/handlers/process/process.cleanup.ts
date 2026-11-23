// Processes a run started that still run (design 08-cleanup, decision 2): dev servers and browsers, found by their
// working folder being inside a run folder of this host. Nothing records which process a run started, so a process
// belongs to the run folder it runs in, and to that folder's item; it is stopped (SIGTERM) only in a pass that also
// removes that folder, so a process outside any removable run folder is never touched.

import { join, sep } from "node:path";
import { type Resource, defineCleanupHandler } from "../../handler.js";

const KIND = "process";

export default defineCleanupHandler({
  name: KIND,
  order: 10,
  async list(env) {
    const out: Resource[] = [];
    for (const p of await env.processes.list()) {
      if (p.pid === process.pid || !p.cwd.startsWith(env.worktreesDir + sep)) continue;
      const folder = p.cwd.slice(env.worktreesDir.length + 1).split(sep)[0]!;
      if (!env.runFolder.test(folder)) continue;
      out.push({
        kind: KIND, key: `pid:${p.pid}`, label: `process ${p.pid} (${p.command}) in ${p.cwd}`,
        // The item is the folder's: the sweep keeps this process unless that folder goes in the same pass.
        item_id: null, unowned: "outside any removable run folder", parent: join(env.worktreesDir, folder),
        data: { pid: p.pid, command: p.command, cwd: p.cwd },
      });
    }
    return out;
  },
  accepts: (r) => r.kind === KIND && typeof r.data.pid === "number",
  keep: async () => null,
  async cleanup(r, env) {
    await env.processes.stop(Number(r.data.pid));
    return { bytes: null };
  },
});
