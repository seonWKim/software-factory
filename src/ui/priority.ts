// Ranking for the status page (design §9). Pure: no store, no clock, no I/O. Every open work item lands in
// exactly one of nine levels, in the order below; within a level, more dependents first, then the oldest
// wait, then the higher tier. Badge texts are fixed words and numbers, never free text from the store.

import { AGENT_NEEDS_HUMAN } from "../core/policy.js";
import type { BlockedOn, CloseReason, RunKind, Stage, Tier } from "../core/types.js";

export const LEVELS = [
  "ready_to_merge",
  "needs_approval",
  "needs_you",
  "needs_triage",
  "stuck",
  "running",
  "queued",
  "blocked_by_task",
  "closed",
] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
  ready_to_merge: "Ready to merge",
  needs_approval: "Needs approval",
  needs_you: "Needs you",
  needs_triage: "Needs triage",
  stuck: "Stuck",
  running: "Running",
  queued: "Queued",
  blocked_by_task: "Blocked by another task",
  closed: "Closed",
};

/** The levels that wait for a person ("Needs you" and "Needs triage"); never "Blocked by another task". */
export const NEEDS_YOU: readonly Level[] = ["ready_to_merge", "needs_approval", "needs_you", "needs_triage"];

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
}

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
 * The item's level. A person's block: a triage run's ask is "Needs triage", every other one (and the budget check)
 * "Needs you". Another item's block (a deadlock claim, a dependency hold, a coordination hold, a phase or upstream
 * hold) is "Blocked by another task", never stuck; a dependency or coordination hold waits even while its run is
 * queued (issue #310). A running run past its lease is stuck; an open item that waits on nothing and has no queued
 * or running run is stuck too (nothing moves it).
 */
export function levelOf(i: PriorityInput, now: Date, lease_ms: number): Level {
  if (i.stage === "CLOSED") return "closed";
  if (i.blocked_on === "human" && i.blocked_reason === "merge_pending") return "ready_to_merge";
  if (i.blocked_on === "human" && i.blocked_reason === "spec_pending") return "needs_approval";
  if (i.blocked_on === "human" && i.blocked_reason === AGENT_NEEDS_HUMAN && i.asked_by === "triage") return "needs_triage";
  if (i.blocked_on === "human" || i.blocked_on === "budget") return "needs_you";
  if (i.deadlock) return "blocked_by_task";
  if (staleRun(i, now.getTime(), lease_ms)) return "stuck";
  if (i.run?.status === "running") return "running";
  if (i.blocked_on === "dependency" || i.held) return "blocked_by_task";
  if (i.run?.status === "queued") return "queued";
  if (i.blocked_on === "ci") return "running";
  if (i.waiting_on > 0 || i.blocked_on === "upstream") return "blocked_by_task";
  if (i.blocked_on === "none" && i.last_finished_at && now.getTime() - ms(i.last_finished_at) < lease_ms) return "queued";
  return "stuck";
}

/** The other item a blocked item waits on, in fixed words and numbers. */
function blockedBadge(i: PriorityInput): string {
  const n = i.waiting_on_number;
  if (i.deadlock) return n ? `deadlock with #${n}` : "deadlock";
  if (n) return `waits on #${n}`;
  if (i.waiting_on > 0) return `waits on ${i.waiting_on} ${i.waiting_on === 1 ? "issue" : "issues"}`;
  return i.held ? "held by another task" : "waits on another issue";
}

function humanBadge(i: PriorityInput): string {
  if (i.blocked_on === "budget") return "budget check";
  const r = i.blocked_reason ?? "";
  if (r.startsWith("run_failed:") || r === "max_attempts" || r === "max_restart" || r === "repeated_failure") return "failed";
  if (r === "max_loops") return "too many loops";
  if (r === "merge_conflict_pending") return "merge conflict";
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
    case "stuck": {
      const from = staleRun(i, now.getTime(), lease_ms) ? i.run!.heartbeat_at : i.since;
      main = `stuck ${Math.max(0, Math.floor((now.getTime() - ms(from)) / MINUTE))} min`;
      break;
    }
    case "running":
      main = i.run ? `running ${i.run.kind}` : "waiting for CI";
      break;
    case "queued":
      main = !i.run ? "next run queued" : i.run.paused_at ? `paused ${i.run!.kind}` : `queued ${i.run!.kind}`;
      break;
    case "blocked_by_task":
      main = blockedBadge(i);
      break;
    case "closed":
      main = i.close_reason ? `closed: ${i.close_reason.replace(/_/g, " ")}` : "closed";
      break;
  }
  return i.dependents > 0 ? [main, `unblocks ${i.dependents}`] : [main];
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
        LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) ||
        b.input.dependents - a.input.dependents ||
        ms(a.input.since) - ms(b.input.since) ||
        (b.input.tier ?? 0) - (a.input.tier ?? 0) ||
        a.index - b.index,
    )
    .map(({ input, level, badges }) => ({ input, level, badges }));
}
