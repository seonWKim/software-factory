import { join } from "node:path";
import { updaterConfig } from "../../core/config.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../../interfaces/updater.js";
import { definePlugin } from "../../plugin-api.js";
import { baseEnv } from "../process/run-process.js";
import { GitWorktreeUpdater } from "./git-worktree.js";

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
      // The version folder's own `migrate` (the pre-drain check, auto_migrate) finds the secret file as the
      // child does: only its location is passed, never a secret.
      env: baseEnv(secretFileLocation()),
      runTimeoutMs: c.loaded.config.run_timeout_ms,
      statusFile: join(c.loaded.stateDir, SUPERVISOR_STATUS_FILE),
      requestFile: join(c.loaded.stateDir, SUPERVISOR_REQUEST_FILE),
      autoMigrate: updaterConfig((c.loaded.file as unknown as Record<string, unknown>).updater).auto_migrate,
    }),
});

/** Where the secret file is, when the environment moves it: a path, not a secret. */
function secretFileLocation(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["SOFTWARE_FACTORY_SECRETS_FILE", "XDG_CONFIG_HOME"]) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}
