// The run-results unit's delivery waits (RFC 0015 M7): a run's PR and push wait for outbound, and outbound's
// delivered or given-up action ends the wait. Split out of run-results.unit.ts (file budget). Values come through
// run-results.unit.ts, which already imports them: a new core/ or units/support import here would raise the
// dependency-direction and kinds counts (tests/architecture).

import type { ActionRow } from "../../../outbound/index.js";
import type { Ctx } from "../context.js";
import type { Decision, Run, WorkItem, WorkItemId } from "../support.js";
import { type StateChangeDetail, DELIVERY_FAILED, PR_PENDING, PUSH_PENDING, SYSTEM, prNumber, runKey } from "./run-results.unit.js";

/**
 * A PR or push outbound delivered while this result was decided (the delivery's handler on another tick or
 * replica found the item not waiting yet, so it changed nothing): read once more after the wait is written, so
 * the wait never misses it. Only an item still waiting changes, as in `prDelivered` and `pushDelivered`.
 */
export async function deliveredMeanwhile(c: Ctx, run: Run): Promise<void> {
  if (run.outcome?.status !== "succeeded") return;
  const data = run.outcome.data;
  const id = run.work_item_id as WorkItemId;
  for (const key of [data.pr_intent, data.push_intent]) {
    if (typeof key !== "string") continue;
    const a = await c.k.actionByKey(key);
    if (!a?.delivered_at) continue;
    if (a.outcome === "failed") await deliveryGaveUp(c, id, a);
    else if (a.action === "pr" && a.delivered_ref) await prDelivered(c, id, a.delivered_ref, a.delivered_url);
    else if (a.action === "push") await pushDelivered(c, id, run.id);
  }
}

/**
 * Outbound gave up a run's PR or push (refused for good): an item still waiting for it waits for a person instead
 * (`delivery_failed`), with the action and its error; the dead-letter alarm names it too. A redelivery changes nothing.
 */
export async function deliveryGaveUp(c: Ctx, id: WorkItemId, a: ActionRow): Promise<void> {
  const waiting = a.action === "pr" ? PR_PENDING : PUSH_PENDING;
  await c.unit("transitions").decide(id, async (it) =>
    it.blocked_on === "outbound" && it.blocked_reason === waiting
      ? { patch: { blocked_on: "human", blocked_reason: DELIVERY_FAILED }, actor: SYSTEM, reason: DELIVERY_FAILED, detail: { action: a.action, error: a.last_error ?? "unknown" } }
      : null,
  );
}

/**
 * Outbound delivered an implement run's PR (RFC 0015 M7): its number and link go on the item at its version, the
 * wait ends, and the review is queued as an implement result's was (queued `/revise` feedback first: applyQueued).
 * Only an item still waiting for its PR changes, so a redelivered result or a late one changes nothing.
 */
export async function prDelivered(c: Ctx, id: WorkItemId, ref: string, url: string | null): Promise<void> {
  await c.unit("transitions").decide(id, async (it) =>
    it.blocked_on === "outbound" && it.blocked_reason === PR_PENDING ? c.unit("commands").applyQueued(it, await prApplied(c, it, ref, url)) : null,
  );
}

/**
 * Outbound delivered an update or resolve run's push (RFC 0015 M7): the review its result queued once runs now, on
 * the pushed head. Only an item still waiting for a push changes, so a redelivered result changes nothing.
 */
export async function pushDelivered(c: Ctx, id: WorkItemId, run_id: string): Promise<void> {
  await c.unit("transitions").decide(id, async (it) => {
    if (it.blocked_on !== "outbound" || it.blocked_reason !== PUSH_PENDING) return null;
    const run = (await c.k.reader.listRuns(it.id)).find((r) => r.id === run_id);
    return run ? pushApplied(c, it, run) : null;
  });
}

/** Whether a run's result names a push intent (`push_intent`) outbound has not delivered yet. */
export async function pushPending(c: Ctx, data: Record<string, unknown>): Promise<boolean> {
  if (typeof data.push_intent !== "string") return false;
  const push = await c.k.actionByKey(data.push_intent);
  // A given-up push waits too: the step after the result turns the wait into `delivery_failed`.
  return !push?.delivered_at || push.outcome === "failed";
}

/** The item waits for its run's push (`blocked_on: outbound`, `push_pending`); `pushDelivered` ends the wait. */
export function pushWait(run: Run, reason: string, patch: Partial<WorkItem>): Decision {
  return { patch: { ...patch, blocked_on: "outbound", blocked_reason: PUSH_PENDING }, actor: SYSTEM, reason, detail: { run_id: run.id }, ack_run: run.id };
}

/** The review of the head an update or resolve run pushed, keyed by that run (never an earlier loop's review). */
export async function pushApplied(c: Ctx, it: WorkItem, run: Run): Promise<NonNullable<Decision>> {
  return {
    patch: { ...(it.stage === "REVIEW" ? {} : { stage: "REVIEW" as const }), blocked_on: "none", blocked_reason: null },
    actor: SYSTEM,
    reason: "push_delivered",
    detail: { run_id: run.id },
    enqueue: { kind: "review", idempotency_key: `${it.id}:review:after-${run.kind}:${run.id}`, input: await c.unit("checks-gate").reviewInput(prNumber(it), it.id) },
  };
}

/**
 * A run that stored its push and PR as intents (RFC 0015 M7, an implement run or a session's finish): the item
 * waits for outbound, and `prDelivered` applies the PR number and queues the review once the PR delivery completes.
 * One delivered before this result is applied (outbound ran first) is applied here, so the wait never misses it.
 */
export async function prPending(c: Ctx, it: WorkItem, run: Run, data: Record<string, unknown>, patch: Partial<WorkItem>, reason: string, detail?: StateChangeDetail): Promise<Decision> {
  const delivered = typeof data.pr_intent === "string" ? await c.k.actionByKey(data.pr_intent) : null;
  if (delivered?.delivered_ref) {
    const applied = await prApplied(c, it, delivered.delivered_ref, delivered.delivered_url);
    return c.unit("commands").applyQueued(it, { ...applied, patch: { ...applied.patch, ...patch }, reason, ack_run: run.id, ...(detail ? { detail } : {}) });
  }
  return { patch: { ...patch, blocked_on: "outbound", blocked_reason: PR_PENDING }, actor: SYSTEM, reason, ack_run: run.id, ...(detail ? { detail } : {}) };
}

/** The PR on the item and the review queued, as an implement result with a PR number did before. */
async function prApplied(c: Ctx, it: WorkItem, ref: string, url: string | null): Promise<NonNullable<Decision>> {
  return {
    patch: { stage: "REVIEW", change_ref: ref, ...(url ? { change_url: url } : {}), blocked_on: "none", blocked_reason: null },
    actor: SYSTEM,
    reason: "pr_delivered",
    enqueue: { kind: "review", idempotency_key: runKey(it, "review"), input: await c.unit("checks-gate").reviewInput(Number(ref), it.id) },
  };
}
