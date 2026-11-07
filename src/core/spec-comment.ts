import { MAX_DECISIONS, type TriageOutput, type TriagePhase } from "./outputs.js";
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

/** The phases of a split spec, in order (design 2026-11-01). Only a spec with phases has this section. */
function splitSection(spec: TriageOutput, phases: TriagePhase[]): string[] {
  const out = [
    "### Split into phases",
    `Triage estimates this change at about ${spec.estimated_lines} lines in ${spec.estimated_files} files, too close to the size limits to review in one pull request.`,
    `\`/approve\` files one sub-issue per phase, in this order, each linked to this issue. Each phase after the first waits until the one before it is closed as completed. Each phase gets its own spec and its own \`/approve\`. This issue closes as completed when the last phase does.`,
  ];
  phases.forEach((p, i) => {
    out.push(
      "",
      `#### Phase ${i + 1} of ${phases.length}: ${p.title}`,
      p.problem,
      "",
      "Done when:",
      ...p.done_criteria.map((c) => `- ${c}`),
      "",
      "Allowed to change:",
      ...p.allowed_paths.map(code),
    );
  });
  return out;
}

/** Done criteria shown before the rest fold into a `<details>` block (issue #229). */
export const VISIBLE_DONE = 10;

/** Items past the first `n` go in a collapsed block, so a long list stays short to scan. */
function bulletsFolded(items: readonly string[], n: number, summary: (rest: number) => string): string[] {
  const out = items.slice(0, n).map((c) => `- ${c}`);
  const rest = items.slice(n);
  if (rest.length > 0) out.push("", `<details><summary>${summary(rest.length)}</summary>`, "", ...rest.map((c) => `- ${c}`), "", "</details>");
  return out;
}

const words = (t: string): string[] => t.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];

/** True when `desired_output` says little the done criteria do not: most of its words are already there. */
export function repeatsDone(desired: string, done: readonly string[]): boolean {
  const own = words(desired);
  if (own.length === 0) return true;
  const known = new Set(words(done.join(" ")));
  return own.filter((w) => known.has(w)).length / own.length >= 0.7;
}

/**
 * The triage spec comment a human reads before typing /approve, /reject or /revise (layout issue #229): In
 * short, Problem, Decisions for you, Done when, scope, Files, Risk. `footer` replaces the default last line;
 * the controller passes the command footer for the spec gate (`commandFooter`).
 */
export function renderSpec(spec: TriageOutput, tier: Tier, why: TierSources = {}, footer: string = FOOTER): string {
  // The plain AS-IS → TO-BE statement comes first, so the reader has the idea before any file-level detail.
  const out = ["## Factory spec", "", "### In short (AS-IS → TO-BE)", spec.in_short.trim(), ""];
  out.push("### Problem", spec.problem, "");
  const decisions = [
    ...(tier > spec.tier ? [`Tier raised from ${spec.tier} to ${tier} because ${raiseReason(tier, spec.tier, why)}.`] : []),
    ...(spec.decisions ?? []),
  ];
  if (decisions.length > 0) {
    out.push("### Decisions for you", ...bulletsFolded(decisions, MAX_DECISIONS, (n) => `${n} more`), "");
  }
  out.push("### Done when", ...bulletsFolded(spec.done_criteria, VISIBLE_DONE, (n) => `${n} more done criteria`), "");
  if (!repeatsDone(spec.desired_output, spec.done_criteria)) {
    out.push("<details><summary>What the PR contains</summary>", "", spec.desired_output, "", "</details>", "");
  }
  if (spec.in_scope && spec.out_of_scope) {
    if (spec.in_scope.length > 0) out.push("### In scope", ...spec.in_scope.map((c) => `- ${c}`), "");
    out.push("### Out of scope", ...(spec.out_of_scope.length > 0 ? spec.out_of_scope.map((c) => `- ${c}`) : ["- (nothing named)"]), "");
  } else {
    // An older triage output: one scope text with both sides.
    out.push("### Scope", spec.scope, "");
  }
  out.push("### Files", "Allowed to change:", ...spec.allowed_paths.map(code));
  if (spec.files_to_change.length > 0) out.push("", "Expected to change:", ...spec.files_to_change.map(code));
  out.push("");
  out.push("### Risk", `Tier ${tier}: ${spec.tier_reason}`, "");
  if (spec.phases?.length) out.push(...splitSection(spec, spec.phases), "");
  out.push(footer);
  return out.join("\n");
}
