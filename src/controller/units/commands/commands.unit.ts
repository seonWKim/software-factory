// Gate commands from any source (approve, reject, revise, retry, resolve, budget), help, plain comments, links and PR feedback.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { BUDGET_CHECKPOINT, parseBudgetAmount } from "../../../core/budget.js";
import { prNumber } from "../../../core/change-ref.js";
import {
  CHECKPOINT_REFUSAL, CLOSED_REFUSAL, appliesLocally, appliesOnPr, commandFooter, commandPhase, commandSpec, commandState, dependencyHoldRefusal, failedRunKind, helpReply,
  latestSpec, parseCommandPaths, parseLink, phaseLabel, refusalText, specNotWaiting, unknownCommandReply,
} from "../../../core/commands.js";
import { AGENT_NEEDS_HUMAN, REPEATED_FAILURE, blockingRunKind, effectiveTier, floorTier, isCovered, runKey, workItemIdFromBranch } from "../../../core/policy.js";
import { commandEvent, commandIdentity, syncedCommand } from "../../../core/command-inbox.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../../../core/local-merge.js";
import { localIdentity } from "../../../core/local-cli.js";
import { SPEC_DECISIONS, specChanged, specDecisionDetail, specKind } from "../../../core/standing.js";
import { CONFIRM_COMMAND, INTERPRET_MAX_CHARS, INTERPRET_MAX_ITEMS, interpret, interpretReply, interpretTexts, openItems, proposalEvent } from "../../../core/interpret.js";
import { type Actor, type RunKind, type StateChangeDetail, type Tier, type UserId, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { CliCommand, FactoryStore, RedeemLinkResult } from "../../../interfaces/factory-store.js";
import type { ForgeEvent } from "../../../interfaces/forge.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { answersDetail, splitAnswers } from "../../../shared/command-notes.js";
import { type Decision, type Refusal, type Widening, NO_WIDENING, type CommandEvent, COMMAND, MAX_CONFLICT_RETRIES, MAX_FEEDBACK_CHARS, FLOOR_TIER, RULE_OF_TWO, CONFLICT_PENDING, SOURCE_CLOSE_PENDING, retry, splitFiling, splitFilingFailed, splitOpen, footerAfter } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { confirmProposal, storeProposals } from "./proposals.js";

type AppSender = { user_id: UserId; passport?: Extract<CommandEvent, { kind: "spec_approved" }>["approver"]["passport"] } | null;
type ItemCommandEvent = Exclude<CommandEvent, { kind: "budget_continue" }>;
type ResolveEvent = Extract<SourceEvent, { kind: "resolve_requested" }>;
type PrReviewEvent = Extract<ForgeEvent, { kind: "pr_changes_requested" }>;
type InfoEvent = Extract<SourceEvent, { kind: "help_requested" | "unknown_command" }>;
type PlainCommentEvent = Extract<SourceEvent, { kind: "plain_comment" }>;
/** Tells applyCommand to re-read the item and try again (a version conflict or a concurrent answer). */
const RETRY = Symbol("retry");
/** Why a `/link` code was refused, as the reply says it. Never names the code. */
const LINK_REFUSALS: Record<Exclude<RedeemLinkResult, { ok: true }>["reason"], string> = {
  invalid: "the code is wrong",
  expired: "the code has expired (codes work for 10 minutes)",
  used: "the code was already used",
  locked: "the code is locked after too many wrong codes",
  already_linked: "this account is already linked to another factory user",
};
/** The refusal of an `/approve +paths` on a split spec (issue #280): the approval files sub-issues, it implements nothing. */
const SPLIT_PATHS = "`+paths` does not apply to a split spec, whose `/approve` files one sub-issue per phase; reply `/approve` without `+paths`, then add paths on a phase's issue";
/** Characters of an approval note kept on the state change (design §4). */
const MAX_NOTE_CHARS = 2000;
/** State change reasons of PR feedback that started an implement run (design §4). */
const PR_REVISE = "pr_revise_requested";
const PR_CHANGES = "pr_changes_requested";
/**
 * The feedback of a "Request changes" review: its body, then each line comment as `path:line` and its text.
 * Untrusted text; the worker fences it.
 */
function reviewFeedback(e: PrReviewEvent): string {
  const parts = e.body.trim() ? [e.body.trim()] : [];
  const lines = e.comments.filter((c) => c.body.trim()).map((c) => {
    const where = c.line === null ? c.path : `${c.path}:${c.line}`;
    return `- ${where}: ${c.body.trim().replace(/\r?\n/g, "\n  ")}`;
  });
  if (lines.length) parts.push(["Line comments:", ...lines].join("\n"));
  return parts.join("\n\n");
}
/**
 * A spec waiting for `/approve`, `/reject` or `/revise`; past the revision limit, only the first two apply. A split
 * whose phase filing outbound gave up waits too: `/approve` again files the rest under new keys, none twice.
 */
function awaitingSpec(it: WorkItem): boolean {
  return it.stage === "READY" && (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions" || splitFilingFailed(it));
}
/**
 * `/resolve [notes]` (design §5 Merge conflict). Only on an item waiting on a merge conflict, or on one whose resolve
 * run asked for a human (agent_needs_human, decided 2026-11-07). Starts a resolve
 * run under a new key: restart_count + 1, as /retry does, since the run key is per (loop, restart) and a second
 * /resolve would otherwise be a silent no-op. The notes (scanned and capped, the `+paths` line split off) go on
 * the run for the worker; they are untrusted. A `+paths` widens allowed_paths in the same transition (`w`).
 */
function resolveCommand(e: ResolveEvent, it: WorkItem, actor: Actor, resolveAsked: boolean, note: string | null, w: Widening): Decision | Refusal {
  // Also the answer to a resolve run that asked for a human (agent_needs_human): the reply is its notes.
  const asked = resolveAsked && it.blocked_on === "human" && it.blocked_reason === AGENT_NEEDS_HUMAN;
  if (!conflictPending(it) && !asked) {
    return {
      refuse: `the item is not waiting on a merge conflict (it is ${phaseLabel(commandPhase(it))}); ` +
        `\`/resolve\` applies only when the ${phaseLabel("merge_conflict")}`,
    };
  }
  const next = { ...it, restart_count: it.restart_count + 1 };
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: next.restart_count, ...w.patch },
    actor,
    reason: "resolve_requested",
    detail: { comment_id: e.comment_id, ...w.detail },
    enqueue: { kind: "resolve", idempotency_key: runKey(next, "resolve"), input: { notes: note ?? "" } },
  };
}
/** A PR whose base no longer merges cleanly, waiting for a human (set by the update run, design §5). */
function conflictPending(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === CONFLICT_PENDING;
}
/** `d` with `tag` added to its state change detail; a refusal or no-op as it is. */
const withTag = (d: Decision | Refusal, tag: StateChangeDetail | null): Decision | Refusal => (!tag || !d || "refuse" in d ? d : { ...d, detail: { ...d.detail, ...tag } });
/**
 * A command on a floor_tier block (design §4). `/approve` raises the tier to the one the floor needs (never
 * lowers it), clears the block and enqueues implement under a new key (restart_count + 1), so it is not a
 * no-op. `/reject` closes the item. `/retry` is refused: a floor block is not a failed run.
 */
