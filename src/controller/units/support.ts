// Declarations two or more controller units share (moved out of the legacy controller, RFC 0015 M5).

import { commandFooter, commandState } from "../../core/commands.js";
import { AUTO_ACTOR, isCovered, runKey } from "../../core/policy.js";
import { MERGE_CONFLICT_PENDING } from "../../core/resolve.js";
import { type Actor, RECURRING_FAILURE, type Run, type RunKind, type SourceRef, type SourceType, type StateChangeDetail, type Timestamp, type WipRef, type WorkItem, type WorkItemId, type WorkItemPatch } from "../../core/types.js";
import type { TransitionInput } from "../../interfaces/factory-store.js";
import type { SourceEvent } from "../../interfaces/source-adapter.js";

// The split, delivery and gate states the approve gate checks live in core, shared with the dashboard's request path.
export { DELIVERY_FAILED, FLOOR_TIER, RULE_OF_TWO, awaitingMerge, commandPhase, phaseLabel, splitFiling, splitOpen } from "../../core/commands.js";
// Types the controller files outside units/ take from here (the golden gate), so they import no legacy module themselves.
export type { Actor, Run, RunId, RunInput, Tier, WipRef, WorkItem, WorkItemId } from "../../core/types.js";
export { branchFor, runKey } from "../../core/policy.js";
export type { FactoryStore, GoldenFingerprint } from "../../interfaces/factory-store.js";

