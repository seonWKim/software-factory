// Review findings (design 11-signal-ledger): one signal per finding of a finished review run, keyed by the run and the
// finding's place (`<run>:<index>`), at the run's finish time, role `review`. Only the finding's kind (`code` or
// `spec`) is read: its text never reaches the ledger.

import { defineSignal, roleOfRun } from "./signal.js";

const KIND = { code: "review_finding_code", spec: "review_finding_spec" } as const;

/** The kinds of a review outcome's findings, in order; [] when it holds none. */
function findingKinds(data: Record<string, unknown>): ("code" | "spec" | null)[] {
  const review = data.review;
  const findings = review && typeof review === "object" ? (review as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(findings)) return [];
  return findings.map((f: unknown) => {
    const kind = f && typeof f === "object" ? (f as { kind?: unknown }).kind : undefined;
    return kind === "code" || kind === "spec" ? kind : null;
  });
}

export default defineSignal({
  name: "review_findings",
  kinds: Object.values(KIND),
  async read(r, since) {
    const runs = await r.listRunsFinishedSince({ status: "succeeded", kinds: ["review"], since });
    return runs.flatMap((run) => {
      if (run.outcome?.status !== "succeeded") return [];
      const at = run.finished_at ?? run.updated_at;
      return findingKinds(run.outcome.data).flatMap((k, i) => (k === null ? [] : [{
        source_ref: `${run.id}:${i}`, kind: KIND[k], work_item_id: run.work_item_id, role: roleOfRun(run.kind), at,
      }]));
    });
  },
});
