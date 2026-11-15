// Automatic `/retry +paths` for an implement run that asked only for test files (design 05-restarts, 2026-11-15).

import { isGatePath } from "./improver.js";
import { globToRegExp } from "./tools/search-tools.js";
import type { StateChange } from "./types.js";

/** The state change detail key that marks a `/retry +paths` the controller applied itself. */
export const AUTO_GRANT = "auto_grant";
/** At most this many automatic grants per item; a later ask waits on the owner. */
export const MAX_AUTO_GRANTS = 1;
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

/** The automatic grants among an item's stored state changes, oldest first. */
export function autoGrants(changes: readonly Pick<StateChange, "reason" | "detail">[]): Pick<StateChange, "reason" | "detail">[] {
  return changes.filter((c) => c.reason === "retry_requested" && c.detail?.[AUTO_GRANT] === true);
}
