import type { AppliedRule, RuleVerdict } from "../api.js";
import { READ_WIDTH } from "../components/ui/card.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// What the Rules page's section files share (design 09-dashboard-rules.md): the text styles, the state and verdict
// tables, the group list and the two helpers that more than one section reads. Each is defined here once.

/** Muted text; break-keep keeps a Korean word whole when the line wraps. */
export const muted = "text-xs text-pretty break-keep text-text-2";

/**
 * A waiting entry's state pill, as a key of the one state table (src/shared/states.ts): only `held` has one ("Held").
 * Open and pending entries, and proposed skill drafts, wait for the owner's verdict, which their section already says,
 * so they show none (2026-11-27: an open proposal showed "Running" while nothing ran).
 */
export const waitPill = (state: string): string | null => (state === "held" ? "held" : null);
/** The reading width of description prose (a group's line, How this works): the one intro width, READ_WIDTH. */
export const PROSE = READ_WIDTH;
/** A bordered list of rows. */
export const LIST = "divide-y divide-border rounded-control border border-border";
/**
 * A waiting row's title: the whole text, wrapped, never cut (2026-11-27: a one-line title beside Promote and ⋯ read a
 * dozen characters on a phone); break-keep keeps a Korean word whole, wrap-anywhere breaks an unbroken identifier.
 */
export const WRAP_TITLE = "text-sm font-medium text-pretty break-keep wrap-anywhere";
/** A row's gist: up to two lines, then an ellipsis; the full text in its tooltip. */
export const GIST = "line-clamp-2 max-w-full min-w-0 flex-1 basis-40 wrap-anywhere";
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
/** The two groups, candidates first; what promoting each does is under "How promoting works". */
export const GROUPS: readonly { classes: boolean; title: MessageKey }[] = [
  { classes: true, title: "rules.groupClasses" },
  { classes: false, title: "rules.groupProposals" },
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

/** A path's file name: its last segment ("agent-skills/review/SKILL.md" reads "SKILL.md"). */
const fileName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** A proposal's kind as a sentence about its file: edit-asset and any other kind "Changes", promote-learning "Turns a learning into a rule in", new-asset "Adds"; never the raw kind. */
const KIND_LINE: Record<string, MessageKey> = {
  "edit-asset": "rules.kindEditAsset",
  "promote-learning": "rules.kindPromoteLearning",
  "new-asset": "rules.kindNewAsset",
};

/**
 * A proposal's change line in plain words with its file name (since 2026-11-27, replacing the "N files" count):
 * "Changes rules.md", "Turns a learning into a rule in SKILL.md", "Adds learnings.md"; a target of several files names
 * the first and "and N more"; no target reads "Names no file to change". The full target is the line's tooltip and
 * stays in "Why and where".
 */
export function proposalLine(kind: string | undefined, target: string | undefined): string {
  const files = (target ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return t("rules.kindNoFile");
  const file = files.length > 1 ? t("rules.fileAndMore", { file: fileName(files[0]!), count: files.length - 1 }) : fileName(files[0]!);
  return t(KIND_LINE[kind ?? ""] ?? "rules.kindOther", { file });
}
