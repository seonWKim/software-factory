// Helpers several commands share.

import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { type Loaded, build } from "../compose.js";
import type { CliEnvironment } from "../core/local-cli.js";

/** Aborts on SIGINT or SIGTERM. */
export function stopOnSignals(): AbortSignal {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  return stop.signal;
}

/** Controller and/or worker in this process until `signal` aborts. */
export async function runLoops(loaded: Loaded, cmd: "dev" | "controller" | "worker", signal: AbortSignal): Promise<void> {
  const app = await build(loaded, { signal });
  const loops = [];
  if (cmd !== "worker") loops.push(app.controller.run(signal));
  if (cmd !== "controller") loops.push(app.worker.run(signal));
  await Promise.all(loops);
  await app.close();
}

/** What the environment says about the operator (issue #318): git's user.email in the repo, then the OS user. */
export async function cliEnvironment(root: string): Promise<CliEnvironment> {
  let gitEmail: string | null = null;
  try {
    const r = await promisify(execFile)("git", ["config", "user.email"], { cwd: root, timeout: 5000 });
    gitEmail = r.stdout.trim() || null;
  } catch {
    gitEmail = null;
  }
  let osUser: string | null = null;
  try {
    osUser = userInfo().username || null;
  } catch {
    osUser = process.env.USER || process.env.USERNAME || null;
  }
  return { gitEmail, osUser };
}
