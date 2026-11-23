// Where the agent runtime keeps its per-run-folder temp folders on this host (design 08-cleanup): Claude Code makes
// `claude-<uid>` under `/tmp` (and under the temp folder it is given), one `-<run folder path with dashes>` each.

import { tmpdir } from "node:os";
import { join } from "node:path";

export function agentTempRoots(): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  return [...new Set([join("/tmp", `claude-${uid}`), join(tmpdir(), `claude-${uid}`)])];
}
