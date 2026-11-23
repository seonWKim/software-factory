// Ranking for the status page (design §9). Pure: no store, no clock, no I/O. Every work item lands in exactly one
// level, a work item state of the one state table (src/shared/states.ts), in its sort order; within a level, more
// dependents first, then the oldest wait, then the higher tier. Badge texts are fixed words and numbers, never free
// text from the store. An ask (an ASKS level) also gets its rank reason and whether it is held until `review_time`
// (askReason).

import { SYSTEM_ITEM } from "../core/improver.js";
import { FAILED_PHASES, type ItemPhase, PERSON_PHASES, isClosedPhase, phaseOf } from "../core/phase.js";
import type { BlockedOn, CloseReason, RunKind, Stage, Tier } from "../core/types.js";
import { ITEM_STATES, type ItemState, STATES, groupStates } from "../shared/states.js";

/** The levels in display order: the state table's work item states. */
export const LEVELS = ITEM_STATES;
export type Level = ItemState;

/** The Needs-you group (ready to merge, needs approval, needs you): never triage, a failed run or another task's block. */
export const NEEDS_YOU: readonly Level[] = groupStates("needs");

/**
 * The levels whose list rows carry their need and their commands (src/ui/api.ts): the Needs-you group, a failed run
 * (Retry, Reject) in Problem, and a triage run's ask (its question and Answer) in Waiting.
 */
export const WITH_NEED: readonly Level[] = [...NEEDS_YOU, "failed", "needs_triage"];

/** The levels that ask a person something and carry a rank reason (askReason): the Needs-you group and a triage ask. */
export const ASKS: readonly Level[] = [...NEEDS_YOU, "needs_triage"];

/** A closed item's level: merged when it closed as completed (phase done), rejected when rejected, closed otherwise. */
export function closedLevel(i: Pick<PriorityInput, "stage" | "blocked_on" | "blocked_reason" | "close_reason">): Level {
  return phaseOf(i) === "done" ? "merged" : i.close_reason === "rejected" ? "rejected" : "closed";
}

/** What the ranking reads about one item. The caller fills it from the store (plus dependency data, later). */
export interface PriorityInput {
  stage: Stage;
  blocked_on: BlockedOn;
  blocked_reason: string | null;
  close_reason: CloseReason | null;
  tier: Tier | null;
  /** ISO time the item started waiting in its current state ("oldest waiting first"). */
  since: string;
  /**
   * The item's queued or running run, if any (running wins when it has both). `paused_at`: a queued run that
   * `workers pause` stopped (design §5 Pause); it ranks as queued, never as stuck.
   */
  run: { kind: RunKind; status: "queued" | "running"; heartbeat_at: string; paused_at?: string | null } | null;
  /** ISO time the item's latest run finished, if any: tells the gap before the next run is queued from an idle item. */
  last_finished_at?: string | null;
  /** Open items that wait on this one. 0 until dependency data exists (issue #49). */
  dependents: number;
  /** Open items this one waits on: a split phase's previous phase, a split parent's open phases. */
  waiting_on: number;
  /**
   * The issue number this item waits on, when it is exactly one (a held phase's previous phase, one dependency, the
   * holder of a coordination hold or a deadlock claim).
   */
  waiting_on_number?: number | null;
  /** The latest claim decision on the item's current run is a deadlock (why.ts `deadlocked`). */
  deadlock?: boolean;
  /** The item's queued run is held by an unapproved `held` claim decision (why.ts `heldBy`): a coordination hold. */
  held?: boolean;
  /** The kind of the run behind an `agent_needs_human` block (core/policy.ts `blockingRunKind`), else null. */
  asked_by?: RunKind | null;
  /** The owner's dashboard command stored and not carried out by the controller yet (list.ts pendingOf), else null. */
  pending?: Pending | null;
}

/**
 * A dashboard command the controller has not carried out yet (design 09-dashboard-item-commands): an Approve whose
 * run is not queued yet (its run's kind), or a Merge request not handled yet (its 1-based place among them). The
 * stored state is unchanged; the ranking shows it as queued, never as stuck or ready to merge.
 */
export type Pending = { command: "approve"; kind: RunKind } | { command: "merge"; position: number };

export interface Ranked<T extends PriorityInput> {
  input: T;
  level: Level;
  /** The level's reason badge first, then "unblocks N" when the item has dependents. */
  badges: string[];
}

const MINUTE = 60_000;

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function staleRun(i: PriorityInput, now: number, lease_ms: number): boolean {
  return i.run?.status === "running" && now - ms(i.run.heartbeat_at) > lease_ms;
}

/**
 * The item's level, from its phase (core/phase.ts) and its run. A closed item is merged, rejected or closed
 * (closedLevel). A person's block: a triage run's ask is "Needs triage", a spec to approve (also at its revision
 * limit) "Needs approval", a failed run (FAILED_PHASES) "Failed", every other one (and the budget check) "Needs you".
 * A coordination hold is "Held"; another item's block (a deadlock claim, a dependency hold, a phase or upstream hold)
 * is "Blocked by another task"; neither is ever stuck, and a dependency or coordination hold waits even while its run
 * is queued (issue #310). A pending dashboard command (an Approve whose run is not queued yet, a Merge not handled yet)
 * is queued. A running run past its lease is stuck; an open item that waits on nothing and has no queued or running
 * run is stuck too (nothing moves it).
 */
