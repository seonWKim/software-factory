import type { AppliedRule, RuleVerdict } from "../api.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// What the Rules page's section files share (design 09-dashboard-rules.md): the text styles, the state and verdict
// tables, the group list and the two helpers that more than one section reads. Each is defined here once.

export const muted = "text-xs text-pretty text-text-2";

export const STATE_LABEL: Record<string, MessageKey> = { open: "rules.stateOpen", pending: "rules.statePending", held: "rules.stateHeld" };
/** The Badge level of each state, so open, pending and held look different. */
export const STATE_LEVEL: Record<string, string> = { open: "running", pending: "needs_approval" };
/** The page's reading width. */
export const PAGE_WIDTH = "max-w-3xl";
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
export const line = "text-sm text-pretty break-words whitespace-pre-wrap";
export const quote = `${line} border-l-2 border-border-strong pl-2`;
/** Lines of a file, kept as written. */
export const fileLines = "rounded-control bg-surface p-2 font-mono text-xs break-words whitespace-pre-wrap";

/** An applied rule's name, else its default, else "not given". */
export const ruleName = (r: AppliedRule): string => r.name || r.default || t("rules.notGiven");
