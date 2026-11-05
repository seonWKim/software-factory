// The supervisor's state for the status page: read from `<state_dir>/supervisor.json` (written by the
// git-worktree updater). Tells the owner why no new runs start during an update, and when changed code and
// settings take effect.

import { readFile } from "node:fs/promises";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { SupervisorStatus } from "../interfaces/updater.js";
import type { Check } from "../setup.js";

/** The states the page's banner renders: every written state but migration_pending (see readFactoryStatus). */
export type BannerState = Exclude<SupervisorStatus["state"], "migration_pending">;

/** What the page shows: the file's status, or null when there is none (not started with `factory dev`). */
export type FactoryStatus = Omit<SupervisorStatus, "state"> & {
  state: BannerState;
  /** `workers` in factory.config.json as this page read it. */
  workers: number;
  /** The file said migration_pending: an update waits for `npm run migrate`. `banner` says so. */
  migration_pending?: boolean;
  /** The banner line for states that have one here (migration_pending), else absent. */
  banner?: string;
};

const short = (rev: string | null | undefined) => (rev ? rev.slice(0, 7) : "unknown");

/**
 * The banner for an update that waits for its migration steps (design: Self-update): "Update to <new> waits for
 * `npm run migrate` (pending: <steps>). Still running <old> with its settings." When the check itself failed,
 * the reason replaces the step list; when no child runs (it exited on the pending steps), it says so.
 */
export function migrationPendingBanner(s: Pick<SupervisorStatus, "rev" | "target_rev" | "pending_steps" | "error" | "child_pid">): string {
  const steps = s.pending_steps?.length ? s.pending_steps.join(", ") : s.error ? `check failed: ${s.error}` : "unknown";
  const head = `Update to ${short(s.target_rev)} waits for \`npm run migrate\` (pending: ${steps}).`;
  if (s.child_pid === null && s.rev === s.target_rev) return `${head} No revision is running until the steps are applied.`;
  return `${head} Still running ${short(s.rev)} with its settings.`;
}

/**
 * Reads the status file. A child pid that is no longer alive means the factory stopped. migration_pending is
 * shown as running (the old child still claims) or, with no child, as crashed with the banner as its error,
 * and `banner` carries the full line.
 */
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
  if (status.state === "migration_pending") {
    const banner = migrationPendingBanner(status);
    const state: BannerState = status.child_pid === null ? "crashed" : "running";
    return { ...status, state, ...(state === "crashed" ? { error: banner } : {}), workers, migration_pending: true, banner };
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
