import { join } from "node:path";
import { readOnlyOverlaps } from "../core/config.js";
import type { Sandbox, SandboxHandle } from "../interfaces/sandbox.js";

/**
 * The warmed Gradle wrapper distribution (design 05-sandbox.md): the folder the warm step fills in the owner's
 * HOME (the worker's tool env), which the runner copies into each run's own `GRADLE_USER_HOME`. Fixed, like
 * `TOOLCHAIN_HOMES`: no config key. Null when the tool env has no HOME.
 */
export function gradleWrapperSource(toolEnv: Readonly<Record<string, string>>): string | null {
  return toolEnv.HOME ? join(toolEnv.HOME, ".gradle", "wrapper", "dists") : null;
}

/** Startup: a wrapper source that is, holds or lies inside a `deny_paths` entry fails, naming both paths (the caches' rule). */
export function checkWrapperSource(source: string | null, deny_paths: readonly string[]): void {
  const problems = source ? readOnlyOverlaps([source], deny_paths) : [];
  if (problems.length > 0) {
    throw new Error(problems.map((o) => `toolchain wrapper distribution ${o.path} overlaps the denied path ${o.denied}`).join("\n"));
  }
}

/**
 * The run's seeds: the wrapper source when the run folder has `gradlew` and the source exists (both asked of the
 * sandbox, where the warm step ran). Otherwise none, and the run goes on.
 */
export async function wrapperSeeds(
  sandbox: Sandbox,
  handle: SandboxHandle,
  env: Readonly<Record<string, string>>,
  source: string | null,
): Promise<string[]> {
  if (!source) return [];
  for (const cmd of [["test", "-f", "gradlew"], ["test", "-d", source]]) {
    if ((await sandbox.exec(handle, cmd, { env })).exit_code !== 0) return [];
  }
  return [source];
}
