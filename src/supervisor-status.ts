// The one writer of `<state_dir>/supervisor.json`, used by both updaters (git-worktree and none), so the
// status page and `npm run migrate` read one format.

import { rename, writeFile } from "node:fs/promises";
import type { Logger } from "./core/log.js";
import type { SupervisorStatus } from "./interfaces/updater.js";

/** Writes the status file atomically: a temp file, then rename. A failure is logged, never thrown. */
export async function writeSupervisorStatus(file: string, status: SupervisorStatus, log: Logger): Promise<void> {
  try {
    await writeFile(`${file}.tmp`, `${JSON.stringify(status)}\n`);
    await rename(`${file}.tmp`, file);
  } catch (err) {
    log.warn("could not write the supervisor status", { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
  }
}
