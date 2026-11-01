import type { FactoryConfig } from "./config.js";
import type { RunKind, RunOutcome, Tier, WorkItem } from "./types.js";

// Deterministic gate rules (control plane). Same input, same output.

/** Highest floor tier among the floors the allowed paths touch (either path contains the other). */
export function floorTier(paths: readonly string[], floors: FactoryConfig["floors"]): Tier | null {
  let tier: Tier | null = null;
  for (const f of floors) {
    const hit = paths.some((p) => p.startsWith(f.prefix) || f.prefix.startsWith(p.replace(/\*+$/, "")));
    if (hit && (tier === null || f.tier > tier)) tier = f.tier;
  }
  return tier;
}

/** Tier = max(agent judgment, floor, previous). Never lowered (design §3). */
export function effectiveTier(...tiers: (Tier | null | undefined)[]): Tier {
  return tiers.reduce<Tier>((max, t) => (t != null && t > max ? t : max), 1);
}

export function needsSpecApproval(tier: Tier, dials: FactoryConfig["dials"]): boolean {
  return tier >= dials.spec_gate_min_tier;
}

export function canAutoMerge(tier: Tier, dials: FactoryConfig["dials"]): boolean {
  return tier <= dials.auto_merge_max_tier;
}

/** One run per (item, kind, loop, restart): re-enqueueing the same step is a no-op. */
export function runKey(item: Pick<WorkItem, "id" | "loop_count" | "restart_count">, kind: RunKind): string {
  return `${item.id}:${kind}:l${item.loop_count}:r${item.restart_count}`;
}

/**
 * The key of the automatic retry of the run with key `key`: the step's first key plus `:a<n>`, n counting
 * the retries of that step. Derived from the failed run alone, so applying it twice asks for the same key.
 */
export function retryKey(key: string): string {
  const m = key.match(/^(.*):a(\d+)$/);
  return m ? `${m[1]}:a${Number(m[2]) + 1}` : `${key}:a1`;
}

/** Whether two run keys belong to the same step (the same first run and its automatic retries). */
export function sameStep(a: string, b: string): boolean {
  return stepKey(a) === stepKey(b);
}

function stepKey(key: string): string {
  return key.replace(/:a\d+$/, "");
}

/** Wait before retry number `attempt` (1 = first retry): base × 2^(attempt−1), never more than max. */
export function retryDelayMs(attempt: number, base_ms: number, max_ms: number): number {
  return Math.min(max_ms, base_ms * 2 ** Math.max(0, attempt - 1));
}

/**
 * Why a run failed, for the retry budget (design §5 Restarts): a usage or rate limit is not an attempt;
 * infra failures (lease loss, timeout, exception) count toward `max_restart`; anything else is the
 * task's own failure and counts toward `max_attempts`. A run with no outcome (cancelled) is a task failure.
 */
export type FailureClass = "rate_limited" | "infra" | "task";

export function failureClass(outcome: RunOutcome | null): FailureClass {
  if (outcome?.status !== "failed") return "task";
  if (outcome.error_code === RATE_LIMITED) return "rate_limited";
  return outcome.infra ? "infra" : "task";
}

/** The error code of a run stopped by a usage or rate limit. */
export const RATE_LIMITED = "rate_limited";

export function branchFor(item: Pick<WorkItem, "id">, prefix: string): string {
  return `${prefix}${item.id}`;
}

export function workItemIdFromBranch(branch: string, prefix: string): string | null {
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : null;
}

/**
 * A path is covered when it equals an allowed path, or sits under an allowed path that ends in `/`.
 * Shared by triage validation (`files_to_change`) and the pre-push scope gate, so both use one rule.
 */
export function isCovered(path: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => path === a || (a.endsWith("/") && path.startsWith(a)));
}

/**
 * Scope gate (design §4): given the NUL-separated output of
 * `git diff --name-only -z --no-renames <base>...HEAD` and the item's allowed_paths, returns every changed
 * path that no allowed path covers, sorted and without duplicates. Empty means the branch may be pushed.
 * With `--no-renames` a rename shows as a delete of the old path plus an add of the new one, so both are checked.
 */
export function scopeViolations(nameOnlyZ: string, allowed: readonly string[]): string[] {
  const changed = new Set(nameOnlyZ.split("\0").filter((p) => p.length > 0));
  return [...changed].filter((p) => !isCovered(p, allowed)).sort();
}
