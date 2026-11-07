import { type FloorHit, diffStat, floorHits, overSizeLimit, sizeDetail } from "./diff-gate.js";
import { scopeViolations } from "./policy.js";
import type { ProjectSettings } from "./settings.js";
import type { Tier } from "./types.js";

// The pre-push diff gates (design §4), one implementation for the worker's implement run and `session finish` (design
// §5, 2026-11-01). Each reads the branch through the caller's trusted git and returns what it found; the caller
// decides what a refusal does. Gates, not dials: the limits are the project's settings, unchanged.

/** One trusted git command in the run folder: its stdout; throws when git fails. */
export type TrustedGit = (args: string[]) => Promise<string>;

/** `git diff --numstat` printed something the size gate cannot read. */
export class NumstatError extends Error {}

/** Scope gate: the changed paths (against `baseSha`, three-dot, renames as delete plus add) `allowed` does not cover. */
export async function scopeGate(git: TrustedGit, baseSha: string, allowed: readonly string[], conflicts: readonly string[] = []): Promise<string[]> {
  return scopeViolations(await git(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`]), allowed, conflicts);
}

/**
 * Size gate then floor check on the branch diff against `baseSha`. `size`: the refusal text, or null within
 * `max_diff_lines` and `max_diff_files`. `floor`: changed paths under a floor above the item's tier, or null.
 */
export async function diffGates(
  git: TrustedGit, baseSha: string, item: { tier: Tier | null }, s: Pick<ProjectSettings, "max_diff_lines" | "max_diff_files" | "floors">,
): Promise<{ size: string | null; floor: FloorHit[] | null; paths: string[] }> {
  const numstat = await git(["diff", "--numstat", "-z", "-M", `${baseSha}...HEAD`]);
  let stat;
  try {
    stat = diffStat(numstat);
  } catch (err) {
    throw new NumstatError(`git diff --numstat: ${err instanceof Error ? err.message : "unparsable"}`);
  }
  const limits = { max_diff_lines: s.max_diff_lines, max_diff_files: s.max_diff_files };
  const hits = floorHits(stat.paths, s.floors, item.tier ?? 1);
  return { size: overSizeLimit(stat, limits) ? sizeDetail(stat, limits) : null, floor: hits.length > 0 ? hits : null, paths: stat.paths };
}
