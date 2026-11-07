import type { TriagePhase } from "./outputs.js";
import type { SourceRef, StateChangeDetail, WorkItemId } from "./types.js";

// Split specs (design 2026-11-01): when triage estimates a change near the size caps, it proposes 2 to 4
// ordered phases. On /approve the factory files one sub-issue per phase; each later phase is held until the
// one before it closes as completed. Pure: the controller does the I/O.

/**
 * The split threshold, in percent of either cap: an estimate over this share of `max_diff_lines` or of
 * `max_diff_files` must come with phases. The one place it is defined; change it here.
 */
export const SPLIT_PERCENT = 85;
export const MIN_PHASES = 2;
export const MAX_PHASES = 4;

/** blocked_reason (with `blocked_on: upstream`, stage NEW) of a phase waiting for the phase before it. */
export const PHASE_HOLD = "phase_hold";
/** blocked_reason (with `blocked_on: upstream`, stage READY) of a split parent whose phases are filed and open. */
export const PHASES_OPEN = "phases_open";
/** State change reason on the parent when /approve filed every phase; its detail lists them. */
export const SPLIT_APPROVED = "split_approved";

export interface SplitLimits {
  max_diff_lines: number;
  max_diff_files: number;
}

export interface SizeEstimate {
  estimated_lines: number;
  estimated_files: number;
}

/** The line and file counts above which an estimate needs a split: SPLIT_PERCENT of each cap, rounded down. */
export function splitThresholds(limits: SplitLimits): { lines: number; files: number } {
  return {
    lines: Math.floor((limits.max_diff_lines * SPLIT_PERCENT) / 100),
    files: Math.floor((limits.max_diff_files * SPLIT_PERCENT) / 100),
  };
}

/** Whether the estimate is over the threshold of either cap. Exactly at the threshold does not split. */
export function needsSplit(est: SizeEstimate, limits: SplitLimits): boolean {
  const t = splitThresholds(limits);
  return est.estimated_lines > t.lines || est.estimated_files > t.files;
}

/** Why a triage output breaks the split rule, or null when it keeps it. */
export function splitError(est: SizeEstimate, phases: number, limits: SplitLimits): string | null {
  if (!needsSplit(est, limits)) return null;
  if (phases >= MIN_PHASES && phases <= MAX_PHASES) return null;
  const t = splitThresholds(limits);
  return (
    `the estimate (${est.estimated_lines} lines, ${est.estimated_files} files) is over ${SPLIT_PERCENT}% of a cap ` +
    `(${t.lines} lines or ${t.files} files), so it needs ${MIN_PHASES} to ${MAX_PHASES} phases; it has ${phases}`
  );
}

/**
 * The marker a phase's sub-issue body carries: unique per (parent item, phase number), so filing again finds
 * the issue already filed instead of filing a second one.
 */
export function phaseMarker(parent: WorkItemId, index: number): string {
  return `<!-- factory:phase:${parent}:${index} -->`;
}

/** Any phase marker. Intake leaves an issue carrying one to the split that filed it. */
export const PHASE_MARKER = /<!-- factory:phase:[^\s>]+:\d+ -->/;

/** `#163` for `owner/repo#163`: GitHub links it in the same repo. Any other id stays as it is. */
function issueRef(ref: SourceRef): string {
  const i = ref.id.lastIndexOf("#");
  return i >= 0 ? ref.id.slice(i) : ref.id;
}

/** The text of a phase's sub-issue (the source appends the marker). The phase becomes an ordinary work item. */
export function phaseIssueBody(p: {
  parent: SourceRef;
  phase: TriagePhase;
  index: number;
  total: number;
  depends_on: SourceRef | null;
}): string {
  const wait = p.depends_on
    ? `It waits for ${issueRef(p.depends_on)}: the factory holds it until that phase is closed as completed.`
    : "It is the first phase, so it starts at once.";
  return [
    "## In short",
    "",
    `Phase ${p.index} of ${p.total}. ${firstSentence(p.phase.problem)}`,
    "",
    `Part of ${issueRef(p.parent)}, filed by the factory when the split spec was approved. ${wait}`,
    "",
    "### Problem",
    p.phase.problem,
    "",
    "### Done when",
    ...p.phase.done_criteria.map((c) => `- ${c}`),
    "",
    "### Allowed paths",
    ...p.phase.allowed_paths.map((a) => `- \`${a}\``),
  ].join("\n");
}

/** The first sentence of `text` (up to its first ". " or line break), or the whole first line. */
function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const end = line.search(/\.\s/);
  return end >= 0 ? line.slice(0, end + 1) : line;
}