function floorCommand(
  e: ItemCommandEvent, it: WorkItem, actor: Actor, need: number | null, note: string | null, w: Widening,
): Decision | Refusal {
  if (e.kind === "retry_requested") {
    return { refuse: `the item is ${phaseLabel("floor_tier")}, which is not a failed run; reply \`/approve\` to raise its tier` };
  }
  if (e.kind === "revise_requested") {
    return { refuse: `the item is ${phaseLabel("floor_tier")}, not waiting on a spec; reply \`/approve\` to raise its tier or \`/reject <reason>\` to close` };
  }
  if (e.kind === "spec_rejected") {
    return { patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null }, actor, reason: "floor_rejected" };
  }
  if (it.stage !== "RUNNING" || need === null) return { refuse: "the floor block has no recorded tier to approve" };
  // A `+paths` under a higher floor raises the tier further (issue #280).
  const next = { ...it, tier: effectiveTier(it.tier, need as Tier, w.patch.tier), restart_count: it.restart_count + 1 };
  return {
    patch: { ...w.patch, tier: next.tier, restart_count: next.restart_count, blocked_on: "none", blocked_reason: null },
    actor,
    reason: "floor_tier_approved",
    detail: { previous_tier: it.tier, tier: next.tier, ...(note ? { note } : {}), ...w.detail },
    enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
  };
}

/** Gate commands from any source (approve, reject, revise, retry, resolve, budget), help, plain comments, links and PR feedback. */
export class CommandsUnit {
  constructor(private readonly c: Ctx) {}

  async handleInboxCommand(c: CliCommand): Promise<void> {
    if (c.origin === "app") {
      // An app request (RFC 0015 D7): its own row, or a row from before the merge that points at it by seq.
      const r = await this.c.k.reader.getAppCommandRequest(typeof c.args.app_request === "number" ? c.args.app_request : c.key);
      if (r && r.handled_at === null) await this.c.unit("app-requests").applyAppRequest(r);
      return;
    }
    const synced = syncedCommand(c);
    if (synced) {
      // A source's own command (issue #284): applied only where that source's adapter runs, and a failure is logged
      // and passed like a polled event's, so a sync plugin's outage never holds the local commands after it.
      const e = synced.event;
      if (e && this.c.k.hasAdapter(synced.source.type)) await this.c.k.guard(`event:${e.kind}`, () => this.c.dispatch(e));
      return;
    }
    const id = c.args.item;
    if (typeof id !== "string" || id === "") return;
    const item = await this.c.k.reader.getWorkItem(id as WorkItemId);
    // Any source's item (design 05-sources, CLI intake): identity provider `local`, judged by the local auth plugin; never waits on its source.
    if (!item) return;
    // A proposal's confirm press (proposals.ts) and `factory merge <id>` (local items only) skip the comment mapping.
    if (c.command === CONFIRM_COMMAND) return confirmProposal(this.c, c, item, { event: (r, s) => proposalEvent(r, s, commandIdentity(c, localIdentity(c.actor))), say: refusalText });
    if (c.command === MERGE_COMMAND) {
      if (item.source.type === LOCAL_SOURCE) await this.c.unit("local-merge").mergeLocal(item.id, commandIdentity(c, localIdentity(c.actor)), c.key);
      return;
    }
    const e = commandEvent(c, item.source);
    if (e) await this.c.dispatch(e);
  }