export function levelOf(i: PriorityInput, now: Date, lease_ms: number): Level {
  const p = phaseOf(i);
  if (i.blocked_reason === SYSTEM_ITEM) return "system";
  if (isClosedPhase(p)) return closedLevel(i);
  if (i.pending) return "queued";
  if (p === "merge_pending") return "ready_to_merge";
  if (p === "spec_pending" || p === "max_revisions") return "needs_approval";
  if (p === "agent_needs_human" && i.asked_by === "triage") return "needs_triage";
  if (FAILED_PHASES.has(p)) return "failed";
  if (PERSON_PHASES.has(p)) return "needs_you";
  if (i.deadlock) return "blocked_by_task";
  if (staleRun(i, now.getTime(), lease_ms)) return "stuck";
  if (i.run?.status === "running") return "running";
  if (p === "dependency_hold") return "blocked_by_task";
  if (i.held) return "held";
  if (i.run?.status === "queued") return "queued";
  if (p === "ci_wait") return "running";
  if (i.waiting_on > 0 || p === "phase_hold" || p === "phases_open" || p === "upstream_wait") return "blocked_by_task";
  if (UNBLOCKED.has(p) && i.last_finished_at && now.getTime() - ms(i.last_finished_at) < lease_ms) return "queued";
  return "stuck";
}

/** The phases where nothing blocks the item: its next run is due. */
const UNBLOCKED: ReadonlySet<ItemPhase> = new Set<ItemPhase>(["triaging", "specced", "implementing", "reviewing"]);

/** The other item a blocked item waits on, in fixed words and numbers. */
function blockedBadge(i: PriorityInput): string {
  const n = i.waiting_on_number;
  if (i.deadlock) return n ? `waits on #${n}` : "waits on another task";
  if (n) return `waits on #${n}`;
  if (i.waiting_on > 0) return `waits on ${i.waiting_on} ${i.waiting_on === 1 ? "issue" : "issues"}`;
  return i.held ? "held by another task" : "waits on another issue";
}

function humanBadge(i: PriorityInput): string {
  const p = phaseOf(i);
  if (p === "budget_checkpoint" || p === "budget_wait") return "budget check";
  if (p === "max_loops") return "too many loops";
  if (p === "merge_conflict") return "merge conflict";
  return "needs you";
}

export function badgesOf(i: PriorityInput, level: Level, now: Date, lease_ms: number): string[] {
  let main: string;
  switch (level) {
    case "ready_to_merge":
      main = "ready to merge";
      break;
    case "needs_approval":
      main = "needs approval";
      break;
    case "needs_you":
      main = humanBadge(i);
      break;
    case "needs_triage":
      main = "triage asks";
      break;
    case "failed":
      main = "failed";
      break;
    case "stuck": {
      const from = staleRun(i, now.getTime(), lease_ms) ? i.run!.heartbeat_at : i.since;
      main = `stuck ${Math.max(0, Math.floor((now.getTime() - ms(from)) / MINUTE))} min`;
      break;
    }
    case "running":
      main = i.run ? `running ${i.run.kind}` : "waiting for CI";
      break;
    case "queued":
      main = i.pending?.command === "merge" ? `merge queued (position ${i.pending.position})` : i.pending ? `queued ${i.pending.kind}` : !i.run ? "next run queued" : i.run.paused_at ? `paused ${i.run!.kind}` : `queued ${i.run!.kind}`;
      break;
    case "system":
      main = "system";
      break;
    case "held":
    case "blocked_by_task":
      main = blockedBadge(i);
      break;
    case "merged":
    case "rejected":
      main = level;
      break;
    case "closed":
      main = i.close_reason ? `closed: ${i.close_reason.replace(/_/g, " ")}` : "closed";
      break;
  }
  return i.dependents > 0 ? [main, `unblocks ${i.dependents}`] : [main];
}

/**
 * Whether non-urgent asks are held at `now`: `review_time` (HH:MM, checked by settings.ts parseSettable) is set and the
 * local time is before it. "" turns holding off.
 */
export function holdingNow(review_time: string, now: Date): boolean {
  const [h, m] = review_time.split(":").map(Number);
  return review_time !== "" && now.getHours() * 60 + now.getMinutes() < h! * 60 + m!;
}

/**
 * Why an ask (an ASKS level) ranks where it does, in fixed words (design 09-status-page): a merge and an ask that
 * blocks another item are urgent, shown and counted at once; any other ask is held while `holding` (holdingNow), and
 * reads "Held until <review_time>". Null for a level that asks nothing of a person.
 */
export function askReason(i: PriorityInput, level: Level, review_time: string, holding: boolean): { rank_reason: string; held: boolean } | null {
  if (!ASKS.includes(level)) return null;
  if (level === "ready_to_merge") return { rank_reason: "Merge", held: false };
  if (i.dependents > 0) return { rank_reason: "Blocks another item", held: false };
  return holding ? { rank_reason: `Held until ${review_time}`, held: true } : { rank_reason: "Waiting for you", held: false };
}

/** Every item with its level and badges, in display order. Stable: equal items keep their input order. */
export function rank<T extends PriorityInput>(items: readonly T[], now: Date, lease_ms: number): Ranked<T>[] {
  return items
    .map((input, index) => {
      const level = levelOf(input, now, lease_ms);
      return { input, level, badges: badgesOf(input, level, now, lease_ms), index };
    })
    .sort(
      (a, b) =>
        STATES[a.level].sort - STATES[b.level].sort ||
        b.input.dependents - a.input.dependents ||
        ms(a.input.since) - ms(b.input.since) ||
        (b.input.tier ?? 0) - (a.input.tier ?? 0) ||
        a.index - b.index,
    )
    .map(({ input, level, badges }) => ({ input, level, badges }));
}
