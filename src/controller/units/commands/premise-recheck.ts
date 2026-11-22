// `/retry` on an item that waited more than a day re-checks its premise with a triage run first (design
// 04-spec-gate-commands, 2026-11-20): the commands unit's retry branch asks `recheckRetry` before it applies a retry.

import { type Decision, type Refusal, type WorkItem, runKey } from "../support.js";

/** How old an item's last state change may be before `/retry` re-checks its premise (24 hours). */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * `plain`, the retry as `retry` decided it, unless it starts a run and the item's last state change (`last`) is more
 * than RECHECK_AFTER_MS before `now` (the injected Clock's). Then: refused with `+paths` (`pathsRefusal`, core
 * RECHECK_PATHS_REFUSAL); else one `retry_requested` change to NEW with the block cleared, restart_count + 1 and
 * loop_count 0 at max_loops, and one triage run under a key no earlier run used (restart_count is new on every
 * retry). The new spec waits at the spec gate for `/approve`.
 */
export function recheckRetry(
  it: WorkItem, note: string | null, paths: readonly string[], plain: Decision | Refusal, last: { at: string } | undefined, now: Date, pathsRefusal: string,
): Decision | Refusal {
  if (!plain || "refuse" in plain || !plain.enqueue || !last || now.getTime() - Date.parse(last.at) <= RECHECK_AFTER_MS) return plain;
  if (paths.length > 0) return { refuse: pathsRefusal };
  const next = { ...it, restart_count: it.restart_count + 1 };
  return {
    patch: { stage: "NEW", blocked_on: "none", blocked_reason: null, restart_count: next.restart_count, ...(it.blocked_reason === "max_loops" ? { loop_count: 0 } : {}) },
    actor: plain.actor,
    reason: "retry_requested",
    detail: { premise_recheck: true, previous_blocked_reason: it.blocked_reason, ...(note ? { note } : {}) },
    enqueue: { kind: "triage", idempotency_key: `${runKey(next, "triage")}:recheck` },
  };
}
