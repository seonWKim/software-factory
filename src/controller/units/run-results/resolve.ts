// The run-results unit's conflict-resolve decisions (design §5 Merge conflict): an automatic resolve run started,
// retried or stopped at its limit, and a failed resolve run. Split out of run-results.unit.ts (file budget). Values
// come through run-results.unit.ts, which already imports them: a new core/ or units/support import here would
// raise the dependency-direction and kinds counts (tests/architecture).

import type { Ctx } from "../context.js";
import type { Decision, Run, WorkItem } from "../support.js";
import { codeDetails, describeFailure } from "./retry.js";
import {
  type StateChangeDetail, AUTO_RESOLVE_LIMIT, CONFLICT_PATCH, PROVIDER_SETUP, SYSTEM, autoResolveAttempts, autoResolveKey, conflictCounts,
  conflictCountsLine, footerAfter, iso, nextAutoResolveAttempt, parseAutoResolveKey,
} from "./run-results.unit.js";

/**
 * The PR comment of a succeeded automatic resolve run (its key names the base commit and attempt): the conflict was
 * resolved and a fresh review runs next. A resolve run a person started posts nothing here.
 */
export async function autoResolvedComment(c: Ctx, it: WorkItem, run: Run): Promise<void> {
  const auto = parseAutoResolveKey(run.idempotency_key);
  if (!auto) return;
  const counts = await conflictCountsOf(c, it, 0);
  await c.unit("outbox").prComment(it, `auto-resolved:${run.id}`, [
    `The factory resolved the merge conflict on ${c.unit("local-merge").changeName(it)} automatically (attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`) and ${it.change_ref === null ? "committed" : "pushed"} the merge. A fresh review runs next.`,
    "",
    conflictCountsLine(counts),
  ].join("\n"));
}

/**
 * A conflict to resolve with no person (design §5 Merge conflict): an update run's (`ack_run`, 2026-11-02) or a local
 * item's (local-merge's startLocalResolve, no run to ack, 2026-11-12). Under AUTO_RESOLVE_LIMIT automatic resolve runs
 * per base commit, the item goes to RUNNING and a resolve run is enqueued in the same transition, keyed on (item, base
 * commit, attempt). At the limit, or with no base commit to key on, it waits for a person on merge_conflict_pending.
 * The ack (a local item: leaving merge_pending) fences a second apply, so applying it twice enqueues one resolve run.
 */
export async function autoResolve(c: Ctx, it: WorkItem, baseSha: string, cause: StateChangeDetail, ack_run: Run["id"] | null): Promise<Decision> {
  const keys = (await c.k.reader.listRuns(it.id)).filter((r) => r.kind === "resolve").map((r) => r.idempotency_key);
  const done = baseSha ? autoResolveAttempts(keys, it.id, baseSha) : AUTO_RESOLVE_LIMIT;
  const attempt = nextAutoResolveAttempt(done);
  const detail = { ...cause, base_sha: baseSha || null, auto_resolve_attempts: done };
  if (attempt === null) {
    const counts = await conflictCountsOf(c, it, 1);
    await c.unit("outbox").prComment(it, `auto-resolve-limit:${ack_run ?? `${it.id}:${baseSha}`}`, [
      `${c.unit("local-merge").changeName(it, true)} still conflicts with base \`${baseSha.slice(0, 8) || "unknown"}\`, and the factory already made ${done} automatic resolve attempts for it (limit ${AUTO_RESOLVE_LIMIT} per base commit), so it stopped. Nothing was ${it.change_ref === null ? "committed" : "pushed"}.`,
      "Comment `/resolve [notes]` to try again, or resolve it by hand.",
      "",
      conflictCountsLine(counts),
      "",
      footerAfter(it, CONFLICT_PATCH),
    ].join("\n"));
    return { patch: CONFLICT_PATCH, actor: SYSTEM, reason: "update_conflict", detail, ...(ack_run === null ? {} : { ack_run }) };
  }
  return {
    patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null },
    actor: SYSTEM,
    reason: "auto_resolve_started",
    detail: { ...detail, attempt },
    ...(ack_run === null ? {} : { ack_run }),
    enqueue: { kind: "resolve", idempotency_key: autoResolveKey(it.id, baseSha, attempt), input: { notes: "" } },
  };
}

