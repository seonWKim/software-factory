// `npm run migrate` while `factory dev` runs (design: Self-update): the supervisor is asked to drain every
// child, the steps apply only once none is live, then the supervisor starts the waiting revision (or, when
// the steps failed, the old one again). The handshake is two files in the state dir: the supervisor writes
// supervisor.json, `migrate` writes supervisor-request.json, read and removed on the supervisor's next poll.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "./interfaces/clock.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE, type SupervisorRequest, type SupervisorStatus } from "./interfaces/updater.js";

/** How often `migrate` re-reads supervisor.json while it waits, and how often it says it still waits. */
const READ_MS = 1000;
const PROGRESS_MS = 30_000;

export interface DrainDeps {
  stateDir: string;
  clock: Clock;
  print: (line: string) => void;
  /** Gives up waiting for the drain after this long (run_timeout_ms plus the drain margin). */
  timeoutMs: number;
  /** Whether a pid names a live process. Default: `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readStatus(stateDir: string): Promise<SupervisorStatus | null> {
  try {
    return JSON.parse(await readFile(join(stateDir, SUPERVISOR_STATUS_FILE), "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
}

async function request(stateDir: string, action: SupervisorRequest["action"], clock: Clock): Promise<void> {
  const file = join(stateDir, SUPERVISOR_REQUEST_FILE);
  const body: SupervisorRequest = { action, at: clock.now().toISOString() };
  await writeFile(`${file}.tmp`, `${JSON.stringify(body)}\n`);
  await rename(`${file}.tmp`, file);
}

/** True when supervisor.json names a live supervisor process. */
export async function supervisorLive(stateDir: string, alive: (pid: number) => boolean = defaultAlive): Promise<boolean> {
  const s = await readStatus(stateDir);
  return s !== null && s.state !== "stopped" && typeof s.supervisor_pid === "number" && alive(s.supervisor_pid);
}

/**
 * Runs `apply` with no factory child live. No live supervisor: `apply` runs at once, as with --no-drain.
 * Otherwise: a drain request, a wait (with progress lines) until supervisor.json says migration_ready, then
 * `apply`, then a start request on success or a cancel request on failure. Gives up at the timeout with exit 1
 * and a cancel request, so the old revision starts again. Returns `apply`'s exit code.
 */
export async function withDrain(d: DrainDeps, apply: () => Promise<number>): Promise<number> {
  const alive = d.pidAlive ?? defaultAlive;
  if (!(await supervisorLive(d.stateDir, alive))) return apply();
  d.print("factory dev is running: asking it to drain (in-flight runs finish first)");
  await request(d.stateDir, "drain", d.clock);
  const start = d.clock.now().getTime();
  let said = start;
  for (;;) {
    const s = await readStatus(d.stateDir);
    const requestPending = existsSync(join(d.stateDir, SUPERVISOR_REQUEST_FILE));
    if (!requestPending && s?.state === "migration_ready") break;
    const now = d.clock.now().getTime();
    if (now - start >= d.timeoutMs) {
      d.print(`gave up: the factory did not drain within ${Math.round(d.timeoutMs / 1000)} s; nothing applied`);
      await request(d.stateDir, "cancel", d.clock);
      return 1;
    }
    if (now - said >= PROGRESS_MS) {
      said = now;
      const n = (s?.draining_pids?.length ?? 0) + (s?.child_pid ? 1 : 0);
      d.print(`still waiting for the drain: ${n} process${n === 1 ? "" : "es"} finishing in-flight runs`);
    }
    await d.clock.sleep(READ_MS);
  }
  d.print("drained: no factory process runs; applying the steps");
  const code = await apply();
  await request(d.stateDir, code === 0 ? "start" : "cancel", d.clock);
  d.print(code === 0 ? "steps applied: the factory starts the new revision on its next poll" : "steps failed: the factory starts the old revision again");
  return code;
}
