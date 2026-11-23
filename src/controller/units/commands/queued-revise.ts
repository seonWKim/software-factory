// `/revise` while implementing (design 04-gate-commands, 2026-11-15): no agent runner takes a message during its session,
// so the feedback is queued as a `revise_queued` state change and applied when the run ends, before review, as one
// implement run (`revise_applied`). A `revise_applied` or `max_loops` row naming its comment ID settles it. It reads
// state changes through the kernel's reader. On a New or in-triage item (design 02-attachments) the same row, with
// `at: triage` in its detail, is added context: the triage run's end applies it as exactly one more triage run.

import { type CommandEvent, type Decision, type Refusal, MAX_FEEDBACK_CHARS, SYSTEM, footerAfter } from "../support.js";
import type { Ctx } from "../context.js";
import { runKey } from "../../../core/policy.js";
import { AT_TRIAGE } from "../../../core/attachments.js";

type ReviseEvent = Extract<CommandEvent, { kind: "revise_requested" }>;
type WorkItem = Parameters<typeof footerAfter>[0];
type Actor = NonNullable<Decision>["actor"];
type StateChange = Awaited<ReturnType<Ctx["k"]["reader"]["listStateChanges"]>>[number];

/** State change reason of a `/revise` queued while implementing; its detail holds `comment_id` and `feedback`. */
export const REVISE_QUEUED = "revise_queued";
/** State change reason of the implement run that applied queued feedback; its detail lists them in `comment_ids` (JSON). */
export const REVISE_APPLIED = "revise_applied";
/** The path a queued `/revise` took, as its reply names it. The live path ("sent to the running implementer") needs a runner that takes messages mid-run. */
export const REVISE_QUEUED_PATH = "queued: applies when this run ends";
/** The refusal of a `/revise` with no feedback after it. */
export const FEEDBACK_REQUIRED = "it needs feedback after the command, e.g. `/revise keep the existing CLI flag`";

/** The path an added context took, as its reply names it. */
export const CONTEXT_QUEUED_PATH = "queued: one more triage run reads it when the current one ends";

