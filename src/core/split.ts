import type { TriagePhase } from "./outputs.js";
import type { Run, SourceRef, StateChangeDetail, WorkItem, WorkItemId } from "./types.js";
import { type SizeCapChanges, itemSizeCaps, sizeCaps } from "./size-cap.js";
import { dependsOnIds, withDependsOn } from "./task-build.js";
export { itemSizeCaps, sizeCaps }; // an item's size caps, for the size readers that import the split rule

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
/**
 * blocked_reason (with `blocked_on: upstream`, stage READY) of a split parent whose /approve claimed the filing:
 * only the approval that moved the parent here files its phases, through outbound. State change reason
 * `split_filing`, detail `comment_id` (the command that claimed it, which keys its filings), `note` and `tag`.
 */
export const SPLIT_FILING = "split_filing";

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
 * Whether a triage answer waits at its own size checkpoint: over the threshold of either cap with no phases. It
 * waits at the spec gate for a person, never approved without one (`phases_auto_approve` included).
 */
export function atSizeCheckpoint(spec: SizeEstimate & { phases?: readonly unknown[] }, limits: SplitLimits): boolean {
  return (spec.phases?.length ?? 0) === 0 && needsSplit(spec, limits);
}

/**
 * The size checkpoint's note above the spec's footer: the estimate, the threshold, and what the owner can reply, with
 * the one-time cap `/approve <why>` stores (`approveOverCapText` with `estimateCap`).
 */
export function sizeCheckpointNote(est: SizeEstimate, limits: SplitLimits): string {
  const t = splitThresholds(limits), sizes = { lines: est.estimated_lines, files: est.estimated_files };
  return (
    `This spec waits for \`/approve\` at the size checkpoint: its estimate (${est.estimated_lines} lines, ${est.estimated_files} files) ` +
    `is over ${SPLIT_PERCENT}% of a cap (${t.lines} lines or ${t.files} files) and it has no phases. ` +
    `${approveOverCapText(sizes, limits, estimateCap(sizes, limits), "implement it as one change")} ` +
    `Or reply \`/revise <feedback>\` to ask for ${MIN_PHASES} to ${MAX_PHASES} phases.`
  );
}

/** Line and file counts: a diff's, or an estimate's. */
export interface Sizes {
  lines: number;
  files: number;
}

/**
 * The one-time cap an over-cap `/approve` at `too_large` proposes for the blocked diff's `sizes` (design 04-split-specs,
 * 2026-11-24): each cap raised just enough that the size is within SPLIT_PERCENT of it, so a rerun's diff has room to
 * differ from the blocked one; never below the cap in force.
 */
export function proposedCap(sizes: Sizes, caps: SplitLimits): SplitLimits {
  const up = (n: number, cap: number) => Math.max(cap, Math.ceil((n * 100) / SPLIT_PERCENT));
  return { max_diff_lines: up(sizes.lines, caps.max_diff_lines), max_diff_files: up(sizes.files, caps.max_diff_files) };
}

/**
 * The one-time cap an over-cap `/approve` at the spec gate stores (design 04-split-specs, 2026-11-24): the estimate
 * itself, each cap never below the cap in force, so the count the estimate is under (often the files) is not lowered.
 */
export function estimateCap(sizes: Sizes, caps: SplitLimits): SplitLimits {
  return { max_diff_lines: Math.max(caps.max_diff_lines, sizes.lines), max_diff_files: Math.max(caps.max_diff_files, sizes.files) };
}

/** What `/approve <why>` does over the caps (`does`): the size, the caps in force and the one-time cap `p` it stores, in one sentence. */
export function approveOverCapText(sizes: Sizes, caps: SplitLimits, p: SplitLimits, does: string): string {
  return (
    `Reply \`/approve <why>\` to ${does} over the cap: ${sizes.lines} lines in ${sizes.files} files against ` +
    `\`max_diff_lines\` = ${caps.max_diff_lines} and \`max_diff_files\` = ${caps.max_diff_files}, with a one-time cap of ` +
    `${p.max_diff_lines} lines and ${p.max_diff_files} files for this item; the note saying why is required.`
  );
}

/** blocked_reason of an item whose implement run's diff was over its caps (the `too_large` phase). */
export const TOO_LARGE = "run_failed:implement:diff_too_large";

/** An `/approve` over the item's caps: where, the size it approves, the caps in force, the project's caps and the proposed one-time cap. */
export interface OverCap {
  at: "spec" | "too_large";
  sizes: Sizes;
  caps: SplitLimits;
  project_cap: SplitLimits;
  one_time_cap: SplitLimits;
}

