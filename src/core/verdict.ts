import type { VerdictKind, VerdictSeverity } from "./types.js";

// Pure parser for `/verdict accept|changes|reject <severity> <reason>` (design §4).

export const VERDICT_KINDS: readonly VerdictKind[] = ["accept", "changes", "reject"];
export const VERDICT_SEVERITIES: readonly VerdictSeverity[] = ["none", "minor", "major", "critical"];
export const VERDICT_USAGE = "`/verdict accept|changes|reject <none|minor|major|critical> <reason>` (the reason is optional for `accept`)";

export interface ParsedVerdict {
  verdict: VerdictKind;
  severity: VerdictSeverity;
  /** The text after the severity, following lines included. Null only for `accept` without one. */
  reason: string | null;
}

export type VerdictParse = { ok: true; value: ParsedVerdict } | { ok: false; refuse: string };

/** `args` is the comment text after `/verdict`, following lines included. */
export function parseVerdict(args: string): VerdictParse {
  const m = /^(\S+)(?:[ \t]+(\S+))?([\s\S]*)$/.exec(args.trim());
  const word = m?.[1];
  const severity = m?.[2];
  if (!word || !severity || !(VERDICT_KINDS as readonly string[]).includes(word)) {
    return { ok: false, refuse: `the expected format is ${VERDICT_USAGE}` };
  }
  if (!(VERDICT_SEVERITIES as readonly string[]).includes(severity)) {
    return { ok: false, refuse: `severity \`${severity}\` is not one of ${VERDICT_SEVERITIES.map((s) => `\`${s}\``).join(", ")}` };
  }
  const reason = (m[3] ?? "").trim();
  if (!reason && word !== "accept") return { ok: false, refuse: `\`${word}\` needs a reason after the severity` };
  return { ok: true, value: { verdict: word as VerdictKind, severity: severity as VerdictSeverity, reason: reason || null } };
}
