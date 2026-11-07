// The supervisor's state for the status page: read from `<state_dir>/supervisor.json` (written by the
// git-worktree updater). Tells the owner why no new runs start during an update, and when changed code and
// settings take effect.

import { readFile } from "node:fs/promises";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { SupervisorStatus } from "../interfaces/updater.js";
import type { Check } from "../setup.js";

/**
 * What the page shows: the file's status, or null when there is none (not started with `factory dev`).
 * `migration_pending` is shown to the page as `building` (the old revision keeps running, the new one waits)
 * with `banner` set to the full text, `migrationPendingBanner`, until the page renders `banner` itself.
 */
export type FactoryStatus = Omit<SupervisorStatus, "state"> & {
  state: Exclude<SupervisorStatus["state"], "migration_pending">;
  /** `workers` in factory.config.json as this page read it. */
  workers: number;
  /** The banner text when the state has one of its own (migration_pending), else absent. */
  banner?: string;
};

const short = (rev: string | null | undefined) => (rev ? rev.slice(0, 7) : "unknown");

/**
 * The banner while a new revision waits for its schema or data steps:
 * "Update to <new> waits for `npm run migrate` (pending: <steps>). Still running <old> with its settings."
 */
export function migrationPendingBanner(s: Pick<SupervisorStatus, "rev" | "target_rev" | "pending_steps">): string {
  const steps = s.pending_steps?.length ? s.pending_steps.join(", ") : "checking";
  return `Update to ${short(s.target_rev)} waits for \`npm run migrate\` (pending: ${steps}). Still running ${short(s.rev)} with its settings.`;
}

/** Reads the status file. A child pid that is no longer alive means the factory stopped. */
export async function readFactoryStatus(file: string, workers: number, alive = pidAlive): Promise<FactoryStatus | null> {
  let status: SupervisorStatus;
  try {
    status = JSON.parse(await readFile(file, "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
  if (status.state === "migration_pending") {
    // The old child may be gone while the steps are applied; the supervisor is what must still be alive.
    const sup = status.supervisor_pid;
    if (typeof sup === "number" && !alive(sup)) return { ...status, state: "stopped", child_pid: null, workers };
    return { ...status, state: "building", banner: migrationPendingBanner(status), workers };
  }
  if (status.state !== "stopped" && status.child_pid !== null && !alive(status.child_pid)) {
    return { ...status, state: "stopped", child_pid: null, workers };
  }
  return { ...status, state: status.state, workers };
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
 * The stall pause line (design §5 Restarts): `agents paused: model not answering since <time>` while the
 * `model_stall` claim pause is in effect, else null. `factory status` prints it above the item table.
 */
export async function modelStallLine(store: Pick<FactoryStore, "getClaimPause">): Promise<string | null> {
  const since = await store.getClaimPause("model_stall_since");
  return since === null ? null : `agents paused: model not answering since ${since}`;
}

/** The same line as a failing check, for the dashboard's Health panel; none without a stall pause. */
export async function modelStallChecks(store: Pick<FactoryStore, "getClaimPause">): Promise<Check[]> {
  const line = await modelStallLine(store);
  return line === null ? [] : [{ ok: false, msg: line }];
}
