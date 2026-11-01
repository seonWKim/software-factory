// Ranking for the status page (design §9). Pure: no store, no clock, no I/O. Every open work item lands in
// exactly one of eight levels, in the order below; within a level, more dependents first, then the oldest
// wait, then the higher tier. Badge texts are fixed words and numbers, never free text from the store.

import type { BlockedOn, CloseReason, RunKind, Stage, Tier } from "../core/types.js";

export const LEVELS = [
  "ready_to_merge",
  "needs_approval",
  "needs_human",
  "stuck",
  "running",
  "queued",
  "waiting_on_issue",
  "closed",
] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
  ready_to_merge: "Ready to merge",
  needs_approval: "Needs approval",
  needs_human: "Needs a human",
  stuck: "Stuck",
  running: "Running",
  queued: "Queued",
  waiting_on_issue: "Waiting on another issue",
  closed: "Closed",
};

/** The levels that wait for a person: "Needs you". */
export const NEEDS_YOU: readonly Level[] = ["ready_to_merge", "needs_approval", "needs_human"];

/** What the ranking reads about one item. The caller fills it from the store (plus dependency data, later). */
export interface PriorityInput {
  stage: Stage;
  blocked_on: BlockedOn;
  blocked_reason: string | null;
  close_reason: CloseReason | null;
  tier: Tier | null;
  /** ISO time the item started waiting in its current state ("oldest waiting first"). */
  since: string;
  /** The item's queued or running run, if any (running wins when it has both). */
  run: { kind: RunKind; status: "queued" | "running"; heartbeat_at: string } | null;
  /** Open items that wait on this one. 0 until dependency data exists (issue #49). */
  dependents: number;
  /** Open items this one waits on. 0 until dependency data exists (issue #49). */
  waiting_on: number;
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
 * The item's level. A running run past its lease is stuck; an open item that waits on nothing, is not
 * blocked on a person and has no queued or running run is stuck too (nothing moves it).
 */
export function levelOf(i: PriorityInput, now: Date, lease_ms: number): Level {
  if (i.stage === "CLOSED") return "closed";
  if (i.blocked_on === "human" && i.blocked_reason === "merge_pending") return "ready_to_merge";
  if (i.blocked_on === "human" && i.blocked_reason === "spec_pending") return "needs_approval";
  if (i.blocked_on === "human" || i.blocked_on === "budget") return "needs_human";
  if (staleRun(i, now.getTime(), lease_ms)) return "stuck";
  if (i.run?.status === "running") return "running";
  if (i.run?.status === "queued") return "queued";
  if (i.waiting_on > 0) return "waiting_on_issue";
  return "stuck";
}

function humanBadge(i: PriorityInput): string {
  if (i.blocked_on === "budget") return "budget check";
  const r = i.blocked_reason ?? "";
  if (r.startsWith("run_failed:") || r === "max_attempts" || r === "max_restart") return "failed";
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
    case "needs_human":
      main = humanBadge(i);
      break;
    case "stuck": {
      const from = staleRun(i, now.getTime(), lease_ms) ? i.run!.heartbeat_at : i.since;
      main = `stuck ${Math.max(0, Math.floor((now.getTime() - ms(from)) / MINUTE))} min`;
      break;
    }
    case "running":
      main = `running ${i.run!.kind}`;
      break;
    case "queued":
      main = `queued ${i.run!.kind}`;
      break;
    case "waiting_on_issue":
      main = `waits on ${i.waiting_on}`;
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
