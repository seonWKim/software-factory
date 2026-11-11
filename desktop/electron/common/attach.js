// Before it starts a supervisor, the shell checks whether one already runs for its checkout: two supervisors on
// one state folder would claim the same work and fight over the UI port. A live one is attached to instead.
import { join } from "node:path";

/** How long the dashboard probe waits for an answer. */
export const PROBE_TIMEOUT_MS = 2_000;

/** The supervisor's status file in the checkout's default state folder (`state_dir`, `.factory`). */
export const supervisorStatusFile = (checkout) => join(checkout, ".factory", "supervisor.json");

/** Whether `pid` names a live process: `process.kill(pid, 0)`, where EPERM still means alive. */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Why a supervisor already runs for `checkout`, or null when none does: the status file names a live
 * `supervisor_pid` (the git-worktree updater) or `child_pid` (the none updater writes only that one, its own pid),
 * or the dashboard on `overviewUrl` answers. A missing or unreadable status file and a dashboard
 * that does not answer both mean none.
 */
export async function liveSupervisor({ fs, fetch, checkout, overviewUrl, alive = pidAlive, timeoutMs = PROBE_TIMEOUT_MS }) {
  try {
    const status = JSON.parse(fs.readFileSync(supervisorStatusFile(checkout), "utf8"));
    for (const key of ["supervisor_pid", "child_pid"]) {
      if (alive(status?.[key])) return `${key} ${status[key]} is alive`;
    }
  } catch {
    // No status file, or one being rewritten: the dashboard probe decides.
  }
  try {
    const res = await fetch(overviewUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return `the dashboard at ${overviewUrl} answers`;
  } catch {
    // Not answering: nothing runs there.
  }
  return null;
}