/**
 * Any failed resolve run (agent, scope, tests, push, egress, rate limit, lease): nothing was pushed, so the
 * PR is as it was. An automatic run under the limit for its base commit enqueues the next attempt at once
 * (a rate limit waits for its reset), with no comment; the item stays RUNNING (decision changed 2026-11-02).
 * Otherwise (a human's `/resolve`, or the last automatic attempt) the item goes back to waiting on the
 * conflict, not to run_failed:*, so the next `/resolve` is accepted. One comment, keyed on the run, names
 * the code; for an automatic run it also states the conflict counts.
 */
export async function resolveFailed(c: Ctx, it: WorkItem, run: Run, code: string): Promise<Decision> {
  const auto = parseAutoResolveKey(run.idempotency_key);
  // provider_setup is never retried (design §5 Restarts): the item waits on a person, as after the last attempt.
  const next = auto && code !== PROVIDER_SETUP ? nextAutoResolveAttempt(auto.attempt) : null;
  if (auto && next !== null) {
    const failedAt = Date.parse(run.finished_at ?? c.k.d.clock.now().toISOString());
    const reset = run.outcome?.status === "failed" && code === "rate_limited" ? run.outcome.reset_at : null;
    const notBefore = code === "rate_limited" ? (reset ?? iso(failedAt + c.k.cfg.retry_max_ms)) : null;
    return {
      patch: {},
      actor: SYSTEM,
      reason: "auto_resolve_retry",
      detail: { run_id: run.id, error_code: code, base_sha: auto.base_sha, attempt: next },
      ack_run: run.id,
      enqueue: {
        kind: "resolve",
        idempotency_key: autoResolveKey(it.id, auto.base_sha, next),
        input: { notes: "" },
        ...(notBefore ? { not_before: notBefore } : {}),
      },
    };
  }
  const detail = run.outcome?.status === "failed" ? run.outcome.detail.trim() : "";
  const counts = auto ? await conflictCountsOf(c, it, 1) : null;
  const body = (withDetail: boolean) => [
    auto
      ? `The automatic resolve run failed: ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""} That was attempt ${auto.attempt} of ${AUTO_RESOLVE_LIMIT} for base \`${auto.base_sha.slice(0, 8)}\`, so the factory stopped.`
      : `The resolve run failed: ${describeFailure(code)}.${withDetail && detail ? ` ${detail}` : ""}`,
    ...codeDetails(code),
    `Nothing was ${it.change_ref === null ? "committed" : "pushed"}; ${c.unit("local-merge").changeName(it)} is unchanged and still has the merge conflict.`,
    "Comment `/resolve [notes]` to try again, or resolve it by hand.",
    ...(counts ? ["", conflictCountsLine(counts)] : []),
    "",
    footerAfter(it, CONFLICT_PATCH),
  ].join("\n");
  // The detail is run output (G5): post it only if the scan passes, else the comment without it.
  const scan = await c.k.d.scanner.scan("comment", body(true));
  if (auto) await c.unit("outbox").prComment(it, `run-failed:${run.id}`, body(scan.clean));
  else await c.unit("outbox").comment(it, `run-failed:${run.id}`, body(scan.clean));
  return {
    patch: CONFLICT_PATCH,
    actor: SYSTEM,
    reason: "resolve_failed",
    detail: { run_id: run.id, error_code: code, ...(auto ? { base_sha: auto.base_sha, attempt: auto.attempt } : {}) },
    ack_run: run.id,
  };
}

/**
 * The item's conflict counts from its run history and state changes. `pending`: 1 when the decision being
 * made sets merge_conflict_pending, which its own state change will record only after the comment.
 */
async function conflictCountsOf(c: Ctx, it: WorkItem, pending: 0 | 1): Promise<{ automatic: number; person: number }> {
  const n = conflictCounts(await c.k.reader.listRuns(it.id), await c.k.reader.listStateChanges(it.id));
  return { automatic: n.automatic, person: n.person + pending };
}
