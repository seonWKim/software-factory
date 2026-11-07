import { type FloorHit, diffStat, floorHits, overSizeLimit, sizeDetail } from "./diff-gate.js";
import { scopeViolations } from "./policy.js";
import type { ProjectSettings } from "./settings.js";
import type { Tier } from "./types.js";

// The pre-push diff gates (design §4), one implementation for the worker's implement run and for `session finish`
// (design §5, 2026-11-01). Each reads the branch through `git` (trusted git in the run folder, supplied by the
// caller) and returns what it found; the caller decides what a refusal does (a failed run, or a refused finish).
// Gates, not dials: no config turns them off, and the limits are the project's settings as they are.

/** Runs one trusted git command in the run folder and returns its stdout; throws when git fails. */
export type TrustedGit = (args: string[]) => Promise<string>;

/** `git diff --numstat` printed something the size gate cannot read. */
export class NumstatError extends Error {}

/**
 * Scope gate: every path the branch changes against `baseSha` (three-dot, renames as delete plus add) that
 * `allowed` does not cover, sorted. Empty: in scope. `conflicts`: files the base merge conflicted in; they pass.
 */
export async function scopeGate(git: TrustedGit, baseSha: string, allowed: readonly string[], conflicts: readonly string[] = []): Promise<string[]> {
  const diff = await git(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`]);
  return scopeViolations(diff, allowed, conflicts);
}

export interface DiffGates {
  /** The size gate's refusal (both counts and both limits), or null when the diff is within the limits. */
  size: string | null;
  /** The changed paths under a floor above the item's tier, or null when the floors allow the push. */
  floor: FloorHit[] | null;
  /** Every path the branch changes, sorted. */
  paths: string[];
}

/**
 * Size gate then floor check, on the cumulative branch diff against `baseSha`. `settings`: the item's project
 * settings (`settingValues`), so the limits are exactly the configured `max_diff_lines` and `max_diff_files`.
 * Throws NumstatError when git's numstat output cannot be read.
 */
export async function diffGates(
  git: TrustedGit,
  baseSha: string,
  item: { tier: Tier | null },
  settings: Pick<ProjectSettings, "max_diff_lines" | "max_diff_files" | "floors">,
): Promise<DiffGates> {
  const numstat = await git(["diff", "--numstat", "-z", "-M", `${baseSha}...HEAD`]);
  let stat;
  try {
    stat = diffStat(numstat);
  } catch (err) {
    throw new NumstatError(`git diff --numstat: ${err instanceof Error ? err.message : "unparsable"}`);
  }
  const limits = { max_diff_lines: settings.max_diff_lines, max_diff_files: settings.max_diff_files };
  const size = overSizeLimit(stat, limits) ? sizeDetail(stat, limits) : null;
  const hits = floorHits(stat.paths, settings.floors, item.tier ?? 1);
  return { size, floor: hits.length > 0 ? hits : null, paths: stat.paths };
}
