// The checks of Approve and Merge that read only the store (design 04-gate-commands, 2026-11-15): the approve gate
// (the spec gate, the revision limit, the floor block, the Rule of Two, a split, a dependency hold, the decision
// answers), the note scan and `+paths`, and the merge gate. The controller's comment command path and the dashboard's
// request path both call them, so both refuse with the same words. `requestTransition` is the request path: the
// dashboard's Approve as one conditional store write while the request is handled, its Merge checked and answered
// "Merging…" with nothing written, or its refusal. The controller enters the merge queue (merge_queued) on its next
// pass; the merge conflict check, the merge queue and the forge's merge stay in the controller.

import type { EgressScanner, ScanResult } from "../interfaces/egress-scanner.js";
import type { AppCommandRequest, FactoryStore, NewRun, TransitionInput } from "../interfaces/factory-store.js";
import type { AuthDecision } from "../interfaces/auth-provider.js";
import { refusalReply } from "./authorize.js";
import { BUDGET_CHECKPOINT } from "./budget.js";
import { prNumber } from "./change-ref.js";
import {
  CHECKPOINT_REFUSAL, CLOSED_REFUSAL, commandPhase, dependencyHoldRefusal, latestSpec, parseCommandPaths, phaseLabel, refusalText, retryPathsReply, specNotWaiting,
} from "./commands.js";
import { LOCAL_SOURCE } from "./local-merge.js";
import { effectiveTier, isCovered, runKey } from "./policy.js";
import { MERGE_CONFLICT_PENDING } from "./resolve.js";
import { SCHEDULE_CHECKPOINT, SCHEDULE_CHECKPOINT_APPROVED } from "./schedule.js";
import { PHASES_OPEN, SPLIT_FILING } from "./split.js";
import { SPEC_DECISIONS, specChanged, specDecisionDetail, specKind } from "./standing.js";
import { type SpecDecision, type TriagePhase, optionChange } from "./outputs.js";
import { type Actor, RECURRING_FAILURE, type Run, type RunInput, type RunKind, type SpecKind, type StateChange, type StateChangeDetail, type Tier, type Timestamp, type WipRef, type WorkItem, type WorkItemPatch } from "./types.js";

/** A transition as a check decides it: the store's input without the item and its version. */
export type Transition = Omit<TransitionInput, "id" | "expected_version">;
/** A refusal, in the words the controller replies with. */
export type Refused = { refuse: string };
/** A check's answer: the transition, a refusal, or null (nothing to do: the same command was answered already). */
export type Checked = Transition | Refused | null;
/** What a `+paths` adds to a transition (issue #280): the widened allowed_paths and a raised tier, and the added paths. */
export type Widened = { patch: Pick<WorkItemPatch, "allowed_paths" | "tier">; detail: StateChangeDetail };
/** The store reads the checks make. */
export type ItemReads = Pick<FactoryStore, "listRuns" | "listStateChanges">;

/** The state change detail key that names the app request a transition applied, so a second apply finds it. */
export const APP_REQUEST = "app_request";
/**
 * The detail key of a request-time approval's run, as JSON (kind, key, input, not_before): the request path records
 * the state and leaves the run to the controller, whose transition queues it through the Rule of Two and budget holds.
 */
export const QUEUED_RUN = "queued_run";
/** The reason of the controller's transition that queues a request-time approval's run. */
export const APPROVED_RUN_QUEUED = "approved_run_queued";
/** blocked_reason of a local item whose Merge the controller took: its merge queue has it now. */
export const MERGE_QUEUED = "merge_queued";
/** The reason of the controller's entry of a dashboard Merge: merge_pending → merge_queued. */
export const MERGE_REQUESTED = "merge_requested";
/** The reason of a refused or failed merge: merge_queued → merge_pending, the refusal in its detail. */
export const MERGE_RETURNED = "merge_returned";
/**
 * The row's words for a state the request path just recorded (design 09-dashboard-app), and for a Merge under way:
 * `checking` while the merge queue checks the item (merge_queued); a pending Merge's place is mergeQueuedLabel.
 */
