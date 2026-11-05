import { join } from "node:path";
import { updaterConfig } from "../../core/config.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../../interfaces/updater.js";
import { definePlugin } from "../../plugin-api.js";
import { baseEnv } from "../process/run-process.js";
import { GitWorktreeUpdater } from "./git-worktree.js";

/** The secret file's path (not a secret) when set, so a version's `migrate` reads the same file. */
function migrateEnv(): Record<string, string> {
  const file = process.env.SOFTWARE_FACTORY_SECRETS_FILE;
  return file ? { SOFTWARE_FACTORY_SECRETS_FILE: file } : {};
}

export default definePlugin({
  kind: "updater",
  name: "git-worktree",
  default: true,
  create: (c) =>
    new GitWorktreeUpdater({
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
      // `updater.auto_migrate` (default false): checked here like the other keys' values.
      autoMigrate: updaterConfig(c.loaded.file).auto_migrate,
      migrateEnv: migrateEnv(),
    }),
});
