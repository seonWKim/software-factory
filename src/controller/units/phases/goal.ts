// Goal splits (design 04-split-specs): the reasons a goal split records, the fix cap, and the pure readers of what
// the store recorded (goal lines, fix phases, judgeable phases). Kept out of phases.unit.ts, which may not grow past
// the file budget; the unit's I/O and its readers that need core parsers stay there. Types come through the unit, so
// this file adds no import of legacy code.

import { completed } from "../support.js";
import type { PhasesUnit } from "./phases.unit.js";

type WorkItem = Awaited<ReturnType<PhasesUnit["recordedPhases"]>>[number];
type WorkItemId = WorkItem["id"];
type StateChange = NonNullable<Awaited<ReturnType<PhasesUnit["splitClaim"]>>>;
type StateChangeDetail = NonNullable<StateChange["detail"]>;

/** State change reason on a goal split's parent when its judge run for a phase was queued; detail: the phase and its merge sha. */
export const JUDGE_QUEUED = "judge_queued";
/** State change reason on the parent applying a judge's verdict: detail `phase`, `verdict`, `reason`, `applied` (and a fix's fields). */
export const JUDGE_VERDICT = "judge_verdict";
/** State change reason on the parent when its judge run found no prompts/judge.md: the phase counts as unjudged, as with no goal. */
export const JUDGE_SKIPPED = "judge_skipped";
/** State change reason on the parent when its judge run reached a retry limit: the goal stops as a goal question. */
export const JUDGE_FAILED = "judge_failed";
/** blocked_reason (with `blocked_on: human`) of a goal split whose judge answered ask, or next on its last phase, or failed. */
export const GOAL_QUESTION = "goal_question";
/** blocked_reason (with `blocked_on: human`) of a goal split whose judge proposed a fix with the fix cap reached. */
export const GOAL_LIMIT = "goal_limit";
/** State change reason on the parent recording a fix phase: detail the judged `phase`, the verdict, `added_phase`, `sub_issue`. */
export const GOAL_PHASE_ADDED = "goal_phase_added";
/** Fix phases a goal files before the owner decides on the next one (design 04-split-specs, decision 3). */
export const FIX_PHASE_CAP = 2;
/** The judge run's key for phase `phase` of goal split `parent`: one per phase (design 04-split-specs). */
export const judgeKey = (parent: WorkItemId, phase: number): string => `judge:${parent}:${phase}`;

/** A detail field holding a JSON array of strings, or null. */
export function jsonStrings(v: unknown): string[] | null {
  try {
    const x: unknown = typeof v === "string" ? JSON.parse(v) : null;
    return Array.isArray(x) && x.every((l) => typeof l === "string") ? x : null;
  } catch {
    return null;
  }
}
/** The goal lines a split_approved detail stores (`goal_done_when`, a JSON array), or null for a split without a goal. */
export const goalLines = (d: StateChangeDetail | null | undefined): string[] | null => (jsonStrings(d?.goal_done_when)?.length ? jsonStrings(d?.goal_done_when) : null);
/** The goal_phase_added changes among `changes`: one per fix phase filed. */
export const fixPhases = (changes: readonly StateChange[]): StateChange[] => changes.filter((c) => c.reason === GOAL_PHASE_ADDED && typeof c.detail?.sub_issue === "string");

/** A goal phase the judge reads: closed completed with a merge sha. */
export const judgeable = (p: WorkItem): p is WorkItem & { phase: number; merge_sha: string } => completed(p) && p.phase !== null && typeof p.merge_sha === "string" && p.merge_sha !== "";
