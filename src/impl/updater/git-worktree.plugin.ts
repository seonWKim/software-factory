import { join } from "node:path";
import { autoMigrate } from "./auto-migrate.js";
import { CODE_ROOT_ENV, CONFIG_ENV, type CommandRunner, SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../../interfaces/updater.js";
import { definePlugin } from "../../plugin-api.js";
import { baseEnv } from "../process/run-process.js";
import { GitWorktreeUpdater } from "./git-worktree.js";

/** Where a folder's `factory migrate` runs: the main checkout (the cwd), and the external config if one is used. */
export interface MigrateAt {
  repoPath: string;
  /** Absolute; passed as FACTORY_CONFIG. Null: the folder's own factory.config.json. */
  configFile: string | null;
}

/** Runs a built folder's `factory migrate <args>` against the store, from the main checkout, with the same config as its child. */
function migrateIn(run: CommandRunner, at: MigrateAt, dir: string, args: readonly string[]) {
  return run([process.execPath, "--disable-warning=ExperimentalWarning", join(dir, "dist", "main.js"), "migrate", ...args], {
    cwd: at.repoPath,
    env: { ...baseEnv(), [CODE_ROOT_ENV]: dir, ...(at.configFile ? { [CONFIG_ENV]: at.configFile } : {}) },
    timeout_ms: 600_000,
  });
}

/**
 * The folder's own `migrate --status --json`: its step names, or null when it could not say (an older
 * revision without --json, or a failed read), so the update goes ahead as before.
 */
export async function pendingIn(run: CommandRunner, at: MigrateAt, dir: string): Promise<string[] | null> {
  try {
    const r = await migrateIn(run, at, dir, ["--status", "--json"]);
    if (r.exit_code !== 0) return null;
    const line = r.stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(line) as { pending?: unknown };
    return Array.isArray(parsed.pending) ? parsed.pending.map(String) : null;
  } catch {
    return null;
  }
}

export default definePlugin({
  kind: "updater",
  name: "git-worktree",
  default: true,
  create: (c) => {
    const at: MigrateAt = { repoPath: c.loaded.root, configFile: c.loaded.externalConfig };
    return new GitWorktreeUpdater({
      repoPath: c.loaded.root,
      runtimeDir: join(c.loaded.stateDir, "runtime"),
      stagingDir: join(c.loaded.stateDir, "runtime-next"),
      baseBranch: c.loaded.config.repo.base_branch,
      run: c.run,
      launcher: c.launcher,
      clock: c.clock,
      log: c.log,
      env: baseEnv(),
      runTimeoutMs: c.loaded.config.run_timeout_ms,
      statusFile: join(c.loaded.stateDir, SUPERVISOR_STATUS_FILE),
      requestFile: join(c.loaded.stateDir, SUPERVISOR_REQUEST_FILE),
      pendingMigrations: (dir) => pendingIn(c.run, at, dir),
      applyMigrations: async (dir) => (await migrateIn(c.run, at, dir, ["--no-drain"])).exit_code === 0,
      autoMigrate: autoMigrate(c.loaded.file.updater),
      ...(c.loaded.externalConfig ? { configFile: c.loaded.externalConfig } : {}),
    });
  },
});