export const ROW_LABELS = { approved: "Approved", merging: "Merging…", checking: "Checking build", merged: "Merged" } as const;
/** A dashboard Merge stored and not handled yet, at its 1-based place among the Merges waiting for the controller. */
export const mergeQueuedLabel = (position: number): string => `Merge queued (position ${position})`;
/** Characters of an approval note kept on the state change (design §4). */
const MAX_NOTE_CHARS = 2000;
/** Characters of a merge refusal kept on its state change. */
const MAX_RETURNED_CHARS = 1000;
/** The approvals a further Approve finds already done: the newest change, at the item's version. */
const APPROVALS: readonly string[] = ["spec_approved", "floor_tier_approved", "rule_of_two_approved", SPLIT_FILING, APPROVED_RUN_QUEUED];
/** The refusal of an `/approve +paths` on a split spec (issue #280): the approval files sub-issues, it implements nothing. */
const SPLIT_PATHS = "`+paths` does not apply to a split spec, whose `/approve` files one sub-issue per phase; reply `/approve` without `+paths`, then add paths on a phase's issue";
/** The refusal of an `/approve +paths` on an implement run held by coordination cost: that run is already queued. */
export const HOLD_PATHS = "`+paths` does not apply to an implement run held by coordination cost, since that run is already queued; reply `/approve` without `+paths`";
/** Any command but `/approve` and `/reject` on a Rule of Two block. */
const RULE_OF_TWO_WAITS = "the item waits for a person to approve its run (Rule of Two); reply `/approve` to start it or `/reject <reason>` to close";
/** blocked_reason of an item whose diff touches a floor above its tier (design §4). */
export const FLOOR_TIER = "floor_tier";
/**
 * blocked_reason of an item whose next run's role holds all three Rule of Two facts while no person approved it (auto
 * mode approved its spec, RFC 0015 §8): the run is held until a person's `/approve` (design 10-event-driven).
 */
export const RULE_OF_TWO = "rule_of_two";
/**
 * A write an item waited for was given up by outbound (refused for good, RFC 0015 §7): a run's PR or push, or a
 * split's phase filing. The item waits for a person (`blocked_on: human`), with the action and its last error in
 * the transition's detail.
 */
export const DELIVERY_FAILED = "delivery_failed";

/** An app request reads no `+paths`, so it widens nothing. */
const NOT_WIDENED: Widened = { patch: {}, detail: {} };

/** Whether the item's newest change, at its current version, is an approval: a further Approve is a repeat of it. */
function approvedAlready(changes: readonly StateChange[], it: WorkItem): boolean {
  const last = changes.at(-1);
  return last?.version === it.version && APPROVALS.includes(last.reason);
}

/** A split parent whose `/approve` claimed the filing and has not settled it yet. */
export const splitFiling = (it: WorkItem): boolean => it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === SPLIT_FILING;
/** A split parent whose phases are filed and not all closed as completed. */
export const splitOpen = (it: WorkItem): boolean => it.stage === "READY" && it.blocked_on === "upstream" && it.blocked_reason === PHASES_OPEN;
/** A split whose phase filing outbound gave up: it waits for `/approve` again. */
const splitFilingFailed = (it: WorkItem) => it.stage === "READY" && it.blocked_on === "human" && it.blocked_reason === DELIVERY_FAILED && it.parent_id === null;

/**
 * A spec waiting for `/approve`, `/reject` or `/revise`; past the revision limit, only the first two apply. A split
 * whose phase filing outbound gave up waits too: `/approve` again files the rest under new keys, none twice.
 */
