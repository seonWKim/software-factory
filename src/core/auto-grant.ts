// Which paths an implement run's needs-human ask may be granted without the owner (design 05-restarts, 2026-11-15).

import { isGatePath } from "./improver.js";
import { globToRegExp } from "./tools/search-tools.js";

/** Refused by the automatic grant only, at any folder depth; they are not on the shared gate list (GATE_PATHS). */
const AGENT_INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md"];

/** Whether `path` is an agent instructions file or on the gate list: never granted automatically. */
function refused(path: string): boolean {
  return isGatePath(path) || AGENT_INSTRUCTIONS.includes(path.split("/").at(-1)!);
}

/**
 * Whether every asked path is a test file (matched by one of `globs`) and none is on the gate list, CLAUDE.md or
 * AGENTS.md. No paths: false, there is nothing to grant.
 */
export function testPathsOnly(paths: readonly string[], globs: readonly string[]): boolean {
  const res = globs.map(globToRegExp);
  return paths.length > 0 && paths.every((p) => !refused(p) && res.some((re) => re.test(p)));
}
