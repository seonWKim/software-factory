import type { TriageOutput } from "./outputs.js";
import type { Tier } from "./types.js";

/** What else fed the effective tier, so a raise above the agent's tier can be explained. */
export interface TierSources {
  /** Highest floor matched by the allowed paths, if any. */
  floor?: Tier | null;
  /** Tier the work item already had; a tier is never lowered. */
  previous?: Tier | null;
}

const FOOTER =
  "Reply `/approve` to start implementation, `/reject <reason>` to close, or `/revise <feedback>` to get a new spec.";

function raiseReason(tier: Tier, from: TriageOutput["tier"], why: TierSources): string {
  if (why.floor != null && why.floor === tier) return "a path is under a floor";
  if (why.previous != null && why.previous === tier) {
    return `the work item already had tier ${tier}, and a tier is never lowered`;
  }
  return `factory policy does not allow tier ${from} here`;
}

const code = (p: string): string => `- \`${p}\``;

/**
 * The triage spec comment a human reads before typing /approve, /reject or /revise. `footer` replaces the
 * default last line; the controller passes the command footer for the spec gate (`commandFooter`).
 */
export function renderSpec(spec: TriageOutput, tier: Tier, why: TierSources = {}, footer: string = FOOTER): string {
  // The plain AS-IS → TO-BE statement comes first, so the reader has the idea before any file-level detail.
  const out = ["## Factory spec", "", "### In short (AS-IS → TO-BE)", spec.in_short.trim(), ""];
  if (tier > spec.tier) {
    out.push(
      "### Please check",
      `- Tier raised from ${spec.tier} to ${tier} because ${raiseReason(tier, spec.tier, why)}.`,
      "",
    );
  }
  out.push("### What changes", spec.desired_output, "");
  out.push("### Done when", ...spec.done_criteria.map((c) => `- ${c}`), "");
  out.push("### Not included", spec.scope, "");
  out.push("### Problem", spec.problem, "");
  out.push("### Files", "Allowed to change:", ...spec.allowed_paths.map(code));
  if (spec.files_to_change.length > 0) out.push("", "Expected to change:", ...spec.files_to_change.map(code));
  out.push("");
  out.push("### Risk", `Tier ${tier}: ${spec.tier_reason}`, "");
  out.push(footer);
  return out.join("\n");
}