export function awaitingSpec(it: WorkItem): boolean {
  return it.stage === "READY" && (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions" || splitFilingFailed(it));
}

/** An implementing item: `/approve` there lifts a coordination-cost hold on its queued implement run, the controller's to decide. */
export function approvesHold(it: WorkItem): boolean {
  return it.stage === "RUNNING" && it.blocked_on === "none";
}

/** `d` with `tag` added to its state change detail; a refusal or no-op as it is. */
export function withTag<D extends Checked>(d: D, tag: StateChangeDetail | null): D {
  return !tag || !d || "refuse" in d ? d : ({ ...d, detail: { ...d.detail, ...tag } } as D);
}

/** The approval note to store, trimmed and capped, or the refusal when the egress scan flags it (`rules`: the rules that matched). */
export async function scanNote(
  scan: (text: string) => Promise<ScanResult>, raw: string | undefined, command: string,
): Promise<{ note: string | null } | (Refused & { rules: string })> {
  const text = (raw ?? "").trim();
  if (!text) return { note: null };
  const r = await scan(text);
  if (!r.clean) {
    const rules = r.findings.map((f) => f.rule).join(",");
    return { rules, refuse: `the note was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed; post \`${command}\` again without the secret` };
  }
  return { note: text.slice(0, MAX_NOTE_CHARS).trim() };
}

/**
 * The note and the `+paths` of an `/approve`, `/retry` or `/resolve` (design §4, issue #280). The whole text is
 * egress-scanned first (so a refusal never quotes a flagged path), then `+paths` is split off and checked (unless
 * `paths` is false: an app request's), the note what is left, capped.
 */
export async function commandNote(
  scan: (text: string) => Promise<ScanResult>, text: string | undefined, command: string, paths: boolean,
): Promise<{ note: string | null; paths: string[] } | (Refused & { rules?: string })> {
  const scanned = await scanNote(scan, text, command);
  if ("refuse" in scanned) return scanned;
  const split = paths ? parseCommandPaths(text ?? "", command) : { note: text ?? "", paths: [] };
  if ("refuse" in split) return split;
  const note = split.note.slice(0, MAX_NOTE_CHARS).trim();
  return { note: note || null, paths: split.paths };
}

/** What the approve gate reads of one decision's answer: the answer given (else the default) and whether it is the default. */
export interface GateAnswer {
  answer: string | null;
  accepted_default: boolean;
}

/** The decision answers of an approval note (src/shared/command-notes.ts): its parser and its state change detail. */
export interface NoteAnswers<A extends GateAnswer> {
  split(note: string | null, decisions: readonly { text: string; default: string | null }[]): { note: string | null; answers: A[] } | Refused;
  detail(answers: readonly A[]): StateChangeDetail;
}

/** What an `/approve` carries into the approve gate. */
export interface ApproveArgs<A extends GateAnswer> {
  actor: Actor;
  note: string | null;
  paths: readonly string[];
  /** The comment, or `app-<seq>` for an app request: a split's claim names it. */
  comment_id: string;
  tag: StateChangeDetail | null;
  widen: (paths: readonly string[]) => Widened;
  answers: NoteAnswers<A>;
}

/** The approve gate's answer: a check's, or a split spec whose filing the controller claims (`approveSplit`). */
export type ApproveChecked = Checked | { split: TriagePhase[]; note: string | null; tag: StateChangeDetail | null };

/** The latest claim of a split's filing (its `comment_id` names the approval that claimed it). */
export async function splitClaim(r: ItemReads, it: WorkItem): Promise<StateChange | null> {
  return (await r.listStateChanges(it.id)).filter((c) => c.reason === SPLIT_FILING).at(-1) ?? null;
}

/** For an item in a floor block, the tier its latest `floor_blocked` row says it needs; else null. */
export async function floorTierNeeded(r: ItemReads, it: WorkItem): Promise<number | null> {
  if (it.blocked_reason !== FLOOR_TIER) return null;
  const tier = (await r.listStateChanges(it.id)).filter((c) => c.reason === "floor_blocked").at(-1)?.detail?.required_tier;
  return typeof tier === "number" ? tier : null;
}

/**
 * `/approve` on a spec (design §4), the same checks in the same order for every source: a closed item, a budget
 * checkpoint, a schedule's checkpoint (closed as completed), the floor block and the Rule of Two (their own
 * approvals), a split being filed (the approval that claimed it is answered: null), a dependency hold, a spec not
 * waiting, `+paths` on a split, the decision answers;
 * then the transition: a split's filing (`split`, the controller's), else RUNNING with one implement run.
 */
export async function approveCheck<A extends GateAnswer>(r: ItemReads, it: WorkItem, a: ApproveArgs<A>): Promise<ApproveChecked> {
  if (it.stage === "CLOSED") return { refuse: CLOSED_REFUSAL };
  if (it.blocked_reason === BUDGET_CHECKPOINT) return { refuse: CHECKPOINT_REFUSAL };
  // A schedule's token-cap checkpoint (design 08-schedules): closed as completed; the schedule's next pass raises the cap and runs the held occurrence.
  if (it.blocked_reason === SCHEDULE_CHECKPOINT) {
    return { patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null }, actor: a.actor, reason: SCHEDULE_CHECKPOINT_APPROVED, ...(a.note ? { detail: { note: a.note } } : {}) };
  }
  if (it.blocked_reason === FLOOR_TIER) return floorCommand("spec_approved", it, a.actor, await floorTierNeeded(r, it), a.note, a.widen(a.paths), floorWip(await r.listRuns(it.id)));
  if (it.blocked_reason === RULE_OF_TWO) return ruleOfTwoCommand("spec_approved", it, a.actor, a.note, a.paths, await r.listStateChanges(it.id));
  if (splitFiling(it) || splitOpen(it) || splitFilingFailed(it)) {
    // The same `/approve` delivered again (a second poll, another replica, or the one whose filing was given up):
    // the pass that claimed the filing answers it.
    if ((await splitClaim(r, it))?.detail?.comment_id === a.comment_id) return null;
    // Outbound files them and retries a failure; a stopped process leaves nothing for a person to take over.
    if (splitFiling(it)) return { refuse: "an earlier `/approve` queued this split's phases for filing; this issue lists them once all are filed" };
  }
  if (it.blocked_on === "dependency") return { refuse: dependencyHoldRefusal(it.blocked_reason) };
  if (!awaitingSpec(it)) return { refuse: specNotWaiting(commandPhase(it)) };
  const spec = latestSpec(await r.listRuns(it.id));
  const phases = spec?.phases ?? null;
  if (phases && a.paths.length > 0) return { refuse: SPLIT_PATHS };
  // `N: <answer>` lines answer the spec's decisions (issue #526); a split's answers stay on its approval's tag.
  const ans = a.answers.split(a.note, spec?.decision_items ?? []);
  if ("refuse" in ans) return ans;
  if (phases) return { split: phases, note: ans.note, tag: ans.answers.length ? { ...a.tag, ...a.answers.detail(ans.answers) } : a.tag };
  const uncovered = uncoveredOptionPaths(spec?.decision_items ?? [], ans.answers, [...it.allowed_paths, ...a.paths]);
  if (uncovered.length > 0) return { refuse: optionPathsRefusal(uncovered) };
  const w = a.widen(a.paths);
  const detail = { ...(ans.note ? { note: ans.note } : {}), ...a.answers.detail(ans.answers), ...w.detail };
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, ...w.patch },
    actor: a.actor,
    reason: "spec_approved",
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    enqueue: { kind: "implement", idempotency_key: runKey(it, "implement") },
  };
}

