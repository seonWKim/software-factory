// GET /api/v1/failures?window=24h|7d (design §9, issue #312): the failed runs of the window grouped by error
// code, each group with its count, last-seen time, the number of distinct work items it hit and its runs.
// Reads only FactoryStore methods that already exist (listRunsFinishedWithin, listRunAttempts). Codes, details
// and worker ids pass the Withholder with the run-outcome channel, as on the item route. At most FAILURES_CAP
// runs (the newest) are read per window, and the answer says when it left some out.

import { AGENT_STALLED, FORGE_AUTH, PREFLIGHT_ACCESS, RATE_LIMITED, SESSION_ABANDONED, SESSION_LOST } from "../core/policy.js";
import type { Run, RunId, WorkItemId } from "../core/types.js";
import { PROVIDER_SETUP } from "../interfaces/agent-runner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS: Readonly<Record<string, number>> = { "24h": DAY_MS, "7d": 7 * DAY_MS };
/** The newest failed runs read per window. */
export const FAILURES_CAP = 500;

/**
 * Plain words for the error codes the code base names (the worker, the broker, the store's reaper and the
 * policy constants). A code not listed here shows raw, with no description.
 */
export const FAILURE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [RATE_LIMITED]: "The model provider's usage or rate limit was hit. The run waits for the limit to reset.",
  [AGENT_STALLED]: "The model printed nothing for the stall timeout.",
  [FORGE_AUTH]: "The forge refused the credentials. Claims pause until it is resumed.",
  [PREFLIGHT_ACCESS]: "The push or pull-request access check failed before the run started.",
  [PROVIDER_SETUP]: "The model provider is not set up (missing or refused credentials). It is not retried.",
  [SESSION_ABANDONED]: "The person abandoned the interactive session.",
  [SESSION_LOST]: "The interactive session's lease expired.",
  lease_lost: "The run no longer held its lease, so its worker stopped.",
  lease_expired: "The worker stopped heartbeating and the run's lease expired.",
  exception: "The worker hit an unexpected error.",
  egress_blocked: "The egress scanner found secret-like text in what the run would send out.",
  git_failed: "A git command failed.",
  push_failed: "The push to the forge failed.",
  branch_not_allowed: "The run tried to push a branch outside the factory's branch prefix.",
  no_commits: "The implementer made no commits.",
  invalid_output: "The agent's output was not in the expected form.",
  tests_failed: "The checks or tests failed.",
  diff_too_large: "The change is larger than the diff budget allows.",
  scope_violation: "The change touches files outside the allowed paths.",
  out_of_scope: "The conflict resolution changed files outside the conflicts and allowed paths.",
  merge_conflict: "The branch does not merge cleanly with its base.",
  unresolved_conflicts: "Conflict markers were left in the files.",
  head_moved: "The branch head moved while the gates ran.",
  untrusted_base: "The clone's base does not match the factory repo's.",
  untrusted_git_dir: "The run folder's .git is not its own git folder.",
  untrusted_git_config: "The run left unexpected git config keys.",
  no_trusted_repo: "The broker has no factory repo path.",
  no_credential: "The GitHub credentials are missing.",
  no_pr: "The work item has no pull request.",
  prompt_missing: "A prompt file the run needs is missing.",
  work_item_missing: "The run's work item does not exist.",
  test_database_failed: "The run's test database could not be created.",
  unknown_tool: "The agent called a tool the broker does not know.",
  tool_error: "A tool call failed.",
};

export interface FailuresCtx {
  store: Pick<FactoryStore, "listRunsFinishedWithin" | "listRunAttempts">;
  /** The value, or the withheld marker (Withholder, run-outcome channel). */
  text(value: string): Promise<string>;
  now: Date;
}

/** Answers one GET: 200 with the groups, or 400 for a `window` that is not 24h or 7d. */
export async function failures(c: FailuresCtx, params: URLSearchParams): Promise<{ status: number; value: unknown }> {
  const window = params.get("window") ?? "24h";
  const ms = Object.hasOwn(WINDOWS, window) ? WINDOWS[window]! : undefined;
  if (ms === undefined) return { status: 400, value: { error: "window must be 24h or 7d." } };

  const failed = (await c.store.listRunsFinishedWithin(ms))
    .filter((r) => r.status === "failed")
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  const read = failed.slice(0, FAILURES_CAP);

  const workers = await workersOf(c.store, read);
  const byCode = new Map<string, Run[]>();
  for (const r of read) {
    const code = r.outcome?.status === "failed" ? r.outcome.error_code : "unknown";
    byCode.set(code, [...(byCode.get(code) ?? []), r]);
  }
  const groups = [];
  for (const [code, runs] of byCode) {
    const rows = [];
    for (const r of runs) {
      const worker = workers.get(r.id);
      rows.push({
        id: r.id,
        work_item_id: r.work_item_id,
        kind: r.kind,
        attempt: r.attempt,
        detail: r.outcome?.status === "failed" ? await c.text(r.outcome.detail) : "",
        worker: worker === undefined ? null : await c.text(worker),
        finished_at: r.finished_at,
      });
    }
    groups.push({
      code: await c.text(code),
      description: FAILURE_DESCRIPTIONS[code] ?? null,
      count: runs.length,
      last_seen: runs[0]?.finished_at ?? null,
      items: new Set(runs.map((r) => r.work_item_id)).size,
      runs: rows,
    });
  }
  groups.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return {
    status: 200,
    value: { as_of: c.now.toISOString(), window, cap: FAILURES_CAP, total: failed.length, capped: failed.length > FAILURES_CAP, groups },
  };
}

/** Run id → the worker of its latest claim; one attempts read per work item. */
async function workersOf(store: FailuresCtx["store"], runs: readonly Run[]): Promise<Map<RunId, string>> {
  const out = new Map<RunId, string>();
  for (const id of new Set<WorkItemId>(runs.map((r) => r.work_item_id))) {
    for (const a of await store.listRunAttempts(id)) out.set(a.run_id, a.worker_id);
  }
  return out;
}
