import { join } from "node:path";
import type { WorkerDeps } from "./support.js";

type Env = Readonly<Record<string, string>>;
/** The config this needs: whether a `toolchain` block exists, and the denied paths. */
type ToolchainCfg = { readonly toolchain?: unknown; readonly deny_paths: readonly string[] };
/** The caches' overlap rule (`readOnlyOverlaps` in core/config.ts), passed in so both lists share one rule. */
type Overlaps = (paths: readonly string[], denied: readonly string[]) => readonly { path: string; denied: string }[];

/**
 * The warmed Gradle wrapper distribution (design 05-sandbox.md): the folder the warm step fills in the owner's
 * HOME (the worker's tool env), which the runner copies into each run's own `GRADLE_USER_HOME`. Fixed, like
 * `TOOLCHAIN_HOMES`: no config key. Null without a `toolchain` block or a HOME.
 */
function gradleWrapperSource(cfg: ToolchainCfg, toolEnv: Env): string | null {
  return cfg.toolchain && toolEnv.HOME ? join(toolEnv.HOME, ".gradle", "wrapper", "dists") : null;
}

/**
 * Worker startup, with a `toolchain` block: a wrapper source that is, holds or lies inside a `deny_paths` entry
 * fails, naming both paths (the caches' rule). No block: nothing is checked.
 */
export function checkWrapperSource(cfg: ToolchainCfg, toolEnv: Env, overlaps: Overlaps): void {
  const source = gradleWrapperSource(cfg, toolEnv);
  const problems = source ? overlaps([source], cfg.deny_paths) : [];
  if (problems.length > 0) {
    throw new Error(problems.map((o) => `toolchain wrapper distribution ${o.path} overlaps the denied path ${o.denied}`).join("\n"));
  }
}

/**
 * The run spec's `toolchain_seeds`, only with a `toolchain` block: the wrapper source when the run folder has
 * `gradlew` and the source exists (both asked of the sandbox, where the warm step ran), else none, and the run
 * goes on. No block: no field and no check.
 */
export async function wrapperSeedFields(
  cfg: ToolchainCfg,
  d: Pick<WorkerDeps, "sandbox" | "toolEnv">,
  handle: Parameters<WorkerDeps["sandbox"]["exec"]>[0],
  slotEnv: Env,
): Promise<{ toolchain_seeds?: string[] }> {
  if (!cfg.toolchain) return {};
  const source = gradleWrapperSource(cfg, d.toolEnv);
  if (!source) return { toolchain_seeds: [] };
  for (const cmd of [["test", "-f", "gradlew"], ["test", "-d", source]]) {
    if ((await d.sandbox.exec(handle, cmd, { env: { ...d.toolEnv, ...slotEnv } })).exit_code !== 0) return { toolchain_seeds: [] };
  }
  return { toolchain_seeds: [source] };
}