/** The comment IDs a settling row (`revise_applied`, `max_loops`) names in its `comment_ids` detail. */
function settledIds(c: Pick<StateChange, "detail">): string[] {
  const raw = c.detail?.comment_ids;
  if (typeof raw !== "string") return [];
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The queued `/revise` feedback of an item not applied yet, oldest first, from its state changes in order; `at` triage: its added context only, else none of it. */
export function pendingRevises(changes: readonly Pick<StateChange, "reason" | "detail">[], at: typeof AT_TRIAGE | null = null): { comment_id: string; feedback: string }[] {
  const settled = new Set(changes.filter((c) => c.reason === REVISE_APPLIED || c.reason === "max_loops").flatMap(settledIds));
  const out: { comment_id: string; feedback: string }[] = [];
  for (const c of changes) {
    const id = c.detail?.comment_id, feedback = c.detail?.feedback;
    if (c.reason === REVISE_QUEUED && (c.detail?.at ?? null) === at && typeof id === "string" && typeof feedback === "string" && !settled.has(id) && !out.some((p) => p.comment_id === id)) {
      out.push({ comment_id: id, feedback });
    }
  }
  return out;
}

/** The refusal of feedback the egress scan flags (nothing is stored), else null. */
export async function feedbackScan(c: Ctx, it: WorkItem, feedback: string): Promise<Refusal | null> {
  const scan = await c.k.d.scanner.scan("comment", feedback);
  if (scan.clean) return null;
  const rules = scan.findings.map((x) => x.rule).join(",");
  c.k.d.log.warn("feedback blocked by the egress scan", { work_item_id: it.id, rules });
  return { refuse: `the feedback was blocked by the leak scanner (\`${rules}\`), so it was not stored and nothing changed` };
}

/**
 * `/revise <feedback>` while implementing, or on a New or in-triage item (its detail `at: triage`): one `revise_queued`
 * state change (no field changes) keyed on the comment ID. Empty or flagged feedback is refused and nothing is stored;
 * the same comment again is a no-op.
 */
export async function queueRevise(c: Ctx, e: ReviseEvent, it: WorkItem, actor: Actor): Promise<Decision | Refusal> {
  const feedback = e.feedback.trim();
  if (!feedback) return { refuse: FEEDBACK_REQUIRED };
  const blocked = await feedbackScan(c, it, feedback);
  if (blocked) return blocked;
  if ((await c.k.reader.listStateChanges(it.id)).some((x) => x.reason === REVISE_QUEUED && x.detail?.comment_id === e.comment_id)) return null;
  const at = it.stage === "NEW" ? { at: AT_TRIAGE } : {};
  return { patch: {}, actor, reason: REVISE_QUEUED, detail: { comment_id: e.comment_id, feedback: feedback.slice(0, MAX_FEEDBACK_CHARS).trim(), ...at } };
}

/** A `/revise` stored as queued feedback gets one reply naming the path it took, keyed on the comment ID. */
export async function replyQueued(c: Ctx, item: WorkItem, comment_id: string): Promise<void> {
  const queued = (await c.k.reader.listStateChanges(item.id)).some((x) => x.reason === REVISE_QUEUED && x.detail?.comment_id === comment_id);
  const body = item.stage === "NEW"
    ? `\`/revise\` ${CONTEXT_QUEUED_PATH}. That triage run reads the filed text and the context you added, so the new spec reflects both.`
    : `\`/revise\` ${REVISE_QUEUED_PATH}. Your feedback goes to one more implement run on the item's branch right after the current run, before review.`;
  if (queued) await c.unit("outbox").post(item, item.source, body, `<!-- factory:revise-queued:${comment_id} -->`);
}

/**
 * The end of an implement run that would queue its review (`d`), with the item's queued feedback applied: every pending
 * feedback, oldest first, goes into one implement run on the branch (loop_count + 1, reason `revise_applied`, the key
 * from the first feedback's comment ID after `nextKey`, the next loop's implement key) instead of the review, in `d`'s transaction. At the loop limit the item blocks
 * with `max_loops` as `prFeedback` does. Both rows name the comment IDs, so a second apply (another worker on the same
 * run end) finds none pending and returns `d` unchanged, which its acknowledged run then fences. None pending: `d`.
 */
export async function applyQueued(c: Ctx, it: WorkItem, d: NonNullable<Decision>, nextKey: string): Promise<NonNullable<Decision>> {
  if (it.stage === "NEW") return retriage(c, it, d);
  const pending = pendingRevises(await c.k.reader.listStateChanges(it.id));
  if (pending.length === 0) return d;
  const { enqueue: _review, ...rest } = d;
  const detail = { ...d.detail, comment_ids: JSON.stringify(pending.map((p) => p.comment_id)) };
  const limit = c.k.cfg.max_loops;
  if (it.loop_count + 1 >= limit) {
    const patch = { ...d.patch, blocked_on: "human" as const, blocked_reason: "max_loops" };
    await c.unit("outbox").comment(it, `max-loops:queued-${pending[0]!.comment_id}`, [
      `The feedback queued while implementing would start loop ${it.loop_count + 1} (limit \`max_loops\` = ${limit}), so the factory started no implement run. A human needs to decide.`,
      "",
      footerAfter({ ...it, ...patch }, patch),
    ].join("\n"));
    return { ...rest, patch, reason: "max_loops", detail };
  }
  const notes = pending.map((p) => p.feedback).join("\n\n").slice(0, MAX_FEEDBACK_CHARS).trim();
  return {
    ...rest,
    actor: SYSTEM,
    patch: { ...d.patch, stage: "RUNNING", blocked_on: "none", blocked_reason: null, loop_count: it.loop_count + 1, failure_comment_url: null },
    reason: REVISE_APPLIED,
    detail: { ...detail, feedback: notes },
    enqueue: { kind: "implement", idempotency_key: `${nextKey}:revise-${pending[0]!.comment_id}`, input: { notes } },
  };
}

/**
 * The end of a triage run (`d`, its ack) with added context pending (design 02-attachments): instead of the spec, exactly
 * one more triage run, keyed on the first pending comment ID, and a `revise_applied` row naming every pending comment
 * ID, so a second apply on the same run end finds none pending. The stage stays NEW; the next triage reads every
 * context added so far. None pending: `d`.
 */
async function retriage(c: Ctx, it: WorkItem, d: NonNullable<Decision>): Promise<NonNullable<Decision>> {
  const pending = pendingRevises(await c.k.reader.listStateChanges(it.id), AT_TRIAGE);
  if (pending.length === 0) return d;
  const { enqueue: _spec, ...rest } = d;
  return {
    ...rest,
    actor: SYSTEM,
    reason: REVISE_APPLIED,
    detail: { comment_ids: JSON.stringify(pending.map((p) => p.comment_id)), at: AT_TRIAGE },
    enqueue: { kind: "triage", idempotency_key: `${runKey(it, "triage")}:context-${pending[0]!.comment_id}` },
  };
}
