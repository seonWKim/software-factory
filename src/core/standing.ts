// Standing approvals, phase 1 (design 05-standing-approvals): the detail every spec decision records, and a pure
// run check per (gate, tier). Nothing here changes a gate: the check only reports.

import type { Actor, GateOutcome, SpecKind, StandingGate, StateChange, StateChangeDetail, Tier, WorkItem } from "./types.js";
import { SPLIT_APPROVED } from "./split.js";

export const SPEC_GATE: StandingGate = "spec";

/** The state-change reasons that record a human's spec decision, and the outcome of each. */
export const SPEC_DECISIONS: Readonly<Record<string, GateOutcome>> = {
  spec_approved: "approved",
  [SPLIT_APPROVED]: "approved",
  spec_rejected: "rejected",
  spec_revision_requested: "revised",
};

/** The reason whose rows count as a retry: it ends the run of its item's (gate, tier). No row of its own. */
const RETRY = "retry_requested";

/** A phase of a split, a spec that proposes phases, or a single spec. */
export function specKind(it: Pick<WorkItem, "parent_id">, proposesPhases: boolean): SpecKind {
  if (it.parent_id !== null) return "phase";
  return proposesPhases ? "split" : "single";
}

/**
 * Whether the decision changed the spec: a revise always does, an approval only when it widened the allowed
 * paths (`+paths`), a reject never. The same rule reads a stored row (backfill), so old and new rows agree.
 */
export function specChanged(outcome: GateOutcome, patch: { allowed_paths?: unknown } | null | undefined): boolean {
  if (outcome === "revised") return true;
  return outcome === "approved" && patch?.allowed_paths !== undefined;
}

/** The detail fields of a spec decision. IDs and codes only: `owner_id` is a user ID, never a display name. */
export function specDecisionDetail(input: {
  tier: Tier | null;
  kind: SpecKind;
  outcome: GateOutcome;
  spec_changed: boolean;
  actor: Actor;
}): StateChangeDetail {
  return {
    gate: SPEC_GATE,
    tier: input.tier,
    kind: input.kind,
    outcome: input.outcome,
    spec_changed: input.spec_changed,
    owner_id: input.actor.kind === "user" ? input.actor.id : null,
  };
}

/** One decision or retry at a gate, as the run check reads it. */
export interface GateEvent {
  gate: StandingGate;
  tier: Tier;
  outcome: GateOutcome | "retried";
  spec_changed: boolean;
  at: string;
}

/**
 * The gate events of one item's state changes, in their order. A row with the decision detail is read as
 * written; an older row without it is backfilled from its reason, its changes and the item's tier at that row
 * (the last `tier` change before it). A retry counts at the item's tier. A row whose tier is not known is skipped.
 */
export function gateEvents(changes: readonly StateChange[]): GateEvent[] {
  const out: GateEvent[] = [];
  let tier: Tier | null = null;
  for (const c of changes) {
    const before = tier;
    if (c.changes.tier) tier = c.changes.tier.to ?? null;
    const at = c.at as string;
    if (c.reason === RETRY) {
      if (tier !== null) out.push({ gate: SPEC_GATE, tier, outcome: "retried", spec_changed: false, at });
      continue;
    }
    const outcome = SPEC_DECISIONS[c.reason];
    if (!outcome) continue;
    const d = c.detail;
    if (d?.gate === SPEC_GATE && typeof d.tier === "number") {
      out.push({ gate: SPEC_GATE, tier: d.tier as Tier, outcome: d.outcome as GateOutcome, spec_changed: d.spec_changed === true, at });
      continue;
    }
    // Backfill: the tier the spec was decided at, before any raise this row made.
    const decidedAt = before ?? tier;
    if (decidedAt === null) continue;
    out.push({ gate: SPEC_GATE, tier: decidedAt, outcome, spec_changed: specChanged(outcome, c.changes), at });
  }
  return out;
}

/** The run check's answer for one (gate, tier). */
export interface RunCheck {
  gate: StandingGate;
  tier: Tier;
  /** Approvals in a row with the spec unchanged, since the last revise, reject, retry or changed approval. */
  run_length: number;
  reached: boolean;
}

/**
 * The current run per (gate, tier), events taken in time order (ties keep their input order). An approval with
 * the spec unchanged adds one; any other event (a revise, a reject, a retry, an approval that changed the spec)
 * sets it back to 0. `reached`: run_length >= threshold. Sorted by gate, then tier.
 */
export function checkRuns(events: readonly GateEvent[], threshold: number): RunCheck[] {
  const runs = new Map<string, { gate: StandingGate; tier: Tier; run_length: number }>();
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i));
  for (const { e } of ordered) {
    const key = `${e.gate}:${e.tier}`;
    const r = runs.get(key) ?? { gate: e.gate, tier: e.tier, run_length: 0 };
    r.run_length = e.outcome === "approved" && !e.spec_changed ? r.run_length + 1 : 0;
    runs.set(key, r);
  }
  return [...runs.values()]
    .sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : a.tier - b.tier))
    .map((r) => ({ ...r, reached: r.run_length >= threshold }));
}
