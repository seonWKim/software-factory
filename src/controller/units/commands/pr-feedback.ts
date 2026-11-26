// PR feedback (design §4): a "Request changes" review on a PR, a `/revise` on the PR, and a local item's `/revise`
// at its merge wait, each as one implement run's feedback; and the work item a PR belongs to. Moved out of the commands
// unit (issue #866) with no change in behaviour; the unit calls these with its context and what they need from the legacy
// core (PrFeedbackDeps), so this file imports only the controller's own modules.

import { type Actor, type Decision, type Refusal, type WorkItem, type WorkItemId, MAX_FEEDBACK_CHARS, commandPhase, footerAfter, phaseLabel, runKey } from "../support.js";
import type { ControllerEvent, Ctx } from "../context.js";
import { FEEDBACK_REQUIRED, feedbackScan } from "./queued-revise.js";

type PrReviewEvent = Extract<ControllerEvent, { kind: "pr_changes_requested" }>;

/** What PR feedback needs from the legacy core, passed in by the commands unit. */
export interface PrFeedbackDeps {
  /** The work item ID a factory branch names (`prefix` stripped), or null. */
  branchItem: (branch: string, prefix: string) => string | null;
  /** The phases that take `/revise` feedback on a local item (`local`), or on the PR. */
  phases: (local: boolean) => readonly ReturnType<typeof commandPhase>[];
}

/** State change reasons of PR feedback that started an implement run (design §4). */
export const PR_REVISE = "pr_revise_requested";
const PR_CHANGES = "pr_changes_requested";

/** The feedback of a "Request changes" review: its body, then each line comment as `path:line` and its text. Untrusted text; the worker fences it. */
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
 * The work item of a PR: a factory PR's from its head branch, any other PR's adopted item by number; null
 * unless that item's PR is this one.
 */
export async function itemOfPr(c: Ctx, d: PrFeedbackDeps, pr: { change_ref: string; head_branch: string }): Promise<WorkItem | null> {
  const id = d.branchItem(pr.head_branch, c.k.cfg.branch_prefix);
  const it = id
    ? await c.k.reader.getWorkItem(id as WorkItemId)
    : await c.k.reader.getWorkItemByPr(c.k.project(), pr.change_ref).then((x) => (x?.origin === "adopted" ? x : null));
  return it && it.change_ref === pr.change_ref ? it : null;
}

/**
 * A "Request changes" review on a PR (design §4): its body and line comments are feedback for one implement
 * run, as a `/revise` on the PR is. A PR with no open item, and a reviewer without write permission, get
 * nothing: no change, no reply. A review already applied (a later poll, a restart) changes nothing. A writer's
 * review in a state that cannot take it gets one reply on the PR, keyed on the review.
 */
export async function handlePrReview(c: Ctx, d: PrFeedbackDeps, e: PrReviewEvent): Promise<void> {
  const item = await itemOfPr(c, d, e);
  if (!item || item.stage === "CLOSED") return;
  const principal = await c.unit("auth").authorize(e.reviewer, "approve_spec", item.id);
  if ("refuse" in principal) {
    c.k.d.log.info("review ignored", { work_item_id: item.id, change_ref: e.change_ref, reason: principal.refuse });
    return;
  }
  const actor: Actor = { kind: "user", id: principal.user_id };
  const refusal = await c.unit("transitions").decide(item.id, (it) =>
    prFeedback(c, d, it, { text: reviewFeedback(e), actor, reason: PR_CHANGES, change_ref: e.change_ref, key: { review_id: e.review_id } }));
  if (refusal === null) return;
  c.k.d.log.info("review refused", { work_item_id: item.id, change_ref: e.change_ref, reason: refusal });
  await c.unit("outbox").post(item, e.source, `The review's requested changes were not applied: ${refusal}.`, `<!-- factory:refused:review-${e.review_id} -->`);
}

/**
 * Feedback on a PR (design §4): a `/revise` on the PR or a "Request changes" review, or a local item's `/revise` (`change_ref` null, issue #563). Accepted while it
 * waits for a human merge or its review run failed: the item goes to RUNNING with one implement run on its
 * branch, keyed on the next loop (loop_count + 1), with the feedback as its input and on the state change.
 * At the loop limit the item blocks on a human with `max_loops` and starts nothing. `key` (the comment or the
 * review id) is recorded on the state change, so the same feedback delivered again changes nothing.
 */
export async function prFeedback(
  c: Ctx,
  d: PrFeedbackDeps,
  it: WorkItem,
  f: { text: string; actor: Actor; reason: string; change_ref: string | null; key: { comment_id: string } | { review_id: string } },
): Promise<Decision | Refusal> {
  if (it.stage === "CLOSED" || it.change_ref !== f.change_ref) return null;
  const [field, value] = Object.entries(f.key)[0] as [string, string];
  const done = (await c.k.reader.listStateChanges(it.id)).some(
    (x) => (x.reason === f.reason || x.reason === "max_loops") && x.detail?.[field] === value);
  if (done) return null;
  const [phase, local] = [commandPhase(it), f.change_ref === null];
  const accepted = d.phases(local);
  if (!accepted.includes(phase)) {
    const where = local ? "on a local item" : "on the PR";
    return { refuse: `the item is ${phaseLabel(phase)}; feedback ${where} is taken only when it is ${accepted.map(phaseLabel).join(" or ")}` };
  }
  const feedback = f.text.trim();
  if (!feedback) return { refuse: FEEDBACK_REQUIRED };
  const blocked = await feedbackScan(c, it, feedback); if (blocked) return blocked;
  const kept = feedback.slice(0, MAX_FEEDBACK_CHARS).trim();
  // The detail names the PR by its string ref, like the item (design 02-work-item); a local item has none.
  const detail = { ...f.key, ...(local ? {} : { change_ref: f.change_ref }) };
  const limit = c.k.cfg.max_loops;
  if (it.loop_count + 1 >= limit) {
    const patch = { blocked_on: "human" as const, blocked_reason: "max_loops" };
    await c.unit("outbox").comment(it, `max-loops:${field}-${value}`, [
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
