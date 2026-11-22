import type { AppliedRule, RuleVerdict } from "../api.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// What the Rules page's section files share (design 09-dashboard-rules.md): the text styles, the state and verdict
// tables, the group list and the two helpers that more than one section reads. Each is defined here once.

/** Muted text; break-keep keeps a Korean word whole when the line wraps. */
export const muted = "text-xs text-pretty break-keep text-text-2";

/** A rule's state as a key of the one state table (src/shared/states.ts), whose label and tone its pill shows. */
export const RULE_STATE: Readonly<Record<string, string>> = { open: "running", pending: "needs_approval", held: "held" };
/** The reading width of description prose (a group's line, How this works). */
export const PROSE = "max-w-prose";
/** A row's padding, reduced below `sm` so a phone keeps its width for text. */
export const ROW_PAD = "max-sm:p-2";
/** A KeyValue's labels above their values below `sm` (as `stacked`), two columns from `sm` up. */
export const STACK_NARROW = "max-sm:flex max-sm:flex-col max-sm:gap-1";
/** A candidate class (`C-…`) takes the owner's wording as its rule on promote; a structure proposal applies its lines. */
export const isClass = (id: string): boolean => id.startsWith("C-");
export const VERDICTS: readonly { verdict: RuleVerdict; label: MessageKey; variant: "primary" | "secondary" | "danger" }[] = [
  { verdict: "promote", label: "rules.promote", variant: "primary" },
  { verdict: "hold", label: "rules.hold", variant: "secondary" },
  { verdict: "reject", label: "rules.reject", variant: "danger" },
];
/** The two groups, candidates first, each with its line on what promoting one does. */
export const GROUPS: readonly { classes: boolean; title: MessageKey; line: MessageKey }[] = [
  { classes: true, title: "rules.groupClasses", line: "rules.groupClassesLine" },
  { classes: false, title: "rules.groupProposals", line: "rules.groupProposalsLine" },
];
export const CONSEQUENCE: Record<RuleVerdict, MessageKey> = {
  promote: "rules.consequencePromoteProposal",
  hold: "rules.consequenceHold",
  reject: "rules.consequenceReject",
  retire: "rules.consequenceRetire",
};
export const line = "text-sm text-pretty break-words break-keep whitespace-pre-wrap";
export const quote = `${line} border-l-2 border-border-strong pl-2`;
/** Lines of a file, kept as written. */
export const fileLines = "rounded-control bg-surface p-2 font-mono text-xs break-words whitespace-pre-wrap";

/** An applied rule's name, else its default, else "not given". */
export const ruleName = (r: AppliedRule): string => r.name || r.default || t("rules.notGiven");

/** A proposal's kind in plain words: edit-asset, promote-learning and new-asset by name, any other kind "Change"; never the raw kind. */
const KIND_LABEL: Record<string, MessageKey> = {
  "edit-asset": "rules.kindEditAsset",
  "promote-learning": "rules.kindPromoteLearning",
  "new-asset": "rules.kindNewAsset",
};
export const kindLabel = (kind: string): string => t(KIND_LABEL[kind] ?? "rules.kindOther");

/**
 * A target in short, as a file count: a comma-separated list reads "N files", one file "1 file"; no path or file name
 * shows in a row (since 2026-11-22). The full target stays in "Why and where".
 */
export function targetLabel(target: string): string {
  const files = target.split(",").map((f) => f.trim()).filter(Boolean);
  return files.length > 1 ? t("rules.files", { count: files.length }) : t("rules.fileOne");
}

/** A proposal's change line: its kind and target in short; a part the ledger did not list reads "not given". */
export const proposalLine = (kind: string | undefined, target: string | undefined): string =>
  t("rules.whatProposal", { kind: kind === undefined ? t("rules.notGiven") : kindLabel(kind), target: target === undefined ? t("rules.notGiven") : targetLabel(target) });
