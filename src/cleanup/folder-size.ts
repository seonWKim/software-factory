// A folder's size for the history line (design 08-cleanup): the run-folder and agent-temp handlers both report it.

import { baseEnv } from "../impl/process/run-process.js";
import type { CleanupEnv } from "./handler.js";

/** The folder's size in bytes (`du -sk`), or null when it cannot be read. */
export async function folderSize(env: CleanupEnv, dir: string): Promise<number | null> {
  const r = await env.run(["du", "-sk", dir], { cwd: env.worktreesDir, env: baseEnv() }).catch(() => null);
  const kb = r && r.exit_code === 0 ? Number.parseInt(r.stdout, 10) : Number.NaN;
  return Number.isFinite(kb) ? kb * 1024 : null;
}
