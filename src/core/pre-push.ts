import { type DiffLimits, type DiffStat, type FloorHit, diffStat, floorHits, overSizeLimit, sizeDetail } from "./diff-gate.js";
import { scopeViolations } from "./policy.js";
import type { Floor } from "./settings.js";
import type { Tier } from "./types.js";

// The pre-push gates (design §4) in one place, so a worker's implement run and a person's session finish
// (design 2026-11-01) run the same checks on the same git output: scope, then size, then floor. Each step reads
// the branch's cumulative diff against `baseSha` (three-dot, so files only the base changed are left out) through
// `git`, a trusted git call in the run folder that returns stdout and throws on a failed command.

/** A trusted git call in the run folder: stdout, or a throw when git fails. */
export type GitRead = (args: string[]) => Promise<string>;

/** Git printed something the gates cannot read: the caller reports a git failure, never a pass. */
export class PrePushGitError extends Error {}

/**
 * Scope gate: the changed files no allowed path covers, sorted (empty: the scope passes). With `--no-renames` a
 * rename shows as a delete plus an add, so both paths are checked. `conflicts`: files the base merge conflicted
 * in, which pass whatever allowed_paths says (decision changed 2026-11-02).
 */
export async function scopeGate(git: GitRead, baseSha: string, allowed: readonly string[], conflicts: readonly string[] = []): Promise<string[]> {
  const diff = await git(["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`]);
  return scopeViolations(diff, allowed, conflicts);
}

export interface SizeAndFloor {
  stat: DiffStat;
  /** The size gate's detail (both counts and both limits) when the diff is over a limit; null when it passes. */
  oversize: string | null;
  /** The changed paths under a floor above the item's tier; empty when the floors allow the push. */
  floor: FloorHit[];
}

/**
 * Size gate and floor check on the same `git diff --numstat` output. The limits and floors are the item's
 * project's (read by the caller through settingValues); no config turns either off.
 */
export async function sizeAndFloor(
  git: GitRead,
  baseSha: string,
  s: { limits: DiffLimits; floors: readonly Floor[]; tier: Tier | null },
): Promise<SizeAndFloor> {
  const numstat = await git(["diff", "--numstat", "-z", "-M", `${baseSha}...HEAD`]);
  let stat: DiffStat;
  try {
    stat = diffStat(numstat);
  } catch (err) {
    throw new PrePushGitError(`git diff --numstat: ${err instanceof Error ? err.message : "unparsable"}`);
  }
  return {
    stat,
    oversize: overSizeLimit(stat, s.limits) ? sizeDetail(stat, s.limits) : null,
    floor: floorHits(stat.paths, s.floors, s.tier ?? 1),
  };
}
