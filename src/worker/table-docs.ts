// What each store table the worker declares holds, one line each, and what a column means where its name does not
// say (key `table.column`). Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by
// tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  worker_claim_locks: "The lock a worker holds while it claims a run, so two never claim the same one.",
  worker_claim_pauses: "Claim pauses in effect (a model stall, a usage limit) and when each ends.",
  worker_host_sleeps: "Times a worker's machine slept, and for how long.",
  worker_pauses: "Workers the owner paused, and when.",
  worker_processes: "Running worker processes and their slots, as each last reported.",
  worker_run_attempts: "Each attempt of a run: the worker, the status, the error and the tokens used.",
  "worker_run_attempts.failure_class": "How a failed attempt failed: whether it is retried, and how.",
  worker_run_steps: "The step journal of a run: a finished step is not run again when the run resumes.",
  worker_runs: "Runs of work items (triage, implement, review and others): status, lease and outcome.",
  "worker_runs.kind": "triage, implement, review, update, resolve, manual, interactive, improve or merge-check.",
  "worker_runs.status": "queued, running, succeeded, failed or cancelled.",
  "worker_runs.outcome": "JSON result of the run; usage.cost_usd is its cost in dollars.",
  "worker_runs.finished_at": "When the run ended (UTC); Spend counts a run on this day.",
};
