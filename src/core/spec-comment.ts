import { type CommandState, commandFooter } from "./commands.js";
import type { AddedPath } from "./companions.js";
import { MAX_DECISIONS, type TriageOutput, type TriagePhase } from "./outputs.js";
import { missingValues, specText } from "./given-values.js";
import { inShortParagraphs } from "./pr-body.js";
import type { Tier } from "./types.js";

/** What else fed the effective tier, so a raise above the agent's tier can be explained, and what triage's paths gained. */
export interface TierSources {
  /** Highest floor matched by the allowed paths, if any. */
  floor?: Tier | null;
  /** Tier the work item already had; a tier is never lowered. */
  previous?: Tier | null;
  /** Paths the companion step added to `allowed_paths` (design 04-triage.md), each with the path that caused it. */
  added?: readonly AddedPath[];
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
    `Triage estimates this change at about ${spec.estimated_lines} lines in ${spec.estimated_files} files, too close to the size limits to review in one change.`,
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

/** `2026-11-11 10:00 UTC` from an ISO time (issue #586); the text as is when it is not one. */
export const utcMinute = (iso: string): string => (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso);

/**
 * The footer of a spec auto mode approved (issue #586): a line naming the approval, its tier and its time, then the
 * commands for `s`, the state after the approval. `/approve` is never listed, so no source offers it on this spec.
 */
export function autoApprovedFooter(s: CommandState, tier: Tier, at: string): string {
  return [`Approved automatically (auto mode, tier ${tier}) at ${utcMinute(at)}.`, "", commandFooter(s, ["approve"])].join("\n");
}

/** Done criteria shown before the rest fold into a `<details>` block (issue #229). */
export const VISIBLE_DONE = 10;

/** List lines past the first `n` go in a collapsed block, so a long list stays short to scan. */
function folded(lines: readonly string[], n: number, summary: (rest: number) => string): string[] {
  const out = lines.slice(0, n);
  const rest = lines.slice(n);
  if (rest.length > 0) out.push("", `<details><summary>${summary(rest.length)}</summary>`, "", ...rest, "", "</details>");
  return out;
}

/** `folded` for a bullet list. */
function bulletsFolded(items: readonly string[], n: number, summary: (rest: number) => string): string[] {
  return folded(items.map((c) => `- ${c}`), n, summary);
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
 * How to answer the numbered decisions (issue #527): the reply the command parser reads on an `/approve` from any
 * source, one `N: <answer>` line per decision (src/shared/command-notes.ts), and what an unanswered one takes.
 */
function answerBlock(n: number): string[] {
  return [
    "To answer, reply `/approve` with one `N: <answer>` line per decision. A decision you do not answer takes its default.",
    "",
    "```",
    "/approve",
    ...Array.from({ length: n }, (_, i) => `${i + 1}: <answer>`),
    "```",
  ];
}

/**
 * The request's given values the spec dropped (design 04-agents.md, Given values): what holds a spec for a person's
 * `/approve`. None for an item whose request text was not kept (`issue_text` null).
 */
export const droppedValues = (spec: TriageOutput, request: string | null): string[] => (request === null ? [] : missingValues(request, specText(spec)));

/** The hold line above the footer of a spec that dropped given values: it names each one. */
export const heldNote = (missing: readonly string[]): string =>
  `This spec waits for \`/approve\`, with no automatic or standing approval: the spec drops ${missing.length === 1 ? "a value" : "values"} the request states (${missing.map((v) => `\`${v}\``).join(", ")}).\n\n`;

/** The spec comment's section naming the request's given values the spec dropped (design 04-agents.md, Given values). */
function missingSection(missing: readonly string[]): string[] {
  return [
    "### Values from the request missing in the spec",
    "The request states these exact values, and the spec text does not hold them. Check each one before you `/approve`, or `/revise` to get a spec that keeps them:",
    ...missing.map(code),
  ];
}

/**
 * The triage spec comment a human reads before typing /approve, /reject or /revise (layout issue #229): In
 * short, Problem, Decisions for you, Applied defaults, Done when, scope, Files, Risk. `footer` replaces the default last line;
 * the controller passes the command footer for the spec gate (`commandFooter`). `approved`: the spec was approved with
 * no reply (auto mode, a standing rule, the parent's split), so it has no answer block asking for `/approve` (issue #586).
 * `missing`: the request's given values the spec dropped (`missingValues`), listed in their own section before the footer.
 */
export function renderSpec(
  spec: TriageOutput, tier: Tier, why: TierSources = {}, footer: string = FOOTER, o: { approved?: boolean; missing?: readonly string[] } = {},
): string {
  // The plain AS-IS → TO-BE statement comes first, so the reader has the idea before any file-level detail.
  const out = ["## Factory spec", "", "### In short (AS-IS → TO-BE)", inShortParagraphs(spec.in_short), ""];
  out.push("### Problem", spec.problem, "");
  // The decisions are numbered (issue #526): `/approve` answers decision N with an `N: <answer>` line.
  const decisions = [
    ...(tier > spec.tier ? [`- Tier raised from ${spec.tier} to ${tier} because ${raiseReason(tier, spec.tier, why)}.`] : []),
    ...(spec.decisions ?? []).map((d, i) => `${i + 1}. ${d}`),
  ];
  if (decisions.length > 0) {
    out.push("### Decisions for you", ...folded(decisions, MAX_DECISIONS, (n) => `${n} more`), "");
    if (spec.decisions?.length && !o.approved) out.push(...answerBlock(spec.decisions.length), "");
  }
  // Owner defaults triage applied instead of asking (issue #315): shown apart, so they are not mistaken for questions.
  if (spec.applied_defaults?.length) out.push("### Applied defaults", ...spec.applied_defaults.map((d) => `- ${d}`), "");
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
  // One line per path the companion step added (design 04-triage.md), naming the path that caused it.
  if (why.added?.length) {
    out.push("", "Added by `path_companions`:", ...why.added.map((a) => `- \`${a.path}\`: added because the spec names \`${a.because}\``));
  }
  if (spec.files_to_change.length > 0) out.push("", "Expected to change:", ...spec.files_to_change.map(code));
  out.push("");
  out.push("### Risk", `Tier ${tier}: ${spec.tier_reason}`, "");
  if (spec.phases?.length) out.push(...splitSection(spec, spec.phases), "");
  if (o.missing?.length) out.push(...missingSection(o.missing), "");
  out.push(footer);
  return out.join("\n");
}
