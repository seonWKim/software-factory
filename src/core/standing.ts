// Standing approvals (design 05-standing-approvals): the detail every spec decision records, a pure run check per
// (gate, tier), and the pure parts of acting on it: rule IDs, the `/standing` arguments, when a proposal is due and
// which allowed paths a rule never approves. The controller does the reads, writes and posts.

import { floorTier } from "./policy.js";
import type { Floor } from "./settings.js";
import type {
  Actor, GateOutcome, SpecKind, StandingGate, StandingRule, StateChange, StateChangeDetail, Tier, WorkItem,
} from "./types.js";
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

// Acting on the run (phase 2, issue #299).

/** The only tier a rule exists for: a rule never approves a spec above tier 1. */
export const STANDING_TIER: Tier = 1;

/** The state-change reason of a spec a rule approved. Not a human decision, so the run check does not read it. */
export const STANDING_APPROVED = "standing_approved";

/** The rule ID a person types: `<gate>-t<tier>`, e.g. `spec-t1`. */
export function ruleId(gate: StandingGate, tier: Tier): string {
  return `${gate}-t${tier}`;
}

/** The rule an ID names, or null when it names none a rule can exist for (only `spec-t1`). */
export function parseRuleId(id: string): { gate: StandingGate; tier: Tier } | null {
  return id.trim().toLowerCase() === ruleId(SPEC_GATE, STANDING_TIER) ? { gate: SPEC_GATE, tier: STANDING_TIER } : null;
}

/** The actor of an approval by a rule: `standing:<rule-id>`. The owner who turned it on is in the detail. */
export function standingActor(gate: StandingGate, tier: Tier): Actor {
  return { kind: "system", id: `standing:${ruleId(gate, tier)}` };
}

/** What `/standing` asks for: the rules' state, or to accept or decline one rule. */
export type StandingRequest = { action: "show" } | { action: "accept" | "decline"; gate: StandingGate; tier: Tier };

const STANDING_USAGE = "reply `/standing`, `/standing accept <rule>` or `/standing decline <rule>`";

/** The text after `/standing` (first line only), or why it is refused. */
export function parseStanding(text: string): StandingRequest | { refuse: string } {
  const words = (text.split(/\r?\n/)[0] ?? "").trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return { action: "show" };
  const action = words[0]!.toLowerCase();
  if ((action !== "accept" && action !== "decline") || words.length !== 2) return { refuse: STANDING_USAGE };
  const rule = parseRuleId(words[1]!.replace(/^`([^`]*)`$/, "$1"));
  if (!rule) return { refuse: `the only rule is \`${ruleId(SPEC_GATE, STANDING_TIER)}\` (tier ${STANDING_TIER} specs at the spec gate)` };
  return { action, ...rule };
}

/** The rule of (gate, tier) among `rules`, or undefined. */
export function findRule(rules: readonly StandingRule[], gate: StandingGate, tier: Tier): StandingRule | undefined {
  return rules.find((r) => r.gate === gate && r.tier === tier);
}

/**
 * The run whose proposal is due now, or null. Due when the run of (spec, STANDING_TIER) equals the threshold (the
 * approval that reached it; later ones are past it), the latest of `own` (the item just decided) is an unchanged
 * approval at that tier, the rule is not on, and it was not declined during this run. A run that resets and
 * reaches the threshold again is due again.
 */
export function dueProposal(
  events: readonly GateEvent[],
  own: readonly GateEvent[],
  threshold: number,
  rule: StandingRule | undefined,
): RunCheck | null {
  const last = own.at(-1);
  if (!last || last.gate !== SPEC_GATE || last.tier !== STANDING_TIER || last.outcome !== "approved" || last.spec_changed) return null;
  const run = checkRuns(events, threshold).find((r) => r.gate === SPEC_GATE && r.tier === STANDING_TIER);
  if (!run || run.run_length !== threshold) return null;
  if (rule?.enabled) return null;
  if (rule && rule.updated_at >= runStart(events, SPEC_GATE, STANDING_TIER)) return null;
  return run;
}

/** When the current run of (gate, tier) started: the time of its first approval, or "" when it has none. */
function runStart(events: readonly GateEvent[], gate: StandingGate, tier: Tier): string {
  const own = events.filter((e) => e.gate === gate && e.tier === tier).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let start = "";
  for (const e of own) {
    if (e.outcome === "approved" && !e.spec_changed) start ||= e.at;
    else start = "";
  }
  return start;
}

/**
 * What a rule never approves, by category: the factory's own gates, prompts, permissions, tools and guard
 * settings. Configured floor paths are the sixth category. Repo-relative prefixes; a folder ends in `/`.
 */
export const PROTECTED_PATHS: Readonly<Record<string, readonly string[]>> = {
  gates: [
    "src/controller/", "src/core/policy.ts", "src/core/diff-gate.ts", "src/core/pre-push.ts", "src/core/checks.ts",
    "src/core/merge-check.ts", "src/core/standing.ts", "src/runtime/hooks/",
    // The G1 toolchain check and the PassportToolBroker around every broker; G5 and the passport before a delivery.
    "src/compose.ts", "src/outbound/outbound.ts",
    // The architecture ratchets and their known-violations lists (owner decision 2026-11-09): a folder that holds
    // them (`tests/`) touches the gate list too, so a spec allowing all of `tests/` always needs the owner.
    "tests/architecture/",
  ],
  prompts: ["prompts/", "golden/"],
  permissions: [
    "src/core/authorize.ts", "src/impl/auth/", "src/impl/grant/", ".claude/",
    "src/impl/github/github-auth-provider.ts", "src/impl/github/github.plugin.ts",
    "src/worker/roles/", "src/shared/role.ts", "src/identity/",
  ],
  tools: ["src/core/tools/", "src/impl/broker/", "src/impl/github/github-tool-broker.ts", "src/impl/github/broker.plugin.ts"],
  guard_settings: [
    "factory.config.json", "src/core/config.ts", "src/core/settings.ts", "src/config-keys.ts", "src/plugins.ts",
    "src/impl/egress/", "src/impl/secrets/",
    // Setting descriptors (RFC 0015 M10): tests/architecture/settings-monotonic.test.ts fails on one outside these.
    "src/controller/settings/", "src/guards/settings/", "src/inbound/settings/",
    "src/outbound/settings/", "src/runtime/settings/", "src/state/settings/", "src/worker/settings/",
  ],
};

/**
 * The first protected category `paths` touch, or null. A path touches a prefix the way it touches a floor
 * (`floorTier`): it is under the prefix, or it covers it (`src/` covers `src/impl/grant/`). `floors`: the item's
 * configured floors, the `floor_paths` category.
 */
export function protectedCategory(paths: readonly string[], floors: readonly Floor[]): string | null {
  for (const [category, prefixes] of Object.entries(PROTECTED_PATHS)) {
    if (floorTier(paths, prefixes.map((prefix) => ({ prefix, tier: STANDING_TIER }))) !== null) return category;
  }
  return floorTier(paths, floors) !== null ? "floor_paths" : null;
}
