// The supervisor's state for the status page: read from `<state_dir>/supervisor.json` (written by the
// git-worktree updater). Tells the owner why no new runs start during an update, and when changed code and
// settings take effect.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { readStoredProject } from "../core/project-labels.js";
import { type UpdateChanges, updateChanges } from "../impl/updater/code-origin.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { ExecResult } from "../interfaces/sandbox.js";
import { CODE_ROOT_ENV, type SupervisorStatus } from "../interfaces/updater.js";
import type { Check } from "../setup.js";

/** What the page shows: the file's status, or null when there is none (not started with `factory dev`). */
export type FactoryStatus = SupervisorStatus & {
  /** `workers` in factory.config.json as this page read it. */
  workers: number;
  /** The commits of `previous_rev..rev` (the dashboard's update note); null or absent: no previous_rev. */
  changes?: UpdateChanges | null;
};

/** Reads the changes of `from..to`. */
type ChangesReader = (from: string, to: string) => Promise<UpdateChanges>;

/** A command in `root` with a 5 s limit, never throwing: a failure is a non-zero exit with no output. */
const execIn = (root: string) => async (cmd: readonly string[]): Promise<ExecResult> => {
  try {
    const r = await promisify(execFile)(cmd[0]!, cmd.slice(1), { cwd: root, timeout: 5000 });
    return { exit_code: 0, signal: null, stdout: r.stdout, stderr: r.stderr, timed_out: false };
  } catch (err) {
    return { exit_code: 1, signal: null, stdout: "", stderr: err instanceof Error ? err.message.slice(0, 300) : "", timed_out: false };
  }
};

/** git in the code root (the updater's runtime copy, as `loadConfig` picks it, else the cwd), cached per pair. */
const codeRootChanges: ChangesReader = updateChanges(execIn(process.env[CODE_ROOT_ENV] ?? process.cwd()));

/** Reads the status file. A child pid that is no longer alive means the factory stopped. */
export async function readFactoryStatus(file: string, workers: number, alive = pidAlive, changes: ChangesReader = codeRootChanges): Promise<FactoryStatus | null> {
  let status: SupervisorStatus;
  try {
    status = JSON.parse(await readFile(file, "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
  const prev = status.previous_rev ?? null;
  const read = { ...status, workers, changes: prev !== null && status.rev !== null ? await changes(prev, status.rev) : null };
  if (status.state !== "stopped" && status.child_pid !== null && !alive(status.child_pid)) {
    return { ...read, state: "stopped", child_pid: null };
  }
  return read;
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
 * answering since <time>, next probe at <time>` for `model_stall`, `agents paused: network not reachable since
 * <time>; runs start again once a probe passes` for `network` (the why-it-waits wording). `factory status` prints
 * them above the item table.
 */
export async function modelStallLine(store: Pick<FactoryStore, "getClaimPause">): Promise<string | null> {
  const [since, next, network] = await Promise.all([
    store.getClaimPause("model_stall_since"),
    store.getClaimPause("model_stall"),
    store.getClaimPause("network_since"),
  ]);
  const lines = [
    ...(since === null || next === null ? [] : [`agents paused: model not answering since ${since}, next probe at ${next}`]),
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

/** The same lines as failing checks, one each, for the dashboard's health checks; none without a probe pause. */
export async function modelStallChecks(store: Pick<FactoryStore, "getClaimPause">): Promise<Check[]> {
  const lines = await modelStallLine(store);
  return lines === null ? [] : lines.split("\n").map((msg) => ({ ok: false, msg }));
}
