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
  timers?: Timers;
}): { paths: AppDataPaths; config: ShellConfig; shell: AppShell; supervisor: Supervisor };
