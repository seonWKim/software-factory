import { join } from "node:path";
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
      env: baseEnv(),
      runTimeoutMs: c.loaded.config.run_timeout_ms,
    }),
});
