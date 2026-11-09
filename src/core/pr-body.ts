// The factory's PR description (issue #229): In short → Before you merge → What changed → Tests, built from the
// implementer's summary and lists plus the factory's own checks. Pure, so every push can rebuild it.

import type { Run } from "./types.js";

/** The PR label for missing work, after the status label prefix (`sf: incomplete`). */
export const INCOMPLETE_LABEL_SUFFIX = "incomplete";

export const incompleteLabel = (prefix: string) => `${prefix}${INCOMPLETE_LABEL_SUFFIX}`;

export interface PrBodyInput {
  /** The implementer's summary: an In short section, then what changed. */
  summary: string;
  /** Work the spec asks for that the change does not do; non-empty marks the PR incomplete. */
  missing: readonly string[];
  /** Where the change differs from the spec on purpose. */
  deviations: readonly string[];
  /** The factory's own check lines (checkedLines), the only test claims the body makes. */
  checks: readonly string[];
  /** The issue number the PR closes, or null when the item has none. */
  issue: string | null;
  item_id: string;
  /** Extra "Before you merge" lines the caller knows, e.g. that a human merges it. */
  notes?: readonly string[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const IN_SHORT = /^in short\b/i;
const TESTS = /^(tests?|testing|checks?)\b/i;

interface Section { level: number; title: string; lines: string[] }

// The first TO-BE label (plain or bold) after an AS-IS label, with the whitespace and line breaks before it.
const AS_IS_TO_BE = /(\bAS-IS:[\s\S]*?\S)\s*((?:\*\*)?\bTO-BE:)/i;

/**
 * An In short text with AS-IS and TO-BE as two markdown paragraphs: a blank line before the first TO-BE label that
 * follows an AS-IS label, whether the agent wrote them in one paragraph or on adjacent lines. Nothing else changes.
 */
export function inShortParagraphs(text: string): string {
  return text.trim().replace(AS_IS_TO_BE, "$1\n\n$2");
}

/** The summary split at its headings; text before the first heading is a section with level 0. */
function sections(text: string): Section[] {
  const out: Section[] = [{ level: 0, title: "", lines: [] }];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = HEADING.exec(line);
    if (h) out.push({ level: h[1]!.length, title: h[2]!.trim(), lines: [line] });
    else out.at(-1)!.lines.push(line);
  }
  return out;
}

/**
 * The summary as In short and the rest. A heading named Tests, Testing or Checks is dropped with everything under
 * it: the agent's own test claims are left out, since the factory's checks are what the body reports.
 */
export function splitSummary(summary: string): { in_short: string; rest: string } {
  const all = sections(summary);
  const keep: Section[] = [];
  let skipBelow = 0;
  for (const s of all) {
    if (skipBelow > 0 && s.level > skipBelow) continue;
    skipBelow = 0;
    if (s.level > 0 && TESTS.test(s.title)) {
      skipBelow = s.level;
      continue;
    }
    keep.push(s);
  }
  const i = keep.findIndex((s) => s.level > 0 && IN_SHORT.test(s.title));
  const text = (ss: Section[]) => ss.flatMap((s) => s.lines).join("\n").trim();
  if (i < 0) return { in_short: "", rest: text(keep) };
  const level = keep[i]!.level;
  let end = i + 1;
  while (end < keep.length && keep[end]!.level > level) end++;
  return { in_short: text(keep.slice(i, end)), rest: text([...keep.slice(0, i), ...keep.slice(end)]) };
}

/** The "Before you merge" bullets: missing work, differences from the spec, the caller's notes; or "None". */
export function beforeMerge(i: Pick<PrBodyInput, "missing" | "deviations" | "notes">): string[] {
  const lines = [
    ...i.missing.map((m) => `- **Not done:** ${m}`),
    ...i.deviations.map((d) => `- **Differs from the spec:** ${d}`),
    ...(i.notes ?? []).map((n) => `- ${n}`),
  ];
  return lines.length > 0 ? lines : ["None."];
}

export function prBody(i: PrBodyInput): string {
  const { in_short, rest } = splitSummary(i.summary);
  return [
    ...(in_short ? [inShortParagraphs(in_short), ""] : []),
    "## Before you merge",
    "",
    ...beforeMerge(i),
    "",
    ...(rest ? [rest.match(HEADING) ? rest : `## What changed\n\n${rest}`, ""] : []),
    "## Tests",
    "",
    ...(i.checks.length > 0 ? i.checks : ["No pre-push checks ran."]),
    "",
    ...(i.issue ? [`Closes #${i.issue}`, ""] : []),
    `Work item: \`${i.item_id}\``,
  ].join("\n");
}

/** What a PR body is built from, as the item's last pushing implement run stored it. */
export interface PrNotes {
  summary: string;
  missing: string[];
  deviations: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : []);

/**
 * The newest succeeded implement run's PR notes, or null when none stored them (runs from before issue #229, an
 * adopted PR): the caller then leaves the PR body as it is.
 */
export function lastPrNotes(runs: readonly Run[]): PrNotes | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.kind !== "implement" || r.outcome?.status !== "succeeded") continue;
    const d = r.outcome.data;
    if (typeof d.pr_summary !== "string") continue;
    return { summary: d.pr_summary, missing: strs(d.missing), deviations: strs(d.deviations) };
  }
  return null;
}