/** A non-default answer's option paths outside the allowed paths: the decision's number and those paths. */
export type UncoveredOption = { n: number; paths: string[] };

/**
 * The extra paths of each non-default answer's option (design 04-spec-gate-commands, 2026-11-21) that `allowed` does
 * not cover, by decision. A default needs none: its paths are the spec's allowed_paths.
 */
export function uncoveredOptionPaths(decisions: readonly SpecDecision[], answers: readonly GateAnswer[], allowed: readonly string[]): UncoveredOption[] {
  return decisions.flatMap((d, i) => {
    const a = answers[i];
    if (!a || a.accepted_default) return [];
    const paths = (optionChange(d, a.answer)?.extra_paths ?? []).filter((p) => !isCovered(p, allowed));
    return paths.length > 0 ? [{ n: i + 1, paths }] : [];
  });
}

/**
 * The one refusal of an approval whose answer needs a path outside the allowed paths: it names each path and the
 * `/approve +paths` reply that allows them. Nothing widens on its own (owner answer, wi_80ba9d05).
 */
export function optionPathsRefusal(uncovered: readonly UncoveredOption[]): string {
  const paths = [...new Set(uncovered.flatMap((u) => u.paths))];
  const which = uncovered.map((u) => `decision ${u.n}`).join(", ");
  const reply = retryPathsReply(paths, "/approve") ?? `/approve +paths ${paths.join(" ")}`;
  return `the answer to ${which} needs ${paths.map((p) => `\`${p}\``).join(", ")} outside the allowed paths, so nothing was queued and nothing widened; reply \`${reply}\` with the same answers to allow ${paths.length === 1 ? "it" : "them"}, or pick another answer`;
}

/** Where the floor-blocked implement run (the item's newest one) kept its synced head (design 05-restart-asks), for `/approve`'s run. */
export function floorWip(runs: readonly Pick<Run, "kind" | "outcome">[]): WipRef | undefined {
  const o = runs.filter((r) => r.kind === "implement" && r.outcome).at(-1)?.outcome;
  return o?.status === "succeeded" && o.data.floor_block === true ? (o.data.wip as WipRef | undefined) : undefined;
}

/** The gate commands a block takes: approve, reject, revise, retry (the comment command events). */
type GateKind = "spec_approved" | "spec_rejected" | "revise_requested" | "retry_requested";

/**
 * A command on a floor_tier block (design §4). `/approve` raises the tier to the one the floor needs (never lowers
 * it; a `+paths` under a higher floor raises it further, issue #280), clears the block and enqueues implement under a
 * new key (restart_count + 1), so it is not a no-op, handed `wip` (where the blocked run kept its commits, design §5
 * Restarts) so it starts from them. `/reject` closes the item. `/retry` is refused: a floor block is not a failed run.
 */
