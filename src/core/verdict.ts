import type { VerdictKind, VerdictSeverity } from "./types.js";

// Pure parser for `/verdict accept|changes|reject <severity> <reason>` (design §4).

/** The kinds a person can type. `reverted` is implicit only (a revert of the merge), so it is not here. */
export type TypedVerdictKind = Exclude<VerdictKind, "reverted">;
export const VERDICT_KINDS: readonly TypedVerdictKind[] = ["accept", "changes", "reject"];
/** Words that mean `accept`. */
export const VERDICT_ALIASES: Readonly<Record<string, TypedVerdictKind>> = { yes: "accept", ok: "accept" };
export const VERDICT_SEVERITIES: readonly VerdictSeverity[] = ["none", "minor", "major", "critical"];
export const VERDICT_USAGE =
  "`/verdict accept|changes|reject <none|minor|major|critical> <reason>` " +
  "(`yes` and `ok` mean `accept`; `accept` may leave out the reason, or both the severity and the reason for severity `none`)";

export interface ParsedVerdict {
  verdict: TypedVerdictKind;
  severity: VerdictSeverity;
  /** The text after the severity, following lines included. Null only for `accept` without one. */
  reason: string | null;
}

export type VerdictParse = { ok: true; value: ParsedVerdict } | { ok: false; refuse: string };

/** `args` is the comment text after `/verdict`, following lines included. */
export function parseVerdict(args: string): VerdictParse {
  const m = /^(\S+)(?:[ \t]+(\S+))?([\s\S]*)$/.exec(args.trim());
  const typed = m?.[1];
  const word = !typed ? undefined
    : (VERDICT_KINDS as readonly string[]).includes(typed) ? (typed as TypedVerdictKind)
    : Object.hasOwn(VERDICT_ALIASES, typed) ? VERDICT_ALIASES[typed] : undefined;
  if (!m || !word) return { ok: false, refuse: `the expected format is ${VERDICT_USAGE}` };
  const severity = m[2];
  const rest = (m[3] ?? "").trim();
  // `/verdict accept` alone (or `yes`, `ok`): severity none, no reason.
  if (!severity && !rest && word === "accept") return { ok: true, value: { verdict: "accept", severity: "none", reason: null } };
  if (!severity) return { ok: false, refuse: `the expected format is ${VERDICT_USAGE}` };
  if (!(VERDICT_SEVERITIES as readonly string[]).includes(severity)) {
    return { ok: false, refuse: `severity \`${severity}\` is not one of ${VERDICT_SEVERITIES.map((s) => `\`${s}\``).join(", ")}` };
  }
  if (!rest && word !== "accept") return { ok: false, refuse: `\`${word}\` needs a reason after the severity` };
  return { ok: true, value: { verdict: word, severity: severity as VerdictSeverity, reason: rest || null } };
}
