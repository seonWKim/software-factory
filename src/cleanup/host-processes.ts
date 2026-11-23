// This host's process table for the process handler (design 08-cleanup): every process's working folder from
// `lsof -d cwd` (macOS and Linux), stopped with SIGTERM. A host without lsof lists none, so nothing is stopped.

import type { CommandRunner } from "../interfaces/updater.js";
import { baseEnv } from "../impl/process/run-process.js";
import type { HostProcess, ProcessTable } from "./handler.js";

/** Parses `lsof -F pcn` output: `p<pid>`, `c<command>`, then `n<path>` per process. */
export function parseLsofCwd(out: string): HostProcess[] {
  const found: HostProcess[] = [];
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) [pid, command] = [Number.parseInt(line.slice(1), 10), ""];
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n") && pid > 0) found.push({ pid, command, cwd: line.slice(1) });
  }
  return found;
}

export function hostProcesses(run: CommandRunner, cwd: string): ProcessTable {
  return {
    async list() {
      const r = await run(["lsof", "-n", "-P", "-d", "cwd", "-F", "pcn"], { cwd, env: baseEnv(), timeout_ms: 30_000 }).catch(() => null);
      // lsof exits 1 when some process could not be read; what it printed still holds.
      return r ? parseLsofCwd(r.stdout) : [];
    },
    async stop(pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    },
  };
}