export function floorCommand(kind: GateKind, it: WorkItem, actor: Actor, need: number | null, note: string | null, w: Widened, wip?: WipRef): Checked {
  if (kind === "retry_requested") return { refuse: `the item is ${phaseLabel("floor_tier")}, which is not a failed run; reply \`/approve\` to raise its tier` };
  if (kind === "revise_requested") {
    return { refuse: `the item is ${phaseLabel("floor_tier")}, not waiting on a spec; reply \`/approve\` to raise its tier or \`/reject <reason>\` to close` };
  }
  if (kind === "spec_rejected") return { patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor, reason: "floor_rejected" };
  if (it.stage !== "RUNNING" || need === null) return { refuse: "the floor block has no recorded tier to approve" };
  const next = { ...it, tier: effectiveTier(it.tier, need as Tier, w.patch.tier), restart_count: it.restart_count + 1 };
  return {
    patch: { ...w.patch, tier: next.tier, restart_count: next.restart_count, blocked_on: "none", blocked_reason: null },
    actor,
    reason: "floor_tier_approved",
    detail: { previous_tier: it.tier, tier: next.tier, ...(note ? { note } : {}), ...w.detail },
    enqueue: { kind: "implement", idempotency_key: runKey(next, "implement"), ...(wip ? { input: { wip } } : {}) },
  };
}

/**
 * A command on a `rule_of_two` block (RFC 0015 §8). A person's `/approve` queues the held run (its key, input and
 * not-before as held, from the state change that held it) and clears the block; `/reject` closes the item. Any other
 * command, and `/approve +paths`, is refused.
 */
export function ruleOfTwoCommand(kind: GateKind, it: WorkItem, actor: Actor, note: string | null, paths: readonly string[], changes: readonly StateChange[]): Checked {
  if (kind === "spec_rejected") {
    return { patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor, reason: "rule_of_two_rejected" };
  }
  if (kind !== "spec_approved" || paths.length > 0) return { refuse: RULE_OF_TWO_WAITS };
  const held = changes.filter((c) => c.detail?.held_by === RULE_OF_TWO).at(-1)?.detail;
  if (typeof held?.held_run_kind !== "string" || typeof held.held_run_key !== "string") return { refuse: "the Rule of Two block has no held run" };
  const run: Omit<NewRun, "work_item_id"> = {
    kind: held.held_run_kind as RunKind,
    idempotency_key: held.held_run_key,
    ...(typeof held.held_run_input === "string" ? { input: JSON.parse(held.held_run_input) as RunInput } : {}),
    ...(typeof held.held_run_not_before === "string" ? { not_before: held.held_run_not_before as Timestamp } : {}),
  };
  return { patch: { blocked_on: "none", blocked_reason: null }, actor, reason: "rule_of_two_approved", ...(note ? { detail: { note } } : {}), enqueue: run };
}

/**
 * A spec decision (approve, reject, revise) gets the standing-approval detail (design 05-standing-approvals): gate,
 * tier, kind (`kind`: read only for a spec decision), outcome, whether the spec changed, and the deciding user's ID.
 * Any other check's answer as it is.
 */
export async function specDecision<D extends Checked>(it: WorkItem, d: D, kind: () => Promise<SpecKind>): Promise<D> {
  if (!d || "refuse" in d) return d;
  const outcome = SPEC_DECISIONS[d.reason];
  if (!outcome) return d;
  const gate = specDecisionDetail({ tier: it.tier, kind: await kind(), outcome, spec_changed: specChanged(outcome, d.patch), actor: d.actor });
  return { ...d, detail: { ...d.detail, ...gate } } as D;
}

/** The spec kind of `it` from its latest spec in the store: a phase, a split (its spec proposes phases) or single. */
async function specKindOf(r: ItemReads, it: WorkItem): Promise<SpecKind> {
  return specKind(it, it.parent_id === null && (latestSpec(await r.listRuns(it.id))?.phases ?? null) !== null);
}

/** The run a request-time approval left to the controller (its QUEUED_RUN detail), or null. */
export function queuedRun(c: Pick<StateChange, "detail">): Omit<NewRun, "work_item_id"> | null {
  const raw = c.detail?.[QUEUED_RUN];
  return typeof raw === "string" ? (JSON.parse(raw) as Omit<NewRun, "work_item_id">) : null;
}

// The merge gate.

/** In the merge queue or at the forge's merge since its Merge was pressed (blocked on those checks, not on a person). */
export function mergeQueued(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "ci" && it.blocked_reason === MERGE_QUEUED;
}

