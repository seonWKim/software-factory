import type { FactoryConfig } from "./config.js";
import type { RunKind, Tier, WorkItem } from "./types.js";

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

export function branchFor(item: Pick<WorkItem, "id">, prefix: string): string {
  return `${prefix}${item.id}`;
}

export function workItemIdFromBranch(branch: string, prefix: string): string | null {
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : null;
}
