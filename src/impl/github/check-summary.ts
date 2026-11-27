// The CI gate's summary of a commit's GitHub checks (design §5 CI gate, 05-ci-gate Cancelled checks), kept out of
// github-forge.ts so that file stays under its line budget.

import type { PrCheckResult } from "../../core/types.js";
import type { PrChecks } from "../../interfaces/forge.js";

/** Check-run conclusions of a job that was stopped, not failed by the code (design 05-ci-gate, Cancelled checks). */
const CANCELLED_CONCLUSIONS = new Set(["cancelled", "timed_out"]);

/** A finished check run that was cancelled or timed out. */
export function cancelledRun(r: { status: string; conclusion: string | null }): boolean {
  return r.status === "completed" && CANCELLED_CONCLUSIONS.has(r.conclusion ?? "");
}

/**
 * The CI gate's summary of a commit's checks: any failed check fails it (with the failed names, the cancelled ones
 * also in `cancelled`), else any pending one keeps it pending, else (none at all included) it passed. Failed checks
 * that were all cancelled while another still runs are pending: their workflow run cannot be rerun before it ends.
 */
export function summedUp(results: readonly PrCheckResult[]): PrChecks {
  const failed = results.filter((r) => r.result === "failed");
  const pending = results.some((r) => r.result === "pending");
  const cancelled = failed.filter((r) => r.cancelled).map((r) => r.name);
  if (failed.length && pending && cancelled.length === failed.length) return { state: "pending" };
  if (failed.length) return { state: "failed", failed: failed.map((r) => r.name), ...(cancelled.length ? { cancelled } : {}) };
  return pending ? { state: "pending" } : { state: "passed" };
}
