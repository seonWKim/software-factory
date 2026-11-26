// The answer to a budget checkpoint (design §6): `/budget` continues the held run, `/reject` closes the item. Moved
// out of the commands unit (issue #866) with no change in behaviour; the unit's applyCommand calls it with its context
// and the legacy core's budget parser (`parse`), so this file imports only the controller's own modules.

import { type Actor, type CommandEvent, type FactoryStore, type WorkItem, SOURCE_CLOSE_PENDING } from "../support.js";
import type { Ctx } from "../context.js";

/** A `/budget` amount read against the checkpoint's budget (core budget.ts parseBudgetAmount): the grant, null for the suggestion. */
type ParseAmount = (arg: string | null, current: number) => { ok: true; value: number | null } | { ok: false; refuse: string };

/** Tells applyCommand to re-read the item and try again (a version conflict or a concurrent answer). */
export const RETRY = Symbol("retry");

/**
 * The answer to the item's pending checkpoint, with the checkpoint row and its state change in one store
 * transaction. `/budget` grants the suggestion, or a whole number above the checkpoint's budget, and queues
 * the held run with its kind, key and not_before, unchecked. `/reject` closes the item and leaves the
 * branch and the PR as they are.
 */
export async function answerCheckpoint(
  c: Ctx,
  it: WorkItem,
  e: Extract<CommandEvent, { kind: "budget_continue" | "spec_rejected" }>,
  actor: Extract<Actor, { kind: "user" }>,
  parse: ParseAmount,
): Promise<string | null | typeof RETRY> {
  const cp = (await c.k.reader.listBudgetCheckpoints(it.id)).filter((x) => x.answer === "pending").at(-1);
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
    const amount = parse(e.amount, cp.budget);
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
  const r = await c.k.commitItem([], { kind: "budget_answer", input });
  if (r.ok) {
    c.k.d.log.info("transition", { work_item_id: it.id, reason: input.reason, version: r.item.version });
    await c.unit("outbox").showStatus(r.item);
    return null;
  }
  if (r.reason === "version_conflict" || r.reason === "checkpoint_not_pending") return RETRY;
  c.k.d.log.warn("transition refused", { work_item_id: it.id, reason: r.reason });
  return null;
}
