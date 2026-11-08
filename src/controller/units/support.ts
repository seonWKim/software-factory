// Declarations two or more controller units share (moved out of the legacy controller, RFC 0015 M5).

import { commandFooter, commandState } from "../../core/commands.js";
import { AUTO_ACTOR, runKey } from "../../core/policy.js";
import { MERGE_CONFLICT_PENDING } from "../../core/resolve.js";
import { PHASES_OPEN, SPLIT_FILING } from "../../core/split.js";
import { type Actor, type RunKind, type SourceType, type StateChangeDetail, type Timestamp, type WorkItem, type WorkItemId, type WorkItemPatch } from "../../core/types.js";
import type { TransitionInput } from "../../interfaces/factory-store.js";
import type { SourceEvent } from "../../interfaces/source-adapter.js";

/** The actor of auto mode's approvals, merges and stops (design 03-risk). */
export const AUTO: Actor = { kind: "system", id: AUTO_ACTOR };
export type Decision = Omit<TransitionInput, "id" | "expected_version"> | null;
/** Why a human's command was not applied; posted back to them. Plain null stays a silent no-op. */
export type Refusal = { refuse: string };
/** What a `+paths` adds to a transition (issue #280): the widened allowed_paths and a raised tier, and the added paths. */
export type Widening = { patch: Pick<WorkItemPatch, "allowed_paths" | "tier">; detail: StateChangeDetail };
export const NO_WIDENING: Widening = { patch: {}, detail: {} };
export type CommandEvent = Extract<SourceEvent, { kind: "spec_approved" | "spec_rejected" | "revise_requested" | "retry_requested" | "budget_continue" | "resolve_requested" }>;
export const COMMAND: Record<CommandEvent["kind"], string> = {
  spec_approved: "/approve",
  spec_rejected: "/reject",
  revise_requested: "/revise",
  retry_requested: "/retry",
  resolve_requested: "/resolve",
  budget_continue: "/budget",
};
export const SYSTEM: Actor = { kind: "system", id: "system:controller" };
/** A review run's `no_agent`: its head is the one the last verdict was for, so it ran no agent (issue #223). */
export const UNCHANGED_HEAD = "unchanged_head";
/** blocked_reason of an adopted PR that passed review but whose checks failed. */
export const CHECKS_FAILED = "checks_failed";
/**
 * blocked_reason of a factory PR whose checks failed while its stored merge check conflicts for the reviewed head
 * (design §5 CI gate): an update run merges the base first; no implement run starts until it finished.
 */
export const CHECKS_FAILED_UPDATE = "checks_failed_update";
export const MAX_CONFLICT_RETRIES = 5;
/** Characters of PR feedback (a `/revise` on a PR, or a "Request changes" review) kept and sent to the implementer. */
export const MAX_FEEDBACK_CHARS = 8000;
/** blocked_reason of an item whose diff touches a floor above its tier (design §4). */
export const FLOOR_TIER = "floor_tier";
/**
 * blocked_reason of a PR whose base no longer merges cleanly and whose automatic resolve runs are used up (or
 * whose updated branch failed its tests); `/resolve` starts a resolve run (design §5).
 */
export const CONFLICT_PENDING = MERGE_CONFLICT_PENDING;
/**
 * A rejected item whose source still needs the reject comment and the close: `CLOSED` with
 * `blocked_on: upstream` and this reason until both are done (design §4, gate commands).
 */
export const SOURCE_CLOSE_PENDING = "source_close_pending";
/** A command name safe to quote in a reply: anything else is called "the command". */
export const QUOTABLE_COMMAND = /^[a-z][a-z0-9_-]{0,31}$/;
/** The forge's source type: its source and forge do not poll while the `github_rate_limit` pause holds. */
export const GITHUB_SOURCE_TYPE: SourceType = "github_issue";
/**
 * `/retry [notes]`: the failed step again under a new key. `widen` (a `+paths`, issue #280) applies only to a
 * failed implement run; on any other kind it is refused and nothing changes. The note goes on the state change
 * (and is a resolve run's notes). At the review loop limit it is an implement run with loop_count back at 0 and
 * the item RUNNING (a human chose to try again).
 */
export function retry(it: WorkItem, actor: Actor, kind: RunKind | undefined, note: string | null, widen: Widening | null): Decision | Refusal {
  if (it.blocked_on !== "human" || !kind) return { refuse: "there is no failed run to retry" };
  if (widen && kind !== "implement") {
    return { refuse: `\`+paths\` applies only to a failed implement run, and this item's failed run is a ${kind} run; reply \`/retry\` without \`+paths\`` };
  }
  const w = widen ?? NO_WIDENING;
  const detail = { ...(note ? { note } : {}), ...w.detail };
  const loops = it.blocked_reason === "max_loops" ? { stage: "RUNNING" as const, loop_count: 0 } : {};
  const next = { ...it, restart_count: it.restart_count + 1, ...loops };
  // A retried update goes back to waiting for the merge, which is the state an update run expects.
  const unblocked = kind === "update"
    ? { blocked_on: "human" as const, blocked_reason: "merge_pending" }
    : { blocked_on: "none" as const, blocked_reason: null };
  // A new step key with no not_before: a human retry starts at once, with a fresh retry budget.
  return {
    patch: { ...unblocked, restart_count: next.restart_count, ...loops, ...w.patch },
    actor,
    reason: "retry_requested",
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    // A resolve run reads its notes from its input: the /retry note, or none.
    enqueue: { kind, idempotency_key: runKey(next, kind), ...(kind === "resolve" ? { input: { notes: note ?? "" } } : {}) },
  };
}
/** Closed as completed: the only close that releases the next phase or counts toward closing the parent. */
export function completed(it: WorkItem | null | undefined): boolean {
  return it?.stage === "CLOSED" && it.close_reason === "completed";
}
/** A split parent whose phases are filed and not all closed as completed. */
/** A split parent whose `/approve` claimed the filing and has not settled it yet. */
export function splitFiling(it: WorkItem): boolean {
  return it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === SPLIT_FILING;
}
export function splitOpen(it: WorkItem): boolean {
  return it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === PHASES_OPEN;
}
/** Markdown block quote of `text`, line by line. */
export function quote(text: string): string {
  return text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
}
/**
 * The command footer for a comment posted before its transition: the commands for the state the item will
 * be in once `patch` applies (design §4). Same table as the parser and the controller's checks.
 */
export function footerAfter(it: WorkItem, patch: Partial<Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "change_ref">>): string {
  return commandFooter(commandState({ ...it, ...patch }));
}
/** A code block whose fence is longer than any backtick run in `text`, so the text cannot close it. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
export function iso(ms: number): Timestamp {
  return new Date(ms).toISOString() as Timestamp;
}
/** The key of the one update run per (item, PR, head sha, base sha) (design §5 Merge check). */
export function updateKey(id: WorkItemId, change_ref: string, head_sha: string, base_sha: string): string {
  return `${id}:update:${change_ref}:${head_sha}:${base_sha}`;
}
/** A PR whose checks failed, waiting for the update run that merges the base before any implement run. */
export function updatingForChecks(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && it.blocked_reason === CHECKS_FAILED_UPDATE;
}
export function awaitingMerge(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending";
}