/** Waiting for its merge: ready for a person's Merge (merge_pending), or that Merge taken by the controller (merge_queued). */
export function awaitingMerge(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">): boolean {
  return (it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending") || mergeQueued(it);
}

/** Parked on its merge conflict for a person (REVIEW / human / merge_conflict_pending): its automatic resolve stopped. */
export function conflictParked(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === MERGE_CONFLICT_PENDING;
}

/**
 * Held for `recurring_failure` (design 05-alarms) in REVIEW, and its last failed run is a resolve run: its resolve on
 * the merge conflict stalled or failed, so the local merge treats it as parked on that conflict (design §5 Merge
 * conflict, 2026-11-21) and a branch the owner fixed by hand goes to its fresh review.
 */
export function resolveHeld(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason">, runs: readonly Pick<Run, "kind" | "outcome" | "finished_at" | "updated_at">[]): boolean {
  if (it.stage !== "REVIEW" || it.blocked_on !== "human" || it.blocked_reason !== RECURRING_FAILURE) return false;
  const failed = runs.filter((r) => r.outcome?.status === "failed");
  const last = failed.reduce<(typeof failed)[number] | null>((a, r) => (a === null || (r.finished_at ?? r.updated_at) >= (a.finished_at ?? a.updated_at) ? r : a), null);
  return last?.kind === "resolve";
}

/** The reason of the owner's `factory merge` on an item a failed merge check stopped at max_loops: max_loops → merge_pending. */
export const MERGE_CHECK_AGAIN = "merge_check_again";

/**
 * Stopped at `max_loops` by a failed merge check (design 04-spec-gate-commands, 2026-11-23): a local item with no PR,
 * blocked on a human with max_loops, whose latest max_loops state change carries the merge queue's `entry_id`. A
 * max_loops from implement loops (a review or feedback round) carries none.
 */
export function mergeCheckStopped(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "change_ref">, changes: readonly Pick<StateChange, "reason" | "detail">[]): boolean {
  if (it.stage !== "REVIEW" || it.blocked_on !== "human" || it.blocked_reason !== "max_loops" || it.change_ref !== null) return false;
  return typeof changes.filter((c) => c.reason === "max_loops").at(-1)?.detail?.entry_id === "string";
}

/**
 * The owner's `factory merge` on an item mergeCheckStopped: one state change back to merge_pending under
 * MERGE_CHECK_AGAIN, the owner as actor, so the change enters the merge queue for one more check. The loop count is
 * not checked; a failed check stops it at max_loops again. Null when the item no longer is there.
 */
export function mergeCheckAgain(it: WorkItem, changes: readonly StateChange[], actor: Actor): Transition | null {
  if (!mergeCheckStopped(it, changes)) return null;
  return { patch: { blocked_on: "human", blocked_reason: "merge_pending" }, actor, reason: MERGE_CHECK_AGAIN, detail: { loop_count: it.loop_count } };
}

/** `/help`'s line for `factory merge <id>` on an item mergeCheckStopped (src/core/commands.ts helpReply). */
export const MERGE_CHECK_HELP_LINE = "- `factory merge <id>` **(now)**: The owner checks the merged result once more and it merges when the check passes; the loop count does not block it, and a failed check stops it here again.";

/** The reason for `/retry` on an item mergeCheckStopped: no run failed, and `factory merge` is a choice. */
export function mergeCheckRetryRefusal(id: string): string {
  return "the item reached the review loop limit because its merged result failed the merge check, so there is no failed run to retry; " +
    `run \`factory merge ${id}\` to check the merged result once more, \`/revise <feedback>\` for a new spec, or \`/reject <reason>\` to close`;
}

/** Which merge an item takes (design 05-sources): a local item with no PR the local merge, any other its PR's merge. */
export function mergeRoute(it: Pick<WorkItem, "source" | "change_ref">): "local" | "pr" {
  return it.source.type === LOCAL_SOURCE && it.change_ref === null ? "local" : "pr";
}

/** How a refusal names a change by its ref: the forge's form (core writes no ref form of its own: tests/change-ref-forms). */
export type ChangeName = (change_ref: string) => string;

/**
 * Why the local merge does not apply to `it` (`canMerge`: a sandbox that merges locally), or null. A local item parked
 * on its merge conflict passes too (design §5 Merge conflict, 2026-11-20): the controller probes its branch as it is,
 * so a branch fixed by hand goes to a fresh review and one that still conflicts is refused with its files. `held`: it
 * is held after its resolve failed (resolveHeld), which passes like a parked one (2026-11-21), or a failed merge check
 * stopped it at max_loops (mergeCheckStopped, design 04-spec-gate-commands 2026-11-23), which the owner's merge
 * sends to one more check. A max_loops from implement loops is refused.
 */
export function localMergeRefusal(it: WorkItem, canMerge: boolean, name: ChangeName, held = false): string | null {
  if (!(awaitingMerge(it) || conflictParked(it) || held) || it.change_ref !== null) {
    const at = [it.stage, it.blocked_reason].filter(Boolean).join(", ");
    return it.change_ref !== null
      ? `${it.id} has ${name(it.change_ref)}: merge the PR instead`
      : `${it.id} is not waiting for a merge (${at}); \`factory merge\` applies once its review passed (merge_pending)`;
  }
  return canMerge ? null : "this controller has no sandbox that can merge locally";
}

/** Why the PR's merge does not apply to `it` (`forge`: one is selected), or null. */
export function prMergeRefusal(it: WorkItem, forge: boolean, name: ChangeName): string | null {
  const pr = prNumber(it);
  if (!awaitingMerge(it) || pr === null) {
    const at = [it.stage, it.blocked_reason].filter(Boolean).join(", ");
    return `${it.id} is not waiting for a merge (${at}); Merge applies once its PR passed review (merge_pending)`;
  }
  if (!forge) return `no forge is selected (\`plugins.forge\`), so the factory cannot merge ${name(String(pr))}`;
  return it.last_head_sha === null ? `no reviewed head is recorded for ${name(String(pr))}` : null;
}

/**
 * A local merge's entry into the merge queue: merge_pending → merge_queued, tagged with `detail`, before its first
 * check runs. The dashboard's Merge passes its request seq (`app_request`) before its merge runs; the queue, for
 * `factory merge`, `/merge` and auto mode, passes the merge key when it creates the entry. Null when the item does
 * not wait at merge_pending (queued already, or moved on), or takes its PR's merge: the forge merges it in one call,
 * with no queue to wait in.
 */
export function mergeEntered(it: WorkItem, actor: Actor, detail: StateChangeDetail): Transition | null {
  if (!awaitingMerge(it) || mergeQueued(it) || mergeRoute(it) !== "local") return null;
  return { patch: { blocked_on: "ci", blocked_reason: MERGE_QUEUED }, actor, reason: MERGE_REQUESTED, detail };
}

/** Whether a dashboard Merge for the item, other than request `seq`, is stored and not handled yet: the item reads "Merging…". */
export function mergeRequested(requests: readonly AppCommandRequest[], seq: number | null = null): boolean {
  return requests.some((q) => q.command === "merge" && q.handled_at === null && q.seq !== seq && (seq === null || q.seq < seq));
}

/** The seq of the oldest dashboard Merge for the item stored and not handled yet, or null: its place in the merge line. */
export function pendingMerge(requests: readonly AppCommandRequest[]): number | null {
  return requests.reduce<number | null>((a, q) => (q.command === "merge" && q.handled_at === null && (a === null || q.seq < a) ? q.seq : a), null);
}

/**
 * The run kind of a request-time approval whose run the controller has not queued yet, or null (design
 * 09-dashboard-item-commands): the item's newest state change carries the run it left (QUEUED_RUN) and the item is
 * open and unblocked. The controller's APPROVED_RUN_QUEUED change (or any later change) ends it. Read from the
 * item's state changes only, so it costs no store read of its own.
 */
export function pendingApproval(it: Pick<WorkItem, "stage" | "blocked_on">, changes: readonly Pick<StateChange, "detail">[]): RunKind | null {
  const newest = changes.at(-1);
  if (!newest || it.stage === "CLOSED" || it.blocked_on !== "none") return null;
  return queuedRun(newest)?.kind ?? null;
}

/** The newest dashboard Merge requests read for an item: enough to find one still pending. */
export const MERGE_REQUESTS_READ = 20;

/** A merge that was refused or failed after its Merge was pressed: the item waits for a person again, with why. */
export function mergeReturned(it: WorkItem, refusal: string, actor: Actor): Transition | null {
  if (!mergeQueued(it)) return null;
  return { patch: { blocked_on: "human", blocked_reason: "merge_pending" }, actor, reason: MERGE_RETURNED, detail: { refusal: refusal.slice(0, MAX_RETURNED_CHARS) } };
}

// The request path.

/** What the request path needs: the store, the egress scanner, the owner check and the merge facts of this process. */
export interface RequestDeps<A extends GateAnswer> {
  store: Pick<FactoryStore, "getWorkItem" | "listRuns" | "listStateChanges" | "transition" | "markAppCommandRequest" | "listAppCommandRequestsForItem">;
  scanner: EgressScanner;
  /** The owner check of the request's actor: approve_spec for Approve, approve_merge for Merge. */
  allowed: (action: "approve_spec" | "approve_merge") => Promise<AuthDecision>;
  answers: NoteAnswers<A>;
  /** How a refusal names a PR. */
  changeName: ChangeName;
  /** Whether a forge is selected and whether the controller's sandbox merges locally; absent: not known here. */
  forge?: boolean | undefined;
  localMerge?: boolean | undefined;
}

/**
 * How the request path answered: `applied` (the transition is stored), `already_done` (an earlier request made it),
 * `refused` (the controller's words), or `queued` (left to the controller: a Merge that passed its gate, a split's
 * filing, a coordination hold).
 */
export type RequestOutcome =
  | { outcome: "applied" | "already_done" | "queued"; item: WorkItem; label: string | null }
  | { outcome: "refused"; item: WorkItem; label: null; refusal: string };

/** Conflict retries of the request's conditional write. */
const MAX_TRIES = 5;

/**
 * The dashboard's Approve or Merge, applied while its request is handled (design 09-dashboard-app, 2026-11-15). The
 * owner check first, then the note scan, then on the item as read: an earlier request's transition is `already_done`,
 * the approve or merge gate refuses or decides, and the transition is one conditional write on the version read
 * (a conflict reads again, so a double click or a second worker leaves one). The approval's run is left to the
 * controller (QUEUED_RUN); the request row stays pending for the controller, which finds the transition and does the
 * rest once. Merge writes nothing: past its gate it is answered "Merging…" and its pending row is the controller's to
 * queue; an earlier pending Merge of the item, or one the controller queued, makes it `already_done`. A refusal or an
 * earlier request's transition marks the row handled here, so the controller posts nothing.
 */
export async function requestTransition<A extends GateAnswer>(d: RequestDeps<A>, r: AppCommandRequest, item: WorkItem): Promise<RequestOutcome> {
  const merge = r.command === "merge";
  const name = merge ? "merge" : "/approve";
  const finish = async (it: WorkItem, refusal: string | null): Promise<RequestOutcome> => {
    const text = refusal === null ? null : refusalText(name, refusal);
    await d.store.markAppCommandRequest(r.seq, text);
    return text === null ? { outcome: "already_done", item: it, label: null } : { outcome: "refused", item: it, label: null, refusal: text };
  };
  const grant = await d.allowed(merge ? "approve_merge" : "approve_spec");
  if (!grant.allow) return finish(item, refusalReply(grant.reason));
  if (merge) {
    const it = (await d.store.getWorkItem(item.id)) ?? item;
    if (mergeQueued(it) || mergeRequested(await d.store.listAppCommandRequestsForItem(it.id, MERGE_REQUESTS_READ), r.seq)) {
      await d.store.markAppCommandRequest(r.seq, null);
      return { outcome: "already_done", item: it, label: ROW_LABELS.merging };
    }
    const refusal = mergeRoute(it) === "local"
      ? localMergeRefusal(it, d.localMerge !== false, d.changeName, it.blocked_reason === RECURRING_FAILURE && resolveHeld(it, await d.store.listRuns(it.id)))
      : prMergeRefusal(it, d.forge !== false, d.changeName);
    return refusal !== null ? finish(it, refusal) : { outcome: "queued", item: it, label: ROW_LABELS.merging };
  }
  const actor: Actor = { kind: "user", id: r.actor };
  const tag = { [APP_REQUEST]: r.seq };
  const input = await commandNote((t) => d.scanner.scan("comment", t), typeof r.args.note === "string" ? r.args.note : undefined, name, false);
  if ("refuse" in input) return finish(item, input.refuse);
  for (let i = 0; i < MAX_TRIES; i++) {
    const it = await d.store.getWorkItem(item.id);
    if (!it) return finish(item, "the work item was not found");
    if (approvedAlready(await d.store.listStateChanges(it.id), it)) return finish(it, null);
    if (approvesHold(it)) return { outcome: "queued", item: it, label: null };
    const a = await approveCheck(d.store, it, { actor, note: input.note, paths: [], comment_id: `app-${r.seq}`, tag, widen: () => NOT_WIDENED, answers: d.answers });
    if (a === null) return finish(it, null);
    if ("refuse" in a) return finish(it, a.refuse);
    if ("split" in a) return { outcome: "queued", item: it, label: null };
    const want = withTag(await specDecision(it, a, () => specKindOf(d.store, it)), tag)!;
    const { enqueue, ...rest } = want;
    const t = await d.store.transition({ ...rest, ...(enqueue ? { detail: { ...rest.detail, [QUEUED_RUN]: JSON.stringify(enqueue) } } : {}), id: it.id, expected_version: it.version });
    if (t.ok) return { outcome: "applied", item: t.item, label: ROW_LABELS.approved };
    if (t.reason !== "version_conflict") return { outcome: "queued", item: it, label: null };
  }
  return { outcome: "queued", item: (await d.store.getWorkItem(item.id)) ?? item, label: null };
}
