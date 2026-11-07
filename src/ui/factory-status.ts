// The supervisor's state for the status page: read from `<state_dir>/supervisor.json` (written by the
// git-worktree updater). Tells the owner why no new runs start during an update, and when changed code and
// settings take effect.

import { readFile } from "node:fs/promises";
import { readStoredProject } from "../core/project-labels.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { SupervisorStatus } from "../interfaces/updater.js";
import type { Check } from "../setup.js";

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

/**
 * The probe pause lines (design §5 Restarts), one per pause in effect, else null: `agents paused: model not
 * answering since <time>` for `model_stall`, `agents paused: network not reachable since <time>; runs start again
 * once a probe passes` for `network` (the why-it-waits wording). `factory status` prints them above the item table.
 */
export async function modelStallLine(store: Pick<FactoryStore, "getClaimPause">): Promise<string | null> {
  const stall = await store.getClaimPause("model_stall_since");
  const network = await store.getClaimPause("network_since");
  const lines = [
    ...(stall === null ? [] : [`agents paused: model not answering since ${stall}`]),
    ...(network === null ? [] : [`agents paused: network not reachable since ${network}; runs start again once a probe passes`]),
  ];
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * A warn while the configured repo's project key is not stored (design 2026-11-07): a first start waits for
 * GitHub to resolve it. None once it is stored. One store read, no forge call.
 */
export async function projectKeyChecks(store: Pick<FactoryStore, "getCursor">, repo: { owner: string; name: string }): Promise<Check[]> {
  if (await readStoredProject(store, repo)) return [];
  return [{ ok: false, warn: true, msg: `project key of ${repo.owner}/${repo.name} not stored yet: the factory waits for GitHub to resolve it (see the GitHub API line)` }];
}

/** The same lines as failing checks, one each, for the dashboard's Health panel; none without a probe pause. */
export async function modelStallChecks(store: Pick<FactoryStore, "getClaimPause">): Promise<Check[]> {
  const lines = await modelStallLine(store);
  return lines === null ? [] : lines.split("\n").map((msg) => ({ ok: false, msg }));
}
