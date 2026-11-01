// The supervisor's state for the status page: read from `<state_dir>/supervisor.json` (written by the
// git-worktree updater). Tells the owner why no new runs start during an update, and when changed code and
// settings take effect.

import { readFile } from "node:fs/promises";
import type { SupervisorStatus } from "../interfaces/updater.js";

/** What the page shows: the file's status, or null when there is none (not started with `factory dev`). */
export type FactoryStatus = SupervisorStatus & {
  /** `workers` in factory.config.json as this page read it. */
  workers: number;
};

/** Reads the status file. A child pid that is no longer alive means the factory stopped. */
export async function readFactoryStatus(file: string, workers: number, alive = pidAlive): Promise<FactoryStatus | null> {
  let status: SupervisorStatus;
  try {
    status = JSON.parse(await readFile(file, "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
  if (status.state !== "stopped" && status.child_pid !== null && !alive(status.child_pid)) {
    return { ...status, state: "stopped", child_pid: null, workers };
  }
  return { ...status, workers };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