/** The actor of auto mode's approvals, merges and stops (design 03-risk). */
export const AUTO: Actor = { kind: "system", id: AUTO_ACTOR };
export type Decision = Omit<TransitionInput, "id" | "expected_version"> | null;
/** Why a human's command was not applied; posted back to them. Plain null stays a silent no-op. */
export type Refusal = { refuse: string };
/** What a `+paths` adds to a transition (issue #280): the widened allowed_paths and a raised tier, and the added paths. */
export type Widening = { patch: Pick<WorkItemPatch, "allowed_paths" | "tier">; detail: StateChangeDetail };
export const NO_WIDENING: Widening = { patch: {}, detail: {} };
export type CommandEvent = Extract<SourceEvent, { kind: "spec_approved" | "spec_rejected" | "revise_requested" | "retry_requested" | "budget_continue" | "resolve_requested" | "paths_requested" }>;
export const COMMAND: Record<CommandEvent["kind"], string> = {
  spec_approved: "/approve",
  spec_rejected: "/reject",
  revise_requested: "/revise",
  retry_requested: "/retry",
  paths_requested: "/paths",
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
 * Where an ended implement run kept its commits (design 05-restarts): the wip ref its outcome names (a failure's `wip`,
 * or a needs_human or floor_block answer's `data.wip`), else the one it was handed and did not replace (a run that failed
 * before it kept anything of its own). A run that pushed its branch keeps none.
 */
export function keptWip(run: Pick<Run, "kind" | "outcome" | "input">): WipRef | undefined {
  const o = run.outcome;
  if (run.kind !== "implement" || !o) return undefined;
  if (o.status === "failed") return o.wip ?? run.input?.wip;
  return o.data.needs_human != null || o.data.floor_block === true ? ((o.data.wip as WipRef | undefined) ?? run.input?.wip) : undefined;
}
/** The wip ref a `/retry` or `/approve` of an implement step hands its run (design 05-restarts): where the newest finished implement run kept its commits. */
export function retryWip(runs: readonly Pick<Run, "kind" | "outcome" | "input">[]): WipRef | undefined {
  const last = runs.filter((r) => r.kind === "implement" && r.outcome).at(-1);
  return last ? keptWip(last) : undefined;
}
/** The `/retry` refusal on an item waiting on its merge conflict (2026-11-26): the `/resolve` replies that apply there. */
const RESOLVE_NOT_RETRY = "the item is waiting on its merge conflict, so there is no failed run to retry; reply `/resolve [notes]` to resolve it again, " +
  "or `/resolve +paths <path>...` with the notes on the lines below to also allow files outside the conflicts and allowed paths";
/**
 * `/retry [notes]`: the failed step again under a new key. `widen` (a `+paths`, issue #280) applies only to a
 * failed implement or resolve run; on any other kind it is refused and nothing changes. The note, without its
 * `+paths` line, goes on the state change (and is a resolve run's notes). At the review loop limit it is an implement run with loop_count back at 0 and
 * the item RUNNING (a human chose to try again). On a `recurring_failure` hold it only lifts the hold, or with `widen`
 * (its failed run an implement run, `kind`) cancels the held queued runs and queues a fresh implement run. `label` names a
 * run kind in the refusal: the run-results unit's `kindLabel`, which this shared file takes as an argument. `wip`: where
 * the last implement run kept its commits (keptWip, design §5 Restarts); an implement retry starts from it.
 */
export function retry(it: WorkItem, actor: Actor, kind: RunKind | undefined, note: string | null, widen: Widening | null, label: (kind: RunKind) => string, wip?: WipRef): Decision | Refusal {
  // A recurring failure's hold (design 05-alarms) has its runs queued already: lifted, they are claimed. With `+paths`
  // on a failed implement run, the queued runs are cancelled and a fresh implement run on the widened paths replaces them.
  if (it.blocked_on === "human" && it.blocked_reason === RECURRING_FAILURE) {
    if (!widen) return { patch: { blocked_on: "none", blocked_reason: null }, actor, reason: "retry_requested", ...(note ? { detail: { note } } : {}) };
    if (kind !== "implement") {
      return { refuse: `\`+paths\` on an item held for a recurring failure applies only when its failed run is an implement run, and this item's ${kind ? `is a ${label(kind)} run` : "has no failed run"}; reply \`/retry\` without \`+paths\`` };
    }
    const next = { ...it, restart_count: it.restart_count + 1 };
    return {
      patch: { blocked_on: "none", blocked_reason: null, restart_count: next.restart_count, ...widen.patch },
      actor,
      reason: "retry_requested",
      detail: { ...(note ? { note } : {}), ...widen.detail },
      cancel_queued_runs: true,
      enqueue: { kind, idempotency_key: runKey(next, kind), ...(wip ? { input: { wip } } : {}) },
    };
  }
  // A failed resolve run leaves the item on its merge conflict, not on a failed run: `/resolve` (with `+paths`) answers it.
  if (it.blocked_on === "human" && it.blocked_reason === CONFLICT_PENDING) return { refuse: RESOLVE_NOT_RETRY };
  if (it.blocked_on !== "human" || !kind) return { refuse: "there is no failed run to retry" };
  if (widen && kind !== "implement" && kind !== "resolve") {
    return { refuse: `\`+paths\` applies only to a failed implement or resolve run, and this item's failed run is a ${label(kind)} run; reply \`/retry\` without \`+paths\`` };
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
    enqueue: { kind, idempotency_key: runKey(next, kind), ...(kind === "resolve" ? { input: { notes: note ?? "" } } : kind === "implement" && wip ? { input: { wip } } : {}) },
  };
}
/**
 * The reply to an applied `/approve`, `/retry` or `/resolve` whose every `+paths` path an allowed path (or the
 * ratchet-list rule) already covered, so it added nothing (design 04-gate-commands, 2026-11-16): on the thread the
 * command came from (a `/resolve` on the PR, else the item's), keyed on the comment. null: no `+paths`, or one is new.
 */
export function alreadyAllowed(it: WorkItem, e: CommandEvent, paths: readonly string[]): { target: SourceRef; body: string; marker: string } | null {
  const unique = [...new Set(paths)];
  if (unique.length === 0 || !unique.every((p) => isCovered(p, it.allowed_paths))) return null;
  const onPr = (e.kind === "resolve_requested" || e.kind === "revise_requested") && e.pr;
  return {
    target: onPr ? e.source : it.source,
    body: `\`${COMMAND[e.kind]}\` was applied; its \`+paths\` added nothing to the allowed paths, already allowed: ${unique.join(", ")}`,
    marker: `<!-- factory:already-allowed:${e.comment_id} -->`,
  };
}
/** Closed as completed: the only close that releases the next phase or counts toward closing the parent. */
export function completed(it: WorkItem | null | undefined): boolean {
  return it?.stage === "CLOSED" && it.close_reason === "completed";
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