/**
 * Whether an `/approve` on `it` approves a change over its size caps (design 04-split-specs, 2026-11-24): at `too_large`,
 * the blocked diff's size from its run's failure detail (`{ sizes: null }` when the run recorded none); at the spec gate,
 * a spec at its size checkpoint (`spec`, the latest), its estimate. Null for any other approval. `settings` holds the
 * project's caps; the caps in force are the item's (`sizeCaps` over its state changes, `changes`).
 */
export function overCap(
  it: Pick<WorkItem, "stage" | "blocked_reason">, runs: readonly Run[], changes: SizeCapChanges,
  spec: (SizeEstimate & { phases?: readonly unknown[] }) | null, settings: SplitLimits,
): OverCap | { sizes: null } | null {
  const caps = sizeCaps(changes, settings), project_cap = sizeCaps([], settings);
  const over = (at: OverCap["at"], sizes: Sizes): OverCap =>
    ({ at, sizes, caps, project_cap, one_time_cap: at === "spec" ? estimateCap(sizes, caps) : proposedCap(sizes, caps) });
  if (it.blocked_reason === TOO_LARGE) {
    const run = runs.filter((r) => r.kind === "implement" && r.outcome?.status === "failed" && r.outcome.error_code === "diff_too_large").at(-1);
    const sizes = run?.outcome?.status === "failed" ? parseSizeDetail(run.outcome.detail) : null;
    return sizes ? over("too_large", sizes) : { sizes: null };
  }
  const atGate = it.stage === "READY" && (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions");
  return atGate && spec && atSizeCheckpoint(spec, caps) ? over("spec", { lines: spec.estimated_lines, files: spec.estimated_files }) : null;
}

/**
 * A split's goal lines (`goal_done_when`, design 04-split-specs 2026-11-22): what the whole split must do once its
 * phases merged. Absent or empty is none; otherwise non-empty strings, and only on a spec with `phases` phases.
 */
export function parseGoalLines(v: unknown, phases: number): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return { ok: true, value: undefined };
  if (!Array.isArray(v) || !v.every((l) => typeof l === "string" && l.trim() !== "")) {
    return { ok: false, error: "goal_done_when: must be a list of non-empty strings" };
  }
  if (phases === 0) return { ok: false, error: "goal_done_when: goal lines belong to a split; leave them out of a spec without phases" };
  return { ok: true, value: v as string[] };
}

/** The split comment's lines listing the goal lines in order, after the phase list; none without any. */
export function goalLinesText(goal: readonly string[] | undefined): string[] {
  return goal && goal.length > 0 ? ["", "The whole split is done when:", ...goal.map((g) => `- ${g}`)] : [];
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

/** `#163` for `owner/repo#163`: the forge links it in the same repo. Any other id stays as it is. */
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
export function parseSizeDetail(detail: string): Sizes | null {
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

/**
 * The too_large comment's size section: the over-cap `/approve` with the diff size, the caps and the proposed one-time
 * cap (design 04-split-specs, 2026-11-24), then the suggested split (design 2026-11-01), built from the diff size in the
 * size gate's detail and the paths the item may change, never the code; no agent runs. Empty when the detail has no
 * counts; no split part when there is nothing to split. Ends with a blank line, so the footer follows.
 */
export function suggestedSplit(detail: string, paths: readonly string[], limits: { max_diff_lines: number; max_diff_files: number }): string[] {
  const size = parseSizeDetail(detail);
  if (!size) return [];
  const approve = [approveOverCapText(size, limits, proposedCap(size, limits), "run the implementer again on the same spec"), ""];
  const phases = suggestSplit({ ...size, paths }, limits);
  if (phases.length === 0) return approve;
  const out = [
    ...approve,
    "### Suggested split",
    `Built from the diff size (${size.lines} lines in ${size.files} files) and the item's allowed paths, not from the code, so treat it as a starting point. To use it, reply \`/revise <feedback>\` and ask for these phases; the new spec then files one sub-issue per phase on \`/approve\`.`,
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
      ...p.allowed_paths.map((a) => `- \`${a}\``),
    );
  });
  out.push("");
  return out;
}

/**
 * A local phase's problem text: `text` with each `Depends on:` wi_/tk_ id of its split parent's problem and filed text
 * (`task create --depends-on`), so its implement run waits for what the parent waited for (design 05-dependencies, 2026-11-26).
 */
export function withParentDependsOn(text: string, parent: Pick<WorkItem, "problem" | "issue_text">): string {
  return withDependsOn(text, [...dependsOnIds(parent.problem), ...dependsOnIds(parent.issue_text ?? "")]);
}
