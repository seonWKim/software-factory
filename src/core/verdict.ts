import type { VerdictKind, VerdictSeverity } from "./types.js";

// Pure parser for `/verdict accept|changes|reject <severity> <reason>` (design §4).

/** The kinds a person can write; `reverted` is implicit only. */
export type ExplicitVerdictKind = Exclude<VerdictKind, "reverted">;

export const VERDICT_KINDS: readonly ExplicitVerdictKind[] = ["accept", "changes", "reject"];
/** Words that mean a kind. */
const VERDICT_ALIASES: Readonly<Record<string, ExplicitVerdictKind>> = { yes: "accept", ok: "accept" };
export const VERDICT_SEVERITIES: readonly VerdictSeverity[] = ["none", "minor", "major", "critical"];
export const VERDICT_USAGE =
  "`/verdict accept|changes|reject <none|minor|major|critical> <reason>` (`yes` and `ok` mean `accept`; " +
  "`accept` may leave out the severity, which is then `none`, and the reason)";

export interface ParsedVerdict {
  verdict: ExplicitVerdictKind;
  severity: VerdictSeverity;
  /** The text after the severity, following lines included. Null only for `accept` without one. */
  reason: string | null;
}

export type VerdictParse = { ok: true; value: ParsedVerdict } | { ok: false; refuse: string };

/** `args` is the comment text after `/verdict`, following lines included. */
export function parseVerdict(args: string): VerdictParse {
  const [, first = "", rest = ""] = /^(\S*)([\s\S]*)$/.exec(args.trim())!;
  const word = VERDICT_ALIASES[first] ?? first;
  if (!(VERDICT_KINDS as readonly string[]).includes(word)) return { ok: false, refuse: `the expected format is ${VERDICT_USAGE}` };
  const verdict = word as ExplicitVerdictKind;
  const m = /^[ \t]+(\S+)([\s\S]*)$/.exec(rest);
  const severity = m?.[1];
  if (severity && (VERDICT_SEVERITIES as readonly string[]).includes(severity)) {
    const reason = m[2]!.trim();
    if (!reason && verdict !== "accept") return { ok: false, refuse: `\`${verdict}\` needs a reason after the severity` };
    return { ok: true, value: { verdict, severity: severity as VerdictSeverity, reason: reason || null } };
  }
  // `accept` alone, or `accept` with a reason and no severity: severity `none`.
  if (verdict === "accept") return { ok: true, value: { verdict, severity: "none", reason: rest.trim() || null } };
  if (!severity) return { ok: false, refuse: `the expected format is ${VERDICT_USAGE}` };
  return { ok: false, refuse: `severity \`${severity}\` is not one of ${VERDICT_SEVERITIES.map((s) => `\`${s}\``).join(", ")}` };
}