  /**
   * A human command on a work item. Applied or not, the comment gets 👀; a refusal also gets one reply
   * saying why, keyed on the comment id. Commands on issues that are not work items are ignored entirely
   * (no reaction, no reply): they may be ordinary conversation on an unrelated issue.
   */
  async handleCommand(e: CommandEvent): Promise<void> {
    const onPr = (e.kind === "resolve_requested" || e.kind === "revise_requested") && e.pr ? e.pr : null;
    const item = onPr ? await this.itemOfPr(onPr) : await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    // A `/revise` on the PR of a closed item is ordinary conversation now: no reaction, no reply (design §4).
    if (e.kind === "revise_requested" && onPr && item.stage === "CLOSED") return;
    const refusal = await this.gateCommand(item, e);
    await this.c.unit("outbox").markSeen(e.source, e.comment_id);
    if (refusal === null) return;
    this.c.k.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    // A /resolve or /revise sent on the PR is answered on the PR; every other command on the item's own issue.
    await this.c.unit("outbox").post(
      item,
      onPr ? e.source : item.source,
      refusalText(COMMAND[e.kind], refusal),
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /** A gate command from a comment (`app` null) or an app request (its user and edge passport, checked locally), design §4: `approve_spec`,
   * the note (a comment's `+paths` too) through G5, the transition (`tag` on its change), the standing follow-up, a reject's close. */
  async gateCommand(item: WorkItem, e: CommandEvent, app: AppSender = null, tag: StateChangeDetail | null = null): Promise<string | null> {
    const who = e.kind === "spec_approved" || e.kind === "spec_rejected" || e.kind === "budget_continue" ? e.approver : e.requester;
    const principal = app ? await this.c.unit("auth").allowed({ user_id: app.user_id, attributes: {} }, "approve_spec", item.id, true, app.passport)
      : await this.c.unit("auth").authorize(who, "approve_spec", item.id);
    if ("refuse" in principal) return principal.refuse;
    const input = await this.commandInput(item.id, e, app === null);
    if ("refuse" in input) return input.refuse;
    const refusal = await this.applyCommand(item.id, e, { kind: "user", id: principal.user_id }, input.note, tag, input.paths);
    if (refusal === null) await this.c.k.guard("standing", () => this.c.unit("standing").afterSpecCommand(item.id, e, principal.user_id));
    if (refusal === null && e.kind === "spec_rejected") await this.c.unit("closes").afterReject(item.id);
    return refusal;
  }

  /**
   * The work item of a PR: a factory PR's from its head branch, any other PR's adopted item by number; null
   * unless that item's PR is this one.
   */
  async itemOfPr(pr: { change_ref: string; head_branch: string }): Promise<WorkItem | null> {
    const id = workItemIdFromBranch(pr.head_branch, this.c.k.cfg.branch_prefix);
    const it = id
      ? await this.c.k.reader.getWorkItem(id as WorkItemId)
      : await this.c.k.reader.getWorkItemByPr(this.c.k.project(), pr.change_ref).then((x) => (x?.origin === "adopted" ? x : null));
    return it && it.change_ref === pr.change_ref ? it : null;
  }

  /**
   * A "Request changes" review on a PR (design §4): its body and line comments are feedback for one implement
   * run, as a `/revise` on the PR is. A PR with no open item, and a reviewer without write permission, get
   * nothing: no change, no reply. A review already applied (a later poll, a restart) changes nothing. A writer's
   * review in a state that cannot take it gets one reply on the PR, keyed on the review.
   */
  async handlePrReview(e: PrReviewEvent): Promise<void> {
    const item = await this.itemOfPr(e);
    if (!item || item.stage === "CLOSED") return;
    const principal = await this.c.unit("auth").authorize(e.reviewer, "approve_spec", item.id);
    if ("refuse" in principal) {
      this.c.k.d.log.info("review ignored", { work_item_id: item.id, pr_number: prNumber(e), reason: principal.refuse });
      return;
    }
    const actor: Actor = { kind: "user", id: principal.user_id };
    const refusal = await this.c.unit("transitions").decide(item.id, (it) =>
      this.prFeedback(it, { text: reviewFeedback(e), actor, reason: PR_CHANGES, change_ref: e.change_ref, key: { review_id: e.review_id } }));
    if (refusal === null) return;
    this.c.k.d.log.info("review refused", { work_item_id: item.id, pr_number: prNumber(e), reason: refusal });
    await this.c.unit("outbox").post(item, e.source, `The review's requested changes were not applied: ${refusal}.`, `<!-- factory:refused:review-${e.review_id} -->`);
  }

  /**
   * Feedback on a PR (design §4): a `/revise` on the PR or a "Request changes" review, or a local item's `/revise` (`change_ref` null, issue #563). Accepted while it
   * waits for a human merge or its review run failed: the item goes to RUNNING with one implement run on its
   * branch, keyed on the next loop (loop_count + 1), with the feedback as its input and on the state change.
   * At the loop limit the item blocks on a human with `max_loops` and starts nothing. `key` (the comment or the
   * review id) is recorded on the state change, so the same feedback delivered again changes nothing.
   */
  async prFeedback(
    it: WorkItem,
    f: { text: string; actor: Actor; reason: string; change_ref: string | null; key: { comment_id: string } | { review_id: string } },
  ): Promise<Decision | Refusal> {
    if (it.stage === "CLOSED" || it.change_ref !== f.change_ref) return null;
    const [field, value] = Object.entries(f.key)[0] as [string, string];
    const done = (await this.c.k.reader.listStateChanges(it.id)).some(
      (c) => (c.reason === f.reason || c.reason === "max_loops") && c.detail?.[field] === value);
    if (done) return null;
    const [phase, local] = [commandPhase(it), f.change_ref === null];
    const accepted = (local ? commandSpec("revise").local_phases : commandSpec("revise").pr_phases) ?? [];
    if (!accepted.includes(phase)) {
      const where = local ? "on a local item" : "on the PR";
      return { refuse: `the item is ${phaseLabel(phase)}; feedback ${where} is taken only when it is ${accepted.map(phaseLabel).join(" or ")}` };
    }
    const feedback = f.text.trim();
    if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
    const scan = await this.c.k.d.scanner.scan("comment", feedback);
    if (!scan.clean) {
      const rules = scan.findings.map((x) => x.rule).join(",");
      this.c.k.d.log.warn("PR feedback blocked by the egress scan", { work_item_id: it.id, rules });
      return { refuse: `the feedback was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed` };
    }
    const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
    const detail = { ...f.key, ...(local ? {} : { pr_number: prNumber(f) }) };
    const limit = this.c.k.cfg.max_loops;
    if (it.loop_count + 1 >= limit) {
      const patch = { blocked_on: "human" as const, blocked_reason: "max_loops" };
      await this.c.unit("outbox").comment(it, `max-loops:${field}-${value}`, [
        `The ${local ? "" : "PR "}feedback would start loop ${it.loop_count + 1} (limit \`max_loops\` = ${limit}), so the factory started no implement run. A human needs to decide.`,
        "",
        footerAfter(it, patch),
      ].join("\n"));
      return { patch, actor: f.actor, reason: "max_loops", detail };
    }
    const next = { ...it, loop_count: it.loop_count + 1 };
    return {
      patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: next.loop_count, failure_comment_url: null },
      actor: f.actor,
      reason: f.reason,
      detail: { ...detail, feedback: kept },
      enqueue: { kind: "implement", idempotency_key: runKey(next, "implement"), input: { notes: kept } },
    };
  }

  /**
   * `/budget` and `/reject` at a budget checkpoint answer it (design §6); every other command, and `/reject`
   * elsewhere, goes through `command`. Returns the refusal reason, else null.
   */
  async applyCommand(
    id: WorkItemId,
    e: CommandEvent,
    actor: Extract<Actor, { kind: "user" }>,
    note: string | null,
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.c.k.reader.getWorkItem(id);
      if (!it) return null;
      const atCheckpoint = it.stage !== "CLOSED" && it.blocked_reason === BUDGET_CHECKPOINT;
      if (atCheckpoint && (e.kind === "budget_continue" || e.kind === "spec_rejected")) {
        const r = await this.answerCheckpoint(it, e, actor);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "budget_continue") {
        return it.stage === "CLOSED" ? CLOSED_REFUSAL : "the work item is not at a budget checkpoint";
      }
      // `/approve` while implementing: lifts a coordination-cost hold on the queued implement run (design §5).
      if (e.kind === "spec_approved" && it.stage === "RUNNING" && it.blocked_on === "none") {
        // The held run is already queued with its paths; `+paths` does not change them (issue #280).
        if (paths.length > 0) return "`+paths` does not apply to an implement run held by coordination cost, since that run is already queued; reply `/approve` without `+paths`";
        const r = await this.approveHold(it, actor);
        if (r === RETRY) continue;
        return r;
      }
      if (e.kind === "retry_requested" && commandPhase(it) === "dependency_closed") return this.c.unit("coordination").retryDependencies(it, actor, note, paths);
      return this.c.unit("transitions").decide(id, async (x) =>
        withTag(await this.withSpecDecision(x, await this.command(e, x, actor, await this.floorTierNeeded(x), note, tag, paths)), tag));
    }
    this.c.k.d.log.warn("command gave up after conflicts", { work_item_id: id, command: e.kind });
    return null;
  }

