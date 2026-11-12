import { CLOSED_REFUSAL } from "./commands.js";
import type { VerdictKind, VerdictSeverity, WorkItem } from "./types.js";

// Pure parser for `/verdict accept|changes|reject <severity> <reason>` (design §4), and its closed-item refusal.

/**
 * Why `it` takes no verdict because it is closed: a merged item still takes one, a closed one that was not merged
 * does not. Null when it is open or merged. The verdict unit and `factory verdict` (before any write) both ask it.
 */
export function verdictRefusal(it: Pick<WorkItem, "stage" | "merge_sha" | "change_ref">): string | null {
  if (it.stage !== "CLOSED" || it.merge_sha !== null) return null;
  return it.change_ref === null ? CLOSED_REFUSAL : `${CLOSED_REFUSAL} and its PR was not merged`;
}

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

/**
 * The one-tap verdict buttons on a factory result message (design §4): Good, Bad and Feedback. Good stores `accept`
 * with severity `none`; Bad `changes` with severity `minor` and no reason; Feedback `changes` with severity `none`
 * and the person's text as the reason.
 */
export type VerdictButton = "good" | "bad" | "feedback";
export const VERDICT_BUTTONS: readonly VerdictButton[] = ["good", "bad", "feedback"];
export const VERDICT_BUTTON_LABELS: Readonly<Record<VerdictButton, string>> = { good: "Good", bad: "Bad", feedback: "Feedback" };

/** What a button stores; `text` is the Feedback text (the other buttons take none). */
export function buttonVerdict(b: VerdictButton, text = ""): ParsedVerdict {
  if (b === "good") return { verdict: "accept", severity: "none", reason: null };
  if (b === "bad") return { verdict: "changes", severity: "minor", reason: null };
  return { verdict: "changes", severity: "none", reason: text };
}

/** The button a stored verdict reads as on its message, or null for a kind no button gives. */
export function verdictButtonOf(v: { verdict: VerdictKind; severity: VerdictSeverity; reason: string | null }): VerdictButton | null {
  if (v.verdict === "accept") return "good";
  if (v.verdict !== "changes") return null;
  return v.severity === "none" && v.reason !== null ? "feedback" : "bad";
}

/**
 * The comment id a message's one-tap verdict is stored under: one per message (`button:<channel>:<message ts>`), with
 * the run the message reports when it names one, so a second tap updates the same row.
 */
export function buttonVerdictKey(channel: string, ts: string, run: string | null): string {
  return `button:${channel}:${ts}${run === null ? "" : `:${run}`}`;
}