/** The issue title of a phase. A "Phase N:" (or "Phase N/M:") the model already wrote is dropped, so it never repeats. */
export function phaseTitle(index: number, total: number, title: string): string {
  return `Phase ${index}/${total}: ${title.replace(/^\s*phase\s+\d+(?:\s*\/\s*\d+)?\s*[:.\-–]\s*/i, "")}`;
}

/**
 * What a phase's intake row records (state change detail), for the audit trail: its parent, its place, the phase
 * it waits for. The controller reads the link from the work item's own `parent_id` and `phase` columns.
 */
export interface PhaseLink {
  parent_work_item_id: string;
  phase: number;
  phases: number;
  /** The source id of the phase before it; null for the first phase. */
  depends_on: string | null;
}

export function phaseLinkDetail(l: PhaseLink): StateChangeDetail {
  return { parent_work_item_id: l.parent_work_item_id, phase: l.phase, phases: l.phases, depends_on: l.depends_on };
}

/** The source ids of a split parent's phases, in order, from its `split_approved` detail. */
export function parseSubIssues(d: StateChangeDetail | null | undefined): string[] | null {
  if (!d || typeof d.sub_issues !== "string") return null;
  try {
    const v: unknown = JSON.parse(d.sub_issues);
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

/** The line and file counts in the size gate's failure detail (`sizeDetail`), or null when it has none. */
export function parseSizeDetail(detail: string): { lines: number; files: number } | null {
  const m = /changes (\d+) lines\b[\s\S]*?\bin (\d+) files\b/.exec(detail);
  return m ? { lines: Number(m[1]), files: Number(m[2]) } : null;
}

export interface SuggestedPhase extends TriagePhase {
  estimated_lines: number;
  estimated_files: number;
}

/**
 * A split built from a diff that was too large: its size and the paths it touched, never the code. The phase
 * count is what brings each phase under the threshold (2 to 4); paths are grouped by folder, folders stay
 * together, and the groups are cut into contiguous phases of about the same number of paths. Lines are shared
 * out by path count, so they are a rough guide. Empty when there are fewer than two paths to split.
 */
export function suggestSplit(diff: { lines: number; files: number; paths: readonly string[] }, limits: SplitLimits): SuggestedPhase[] {
  const paths = [...new Set(diff.paths)].sort();
  if (paths.length < MIN_PHASES) return [];
  const t = splitThresholds(limits);
  const need = Math.ceil(Math.max(diff.lines / Math.max(1, t.lines), diff.files / Math.max(1, t.files)));
  const byFolder = new Map<string, string[]>();
  for (const p of paths) {
    const key = p.endsWith("/") ? p : p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : p;
    byFolder.set(key, [...(byFolder.get(key) ?? []), p]);
  }
  let groups = [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (groups.length < MIN_PHASES) groups = paths.map((p) => [p, [p]]);
  const n = Math.min(Math.max(need, MIN_PHASES), MAX_PHASES, groups.length);

  // Contiguous cut: close a phase once it reaches its share, leaving at least one group per later phase.
  const bins: [string, string[]][][] = [];
  let current: [string, string[]][] = [];
  let taken = 0;
  groups.forEach((g, i) => {
    current.push(g);
    taken += g[1].length;
    const left = groups.length - i - 1;
    const binsLeft = n - bins.length - 1;
    if (binsLeft > 0 && (taken >= (paths.length * (bins.length + 1)) / n || left === binsLeft)) {
      bins.push(current);
      current = [];
    }
  });
  if (current.length > 0) bins.push(current);

  return bins.map((bin, i) => {
    const own = bin.flatMap(([, ps]) => ps);
    const share = own.length / paths.length;
    const folders = bin.map(([k]) => k);
    const name = folders.length <= 3 ? folders.join(", ") : `${folders.slice(0, 3).join(", ")} and ${folders.length - 3} more`;
    const estimated_lines = Math.round(diff.lines * share);
    const estimated_files = Math.round(diff.files * share);
    return {
      title: `Part ${i + 1} of ${bins.length}: ${name}`,
      problem:
        `Part ${i + 1} of ${bins.length} of a change that was too large to review (${diff.lines} lines in ${diff.files} files). ` +
        `This part changes only the paths below, about ${estimated_lines} lines in ${estimated_files} files.`,
      done_criteria: [
        "Only the paths of this part change, and the change is under max_diff_lines and max_diff_files on its own.",
        "The tests pass with this part merged and the later parts not merged yet.",
      ],
      allowed_paths: own,
      estimated_lines,
      estimated_files,
    };
  });
}
