// State folders an agent must be able to read (issue #471). With an external config, a relative
// state_dir or worktrees_dir follows the config file's folder; when that folder is also a denied
// path (the secrets folder), the sandbox denies the agents their own worktrees. Refuse at startup.

import { resolve } from "node:path";
import { ConfigKeyError } from "./config-keys.js";
import { isUnder } from "./core/tools/paths.js";

/**
 * Throws one line per setting whose resolved folder is a denied path or inside one. One direction
 * only: a denied path inside state_dir (its db and storage) is expected and allowed.
 */
export function checkStatePaths(dirs: { state_dir: string; worktrees_dir: string }, denyPaths: readonly string[]): void {
  const problems: string[] = [];
  for (const [setting, dir] of Object.entries(dirs)) {
    const denied = denyPaths.map((d) => resolve(d)).find((d) => isUnder(resolve(dir), d));
    if (denied !== undefined) {
      problems.push(
        `${setting} ${dir} is inside the denied path ${denied}, which agents cannot read; ` +
          `set ${setting} to an absolute path outside that folder in factory.config.json`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigKeyError(problems);
}
