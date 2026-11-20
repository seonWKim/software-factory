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

/** A probe pause in effect (design §5 Restarts): `model_stall` with its next probe, or `network`. Instants as stored (ISO). */
interface ProbePause {
  kind: "model" | "network";
  since: string;
  next: string | null;
}

async function probePauses(store: Pick<FactoryStore, "getClaimPause">): Promise<ProbePause[]> {
  const [since, next, network] = await Promise.all([
    store.getClaimPause("model_stall_since"),
    store.getClaimPause("model_stall"),
    store.getClaimPause("network_since"),
  ]);
  return [
    ...(since === null || next === null ? [] : [{ kind: "model" as const, since, next }]),
    ...(network === null ? [] : [{ kind: "network" as const, since: network, next: null }]),
  ];
}

/** Each probe pause's sentence with no time in it (the time is a field, or the CLI adds it in local time). */
const PAUSE_TEXT = { model: "agents paused: model not answering", network: "agents paused: network not reachable" } as const;
const NETWORK_TAIL = "runs start again once a probe passes";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An ISO instant in this process's time zone with its offset, `2026-11-20 01:11 +09:00` (the CLI's form); the text as is when it is not one. */
export function localWithOffset(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ` +
    `${off < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * The probe pause lines for `factory status` (design §5 Restarts), one per pause in effect, else null, each time in
 * local time with its offset: `agents paused: model not answering since <time>, next probe at <time>` for
 * `model_stall`, `agents paused: network not reachable since <time>; runs start again once a probe passes` for
 * `network`. `factory status` prints them above the item table.
 */
export async function modelStallLine(store: Pick<FactoryStore, "getClaimPause">): Promise<string | null> {
  const lines = (await probePauses(store)).map((p) =>
    p.kind === "model"
      ? `${PAUSE_TEXT.model} since ${localWithOffset(p.since)}, next probe at ${localWithOffset(p.next!)}`
      : `${PAUSE_TEXT.network} since ${localWithOffset(p.since)}; ${NETWORK_TAIL}`);
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

/**
 * The probe pauses as failing checks, one each, for the dashboard's health checks; none without a probe pause. The
 * sentence has no time: `since` and `next` carry the instants, which Health shows in the viewer's local time.
 */
export async function modelStallChecks(store: Pick<FactoryStore, "getClaimPause">): Promise<Check[]> {
  return (await probePauses(store)).map((p) =>
    p.kind === "model"
      ? { ok: false, msg: PAUSE_TEXT.model, since: p.since, next: p.next! }
      : { ok: false, msg: `${PAUSE_TEXT.network}; ${NETWORK_TAIL}`, since: p.since });
}
