import type { AppShell } from "../../../src/interfaces/app-shell.js";
import type { AppDataPaths, ShellConfig, ShellFs } from "./app-data.js";
import type { Fetch } from "./status.js";
import type { Spawn, Supervisor } from "./supervisor.js";
import type { Timers } from "./timers.js";
export declare function runShell(o: {
  home: string;
  fs: ShellFs;
  spawn: Spawn;
  execPath: string;
  env: Record<string, string | undefined>;
  fetch: Fetch;
  defaultCheckout: string;
  makeShell: (config: ShellConfig) => AppShell;
  /** Whether a pid names a live process; default `process.kill(pid, 0)` (attach.js). */
  alive?: (pid: unknown) => boolean;
  timers?: Timers;
}): Promise<{ paths: AppDataPaths; config: ShellConfig; shell: AppShell; supervisor: Supervisor; attached: boolean }>;
