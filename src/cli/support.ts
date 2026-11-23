// Helpers several commands share.

import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { type CleanupStore, type Loaded, Plugins, build, cleanupReport, hostCleaner } from "../compose.js";
import { cliUserConfig } from "../core/config.js";
import { type CliEnvironment, type CliIdentity, cliIdentity } from "../core/local-cli.js";

/** Aborts on SIGINT or SIGTERM. */
export function stopOnSignals(): AbortSignal {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  return stop.signal;
}

/** The controller and the worker in this process until `signal` aborts. */
export async function runLoops(loaded: Loaded, signal: AbortSignal): Promise<void> {
  const app = await build(loaded, { signal });
  await Promise.all([app.controller.run(signal), app.worker.run(signal)]);
  await app.close();
}

/** What the environment says about the operator (issue #318): git's user.email in the repo, then the OS user. */
export async function cliEnvironment(root: string): Promise<CliEnvironment> {
  let osUser: string | null = null;
  try {
    osUser = userInfo().username || null;
  } catch {
    osUser = process.env.USER || process.env.USERNAME || null;
  }
  return { gitEmail: await gitConfig(root, "user.email"), osUser };
}

/**
 * The identity every CLI command acts as (issue #318), its one way to it: `cli_user` from the config file, else
 * local:<git user.email>, else local:<OS user>, else local:anonymous, from what `env` reads. Throws on a `cli_user` that is no user ID.
 */
export async function loadedIdentity(loaded: Loaded, env: (root: string) => Promise<CliEnvironment> = cliEnvironment): Promise<CliIdentity> {
  return cliIdentity(cliUserConfig(loaded.file), await env(loaded.root));
}

/** git's user.name in the repo: a display name, only the default of setup's name question, never an ID. */
export function gitUserName(root: string): Promise<string | null> {
  return gitConfig(root, "user.name");
}

async function gitConfig(root: string, key: string): Promise<string | null> {
  try {
    const r = await promisify(execFile)("git", ["config", key], { cwd: root, timeout: 5000 });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `factory cleanup` (design 08-cleanup): this host's sweep of closed items' leftovers now, or (`dryRun`) what it would
 * remove and what it keeps, with each reason, changing nothing. Each printed line goes to `print`. Exit 0.
 */
export async function runCleanup(loaded: Loaded, store: CleanupStore, dryRun: boolean, print: (line: string) => void): Promise<number> {
  const cleaner = await hostCleaner(loaded, store, await new Plugins(loaded).clock());
  if (!cleaner.enabled()) {
    print("cleanup: off (cleanup.enabled is false in factory.config.json). Nothing was removed.");
    return 0;
  }
  for (const line of cleanupReport(await cleaner.sweep({ dryRun }), dryRun)) print(line);
  return 0;
}