  /**
   * A spec decision (approve, reject, revise) gets the standing-approval detail (design 05-standing-approvals):
   * gate, tier, kind, outcome, whether the spec changed, and the deciding user's ID. Any other decision as it is.
   */
  async withSpecDecision(it: WorkItem, d: Decision | Refusal): Promise<Decision | Refusal> {
    if (!d || "refuse" in d) return d;
    const outcome = SPEC_DECISIONS[d.reason];
    if (!outcome) return d;
    const kind = specKind(it, it.parent_id === null && (await this.c.unit("phases").specPhases(it)) !== null);
    const gate = specDecisionDetail({ tier: it.tier, kind, outcome, spec_changed: specChanged(outcome, d.patch), actor: d.actor });
    return { ...d, detail: { ...d.detail, ...gate } };
  }

  /**
   * The answer to the item's pending checkpoint, with the checkpoint row and its state change in one store
   * transaction. `/budget` grants the suggestion, or a whole number above the checkpoint's budget, and queues
   * the held run with its kind, key and not_before, unchecked. `/reject` closes the item and leaves the
   * branch and the PR as they are.
   */
  async answerCheckpoint(
    it: WorkItem,
    e: Extract<CommandEvent, { kind: "budget_continue" | "spec_rejected" }>,
    actor: Extract<Actor, { kind: "user" }>,
  ): Promise<string | null | typeof RETRY> {
    const cp = (await this.c.k.reader.listBudgetCheckpoints(it.id)).filter((c) => c.answer === "pending").at(-1);
    if (!cp) return "the budget checkpoint has no pending record";
    const common = { id: it.id, expected_version: it.version, actor, checkpoint_id: cp.id };
    let input: Parameters<FactoryStore["answerBudgetCheckpoint"]>[0];
    if (e.kind === "spec_rejected") {
      input = {
        ...common,
        // Like a spec reject, the comment and the issue close follow (finishReject), so the close says why.
        patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "upstream", blocked_reason: SOURCE_CLOSE_PENDING },
        reason: "budget_rejected",
        answer: "rejected",
        granted_budget: null,
        detail: { checkpoint_id: cp.id, held_run_key: cp.held_run_key },
      };
    } else {
      const amount = parseBudgetAmount(e.amount, cp.budget);
      if (!amount.ok) return amount.refuse;
      const granted = amount.value ?? cp.suggested_budget;
      const answer = amount.value === null ? "continued_suggested" : "continued_custom";
      input = {
        ...common,
        patch: { blocked_on: "none", blocked_reason: null },
        reason: "budget_continued",
        answer,
        granted_budget: granted,
        detail: { checkpoint_id: cp.id, answer, previous_budget: cp.budget, granted_budget: granted, held_run_key: cp.held_run_key },
        enqueue: { kind: cp.held_run_kind, idempotency_key: cp.held_run_key, not_before: cp.held_run_not_before },
      };
    }
    const r = await this.c.k.commitItem([], { kind: "budget_answer", input });
    if (r.ok) {
      this.c.k.d.log.info("transition", { work_item_id: it.id, reason: input.reason, version: r.item.version });
      await this.c.unit("outbox").showStatus(r.item);
      return null;
    }
    if (r.reason === "version_conflict" || r.reason === "checkpoint_not_pending") return RETRY;
    this.c.k.d.log.warn("transition refused", { work_item_id: it.id, reason: r.reason });
    return null;
  }

  /**
   * The approval note to store: trimmed, capped at MAX_NOTE_CHARS, null when empty. The whole note is
   * egress-scanned first; a finding refuses the approval, and neither the note nor the rule's match is kept.
   */
  async approvalNote(id: WorkItemId, raw: string | undefined, command = "/approve"): Promise<{ note: string | null } | Refusal> {
    const text = (raw ?? "").trim();
    if (!text) return { note: null };
    const scan = await this.c.k.d.scanner.scan("comment", text);
    if (!scan.clean) {
      const rules = scan.findings.map((f) => f.rule).join(",");
      this.c.k.d.log.warn("command note blocked by the egress scan; command refused", { work_item_id: id, command, rules });
      return {
        refuse: `the note was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed; post \`${command}\` again without the secret`,
      };
    }
    return { note: text.slice(0, MAX_NOTE_CHARS).trim() };
  }

  /**
   * The note and the `+paths` of an `/approve`, `/retry` or `/resolve` (design §4, issue #280); none for other
   * commands. The whole text is egress-scanned first (so a refusal never quotes a flagged path), then `+paths` is
   * split off and checked (unless `paths` is false: an app request's), the note what is left, capped. A finding or a bad path refuses it.
   */
  async commandInput(id: WorkItemId, e: CommandEvent, paths = true): Promise<{ note: string | null; paths: string[] } | Refusal> {
    if (e.kind !== "spec_approved" && e.kind !== "retry_requested" && e.kind !== "resolve_requested") return { note: null, paths: [] };
    const text = e.kind === "resolve_requested" ? e.notes : e.note;
    const scanned = await this.approvalNote(id, text, COMMAND[e.kind]);
    if ("refuse" in scanned) return scanned;
    const split = paths ? parseCommandPaths(text ?? "") : { note: text ?? "", paths: [] };
    if ("refuse" in split) return split;
    const note = split.note.slice(0, MAX_NOTE_CHARS).trim();
    return { note: note || null, paths: split.paths };
  }

  /**
   * The allowed paths a `+paths` widens to (issue #280): the paths no allowed path covers yet, added once each,
   * and a tier raised to the highest floor they touch, as triage does; never lowered. No new path: no change.
   */
  widen(it: WorkItem, paths: readonly string[]): Widening {
    const added = [...new Set(paths)].filter((p) => !isCovered(p, it.allowed_paths));
    if (added.length === 0) return NO_WIDENING;
    const floor = floorTier(added, this.c.k.settings(it.project).floors);
    const raised = floor !== null && (it.tier === null || floor > it.tier) ? { tier: floor } : {};
    return { patch: { allowed_paths: [...it.allowed_paths, ...added], ...raised }, detail: { added_paths: JSON.stringify(added) } };
  }

  /**
   * `/help` or an unknown command on a work item: 👀, then one reply keyed on the comment id, listing the
   * commands for the item's current state. Like other commands, ignored entirely on an issue that is not one.
   */
  async handleInfo(e: InfoEvent): Promise<void> {
    const item = await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    await this.c.unit("outbox").markSeen(e.source, e.comment_id);
    const state = await this.stateOf(item);
    const help = e.kind === "help_requested";
    await this.c.unit("outbox").post(
      item,
      item.source,
      help ? helpReply(state) : unknownCommandReply(e.command, state),
      `<!-- factory:${help ? "help" : "unknown"}:${e.comment_id} -->`,
    );
  }

  /**
   * A plain-language comment on a work item (design §4, issues #583, #584): at most one reply, keyed on the comment
   * id, that proposes commands for any open item as typed lines (stored once as pending proposal rows, which Slack shows
   * as buttons), answers a read, asks one question, or answers in plain words (chat) from the item's state label and
   * block reason. Only a failed or malformed model answer gets the canned line and the commands for the item's state.
   * Changes no item state: a proposal applies only when typed or confirmed by a press. In order: the item, the
   * commenter's permission (no model call and no reply without it), the length and open-item filters, the egress scan
   * of the message, the model call, the egress scan of each argument and of the chat answer. A scan finding stores
   * nothing and posts nothing.
   */
  async handlePlainComment(e: PlainCommentEvent): Promise<void> {
    const code = parseLink(e.body);
    if (code !== null) return this.handleLink(e, code);
    const llm = this.c.k.reader.llm;
    if (!llm) return;
    const item = await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (!item) return;
    const principal = await this.c.unit("auth").authorize(e.author, "approve_spec", item.id);
    if ("refuse" in principal) return;
    const text = e.body.trim();
    if (text === "" || text.length > INTERPRET_MAX_CHARS || item.stage === "CLOSED") return;
    if (!(await this.scanClean({ work_item_id: item.id }, "message", [text]))) return;
    const items = openItems(await this.c.k.reader.listWorkItemsWhere({ exclude_closed: true, limit: INTERPRET_MAX_ITEMS }));
    const result = await interpret(text, items, llm, { item: openItems([item])[0]!, blocked_reason: item.blocked_reason });
    if (!(await this.scanClean({ work_item_id: item.id }, "answer", interpretTexts(result)))) return;
    const body = interpretReply(result, await storeProposals(this.c, item, e, result))
      ?? ["The factory did not find a command in your comment, so nothing changed.", "", commandFooter(await this.stateOf(item))].join("\n");
    this.c.k.d.log.info("plain comment answered", { work_item_id: item.id, kind: result.kind });
    await this.c.unit("outbox").post(item, item.source, body, `<!-- factory:suggest:${e.comment_id} -->`);
  }

  /**
   * Whether every text of a plain message's `what` (the message, or the model's answer: proposed arguments, chat
   * text) passes the egress scan. A finding is logged with its rules and `where` (the item or source), never its text.
   * Also the intake unit's check of a top-level chat message.
   */
  async scanClean(where: Record<string, string>, what: "message" | "answer", texts: readonly string[]): Promise<boolean> {
    for (const t of texts) {
      const scan = await this.c.k.d.scanner.scan("comment", t);
      if (scan.clean) continue;
      const rules = scan.findings.map((f) => f.rule).join(",");
      this.c.k.d.log.warn(`plain message ${what} blocked by the egress scan`, { ...where, rules });
      return false;
    }
    return true;
  }

  /**
   * `/link <code>` (design 2026-11-01): links the commenter's account to the code's factory user. On any issue,
   * work item or not. One reply keyed on the comment id; the code is never logged or echoed. A wrong code is a
   * failed attempt (the store counts it) and links nothing. A redelivery of a used code reports the same link.
   */
  async handleLink(e: PlainCommentEvent, code: string): Promise<void> {
    const account = { provider: e.author.provider, subject: e.author.subject };
    const r = code === "" ? ({ ok: false, reason: "invalid" } as const) : await this.c.k.redeemLinkCode(code, account);
    await this.c.unit("outbox").markSeen(e.source, e.comment_id);
    this.c.k.d.log.info("link attempt", { provider: account.provider, ok: r.ok, ...(r.ok ? { user_id: r.user_id } : { reason: r.reason }) });
    const body = r.ok
      ? `This account is now linked to factory user \`${r.user_id}\`. Commands from it act as that user.`
      : `This account was not linked: ${LINK_REFUSALS[r.reason]}. Ask for a new code with \`factory link-code <user_id>\`.`;
    const item = await this.c.k.reader.getWorkItemBySource(e.source.type, e.source.id);
    if (item) await this.c.unit("outbox").post(item, e.source, body, `<!-- factory:link:${e.comment_id} -->`);
    else await this.c.unit("outbox").postWithoutItem(e.source, body, `<!-- factory:link:${e.comment_id} -->`);
  }

  /** For an item in a floor block, the tier its latest `floor_blocked` row says it needs; else null. */
  async floorTierNeeded(it: WorkItem): Promise<number | null> {
    if (it.blocked_reason !== FLOOR_TIER) return null;
    const row = (await this.c.k.reader.listStateChanges(it.id)).filter((c) => c.reason === "floor_blocked").at(-1);
    const tier = row?.detail?.required_tier;
    return typeof tier === "number" ? tier : null;
  }

  /**
   * The transition a command asks for, or why the item's current state cannot take it. Async only because
   * a `/revise` past the limit posts its comment before the transition (keyed, so a conflict re-run posts once).
   */
  async command(
    e: ItemCommandEvent,
    it: WorkItem,
    actor: Actor,
    floorNeed: number | null,
    note: string | null,
    tag: StateChangeDetail | null = null,
    paths: readonly string[] = [],
  ): Promise<Decision | Refusal> {
    if (e.kind === "resolve_requested") {
      return resolveCommand(e, it, actor, (await this.askedBy(it)) === "resolve", note, this.widen(it, paths));
    }
    // On the PR, in a Slack thread with a PR, or on a local item with no PR at the merge wait (its local branch, issue #563).
    const asFeedback = e.kind === "revise_requested" && (it.source.type === "slack_thread" ? appliesOnPr : appliesLocally)(commandSpec("revise"), commandState(it));
    if (e.kind === "revise_requested" && (e.pr || asFeedback)) {
      return this.prFeedback(it, { text: e.feedback, actor, reason: PR_REVISE, change_ref: e.pr?.change_ref ?? it.change_ref, key: { comment_id: e.comment_id } });
    }
    if (it.stage === "CLOSED") return { refuse: CLOSED_REFUSAL };
    if (it.blocked_reason === BUDGET_CHECKPOINT) return { refuse: CHECKPOINT_REFUSAL };
    if (it.blocked_reason === FLOOR_TIER) return floorCommand(e, it, actor, floorNeed, note, this.widen(it, paths));
    if (it.blocked_reason === RULE_OF_TWO) return this.c.unit("transitions").ruleOfTwoCommand(e, it, actor, note, paths);
    if (e.kind === "retry_requested") return retry(it, actor, await this.retryKind(it), note, paths.length > 0 ? this.widen(it, paths) : null);
    if (e.kind === "spec_approved" && (splitFiling(it) || splitOpen(it) || splitFilingFailed(it))) {
      // The same `/approve` delivered again (a second poll, another replica, or the one whose filing was given up):
      // the pass that claimed the filing answers it.
      if ((await this.c.unit("phases").splitClaim(it.id))?.detail?.comment_id === e.comment_id) return null;
      // Outbound files them and retries a failure; a stopped process leaves nothing for a person to take over.
      if (splitFiling(it)) return { refuse: "an earlier `/approve` queued this split's phases for filing; this issue lists them once all are filed" };
    }
    if (e.kind === "spec_approved" && it.blocked_on === "dependency") {
      return { refuse: dependencyHoldRefusal(it.blocked_reason) };
    }
    const phase = commandPhase(it);
    // At the review loop limit too: a human chose to go back through triage or to close (design §4).
    const afterFailure = phase === "too_large" || phase === "failed_implement" || phase === "agent_needs_human" || phase === "repeated_failure" ||
      phase === "max_loops";
    if (afterFailure && e.kind === "revise_requested") return this.reviseAfterFailure(e, it, actor);
    if (!awaitingSpec(it) && !(afterFailure && e.kind === "spec_rejected")) {
      const onPr = e.kind === "revise_requested" && it.change_ref !== null && commandSpec("revise").pr_phases?.includes(phase)
        ? `; to send feedback to the implementer, reply \`/revise <feedback>\` on PR #${it.change_ref}`
        : "";
      return { refuse: `${specNotWaiting(phase)}${onPr}` };
    }
    switch (e.kind) {
      case "spec_rejected":
        // Recorded first; the comment and the close follow (finishReject), and survive a stop in between.
        return {
          patch: {
            stage: "CLOSED",
            close_reason: "rejected",
            blocked_on: "upstream",
            blocked_reason: SOURCE_CLOSE_PENDING,
            spec_feedback: e.reason.trim() || null,
          },
          actor,
          reason: "spec_rejected",
        };
      case "revise_requested": {
        const feedback = e.feedback.trim();
        if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
        const limit = this.c.k.cfg.max_loops;
        if (it.blocked_reason === "max_revisions") {
          return { refuse: `the spec reached the revision limit (\`max_loops\` = ${limit}); reply \`/approve\` or \`/reject <reason>\`` };
        }
        if (it.revision_count >= limit) {
          const patch = { blocked_on: "human" as const, blocked_reason: "max_revisions" };
          await this.c.unit("outbox").comment(it, `max-revisions:${it.id}`, [
            `The spec was revised ${it.revision_count} times (limit \`max_loops\` = ${limit}), so the factory started no new triage run (\`max_revisions\`).`,
            "",
            "Reply `/approve` to implement the spec above, or `/reject <reason>` to close.",
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor, reason: "max_revisions" };
        }
        const n = it.revision_count + 1;
        return {
          patch: { stage: "NEW", blocked_on: "none", blocked_reason: null, revision_count: n, spec_feedback: feedback },
          actor,
          reason: "spec_revision_requested",
          // Differs from the intake key and from every earlier revision's key.
          enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
        };
      }
      case "spec_approved": {
        const phases = await this.c.unit("phases").specPhases(it);
        if (phases && paths.length > 0) return { refuse: SPLIT_PATHS };
        // `N: <answer>` lines answer the spec's decisions (issue #526); a split's answers stay on its approval's tag.
        const a = splitAnswers(note, latestSpec(await this.c.k.reader.listRuns(it.id))?.decision_items ?? []);
        if ("refuse" in a) return a;
        if (phases) return this.c.unit("phases").approveSplit(it, phases, actor, a.note, e.comment_id, a.answers.length ? { ...tag, ...answersDetail(a.answers) } : tag);
        const w = this.widen(it, paths);
        const detail = { ...(a.note ? { note: a.note } : {}), ...answersDetail(a.answers), ...w.detail };
        return {
          patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, ...w.patch },
          actor,
          reason: "spec_approved",
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
          enqueue: { kind: "implement", idempotency_key: runKey(it, "implement") },
        };
      }
    }
  }

  /**
   * `/revise <feedback>` at a failed implement run, a `diff_too_large` block or the review loop limit (design §4):
   * the item goes back through triage with the feedback, then to the spec gate. The revision counter and
   * `max_loops` apply as at the spec gate, but at the limit nothing changes: the item keeps its block, where
   * `/retry` and `/reject` still apply. restart_count + 1 so the implement run after the next `/approve` gets a
   * new run key; the old failure comment is unlinked. At the loop limit loop_count goes back to 0; the PR and
   * its branch stay.
   */
  reviseAfterFailure(e: Extract<ItemCommandEvent, { kind: "revise_requested" }>, it: WorkItem, actor: Actor): Decision | Refusal {
    const feedback = e.feedback.trim();
    if (!feedback) return { refuse: "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`" };
    const limit = this.c.k.cfg.max_loops;
    if (it.revision_count >= limit) {
      return {
        refuse: `the spec was revised ${it.revision_count} times, the revision limit (\`max_loops\` = ${limit}); ` +
          "reply `/retry` to run the implementer again or `/reject <reason>` to close",
      };
    }
    const n = it.revision_count + 1;
    return {
      patch: {
        stage: "NEW",
        blocked_on: "none",
        blocked_reason: null,
        revision_count: n,
        restart_count: it.restart_count + 1,
        ...(it.blocked_reason === "max_loops" ? { loop_count: 0 } : {}),
        spec_feedback: feedback,
        failure_comment_url: null,
      },
      actor,
      reason: "spec_revision_requested",
      detail: { previous_blocked_reason: it.blocked_reason },
      // The spec-gate revision key: differs from the intake key and from every earlier revision's key.
      enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:v${n}` },
    };
  }

  /**
   * `/approve` on an implementing item (design §5, 2026-11-03): its queued implement run's latest claim decision
   * is `held` by coordination cost, so the approval is recorded (state change `coordination_approved`, the
   * approver as actor) and the next claim takes the run. Without such a hold it is refused as before.
   */
  async approveHold(it: WorkItem, actor: Extract<Actor, { kind: "user" }>): Promise<string | null | typeof RETRY> {
    const queued = new Set((await this.c.k.reader.listRuns(it.id)).filter((r) => r.kind === "implement" && r.status === "queued").map((r) => r.id));
    const held = (await this.c.k.reader.listClaimDecisions(it.id))
      .filter((d) => d.decision === "held" && d.approved_by === null && queued.has(d.run_id))
      .at(-1);
    if (!held) {
      return `the spec is not waiting for approval and no implement run is held by coordination cost (the item is ${phaseLabel(commandPhase(it))})`;
    }
    const r = await this.c.k.commitItem([], { kind: "claim_approval", input: { id: it.id, expected_version: it.version, actor, run_id: held.run_id } });
    if (r.ok) {
      this.c.k.d.log.info("transition", { work_item_id: it.id, reason: "coordination_approved", version: r.item.version, run_id: held.run_id });
      return null;
    }
    if (r.reason === "version_conflict") return RETRY;
    return r.reason === "not_held" ? "the implement run is no longer held by coordination cost" : null;
  }

  /** The kind of run behind an agent_needs_human or repeated_failure block (from the item's runs); else undefined. */
  async blockedBy(it: WorkItem): Promise<RunKind | undefined> {
    if (it.blocked_on !== "human" || (it.blocked_reason !== AGENT_NEEDS_HUMAN && it.blocked_reason !== REPEATED_FAILURE)) return undefined;
    return blockingRunKind(it.blocked_reason, await this.c.k.reader.listRuns(it.id));
  }

  /** At agent_needs_human: the kind of run that asked; else undefined. */
  async askedBy(it: WorkItem): Promise<RunKind | undefined> {
    return it.blocked_reason === AGENT_NEEDS_HUMAN ? this.blockedBy(it) : undefined;
  }

  /** The step a `/retry` restarts: implement at the loop limit, the run behind an agent block, else what the item's fields say. */
  async retryKind(it: WorkItem): Promise<RunKind | undefined> {
    if (it.blocked_on === "human" && it.blocked_reason === "max_loops") return "implement";
    return (await this.blockedBy(it)) ?? failedRunKind(it);
  }

  /** The command state of `it`, with the kind of run that asked at agent_needs_human. */
  async stateOf(it: WorkItem) {
    return commandState(it, await this.askedBy(it));
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "commands": CommandsUnit;
  }
}

export default controllerUnit({
  name: "commands",
  create: (c: Ctx) => new CommandsUnit(c),
  events: {
    spec_approved: (u, e) => u.handleCommand(e),
    spec_rejected: (u, e) => u.handleCommand(e),
    revise_requested: (u, e) => u.handleCommand(e),
    retry_requested: (u, e) => u.handleCommand(e),
    resolve_requested: (u, e) => u.handleCommand(e),
    budget_continue: (u, e) => u.handleCommand(e),
    help_requested: (u, e) => u.handleInfo(e),
    unknown_command: (u, e) => u.handleInfo(e),
    plain_comment: (u, e) => u.handlePlainComment(e),
    pr_changes_requested: (u, e) => u.handlePrReview(e),
  },
});
