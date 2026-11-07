// Row mapping and patch diffing for SqlFactoryStore.
// Columns are identical across backends: JSON as text, timestamps as ISO-8601 strings.

import { randomUUID } from "node:crypto";
import type {
  BudgetCheckpoint,
  BudgetCheckpointId,
  ClaimDecision,
  DependencyEdge,
  Handoff,
  HandoffId,
  HostSleep,
  Run,
  RunAttempt,
  RunId,
  RunInput,
  SourceType,
  StateChange,
  StateChangeId,
  Timestamp,
  UnreviewedMerge,
  UnreviewedMergeId,
  UserId,
  Verdict,
  VerdictId,
  VerdictKind,
  VerdictSeverity,
  VerdictTarget,
  WorkItem,
  WorkItemId,
  WorkItemPatch,
  WorkerId,
} from "../../../core/types.js";
import type { NewWorkItem } from "../../../interfaces/factory-store.js";
import type { ChangeFields } from "./change-fields.js";
import type { Row, SqlValue } from "./driver.js";

const JSON_COLUMNS = new Set(["resources", "done_criteria", "allowed_paths", "files_to_change", "pr_files"]);
const PATCHABLE: readonly (keyof WorkItemPatch)[] = [
  "project",
  "problem",
  "resources",
  "done_criteria",
  "desired_output",
  "scope",
  "allowed_paths",
  "tier",
  "stage",
  "blocked_on",
  "blocked_reason",
  "close_reason",
  "loop_count",
  "restart_count",
  "token_cost",
  "pr_number",
  "merge_sha",
  "fixes_pr",
  "spec_comment_url",
  "failure_comment_url",
  "revision_count",
  "spec_feedback",
  "files_to_change",
  "pr_files",
];

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function newWorkItem(input: NewWorkItem, now: Timestamp): WorkItem {
  const a = input.adopted;
  return {
    id: newId("wi") as WorkItemId,
    version: 1,
    source: input.source,
    title: input.title ?? null,
    requester_id: input.requester_id,
    project: input.project,
    problem: input.problem,
    resources: input.resources,
    done_criteria: null,
    desired_output: null,
    scope: null,
    allowed_paths: a ? a.allowed_paths : [],
    tier: a ? a.tier : null,
    stage: a ? "REVIEW" : "NEW",
    blocked_on: !a && input.hold ? input.hold.blocked_on : "none",
    blocked_reason: !a && input.hold ? input.hold.blocked_reason : null,
    close_reason: null,
    loop_count: 0,
    restart_count: 0,
    token_cost: 0,
    pr_number: a ? a.pr_number : null,
    merge_sha: null,
    fixes_pr: null,
    spec_comment_url: null,
    failure_comment_url: null,
    // At intake `problem` is the issue text itself; triage overwrites `problem`, so keep a copy.
    issue_text: input.problem,
    revision_count: 0,
    spec_feedback: null,
    origin: a ? "adopted" : "factory",
    head_branch: a ? a.head_branch : null,
    last_head_sha: a ? a.head_sha : null,
    parent_id: !a && input.parent ? input.parent.id : null,
    phase: !a && input.parent ? input.parent.phase : null,
    files_to_change: null,
    // An adopted PR's file list is its allowed_paths: the files it changes (design 2026-11-03).
    pr_files: a ? a.allowed_paths : null,
    created_at: now,
    updated_at: now,
  };
}

const WORK_ITEM_COLUMNS =
  "id, version, source_type, source_id, source_link, requester_id, project, problem, resources, done_criteria, " +
  "desired_output, scope, allowed_paths, tier, stage, blocked_on, blocked_reason, close_reason, loop_count, " +
  "restart_count, token_cost, pr_number, merge_sha, fixes_pr, created_at, updated_at, title, spec_comment_url, " +
  "failure_comment_url, issue_text, revision_count, spec_feedback, origin, head_branch, last_head_sha, parent_id, phase, " +
  "files_to_change, pr_files";

/**
 * The columns and values of INSERT INTO work_items; `change` is changeFields of the item's pr_number (the adopted
 * PR's, else none). The change columns are listed only with a PR number: without one they are NULL by default,
 * and intake inserts exactly as before migration 31, also on a schema without them (tests of older steps do).
 */
export function workItemInsert(i: WorkItem, change: ChangeFields): { columns: string; values: SqlValue[] } {
  const values: SqlValue[] = [
    i.id, i.version, i.source.type, i.source.id, i.source.link, i.requester_id, i.project, i.problem,
    JSON.stringify(i.resources), i.done_criteria && JSON.stringify(i.done_criteria), i.desired_output, i.scope,
    JSON.stringify(i.allowed_paths), i.tier, i.stage, i.blocked_on, i.blocked_reason, i.close_reason, i.loop_count,
    i.restart_count, i.token_cost, i.pr_number, i.merge_sha, i.fixes_pr, i.created_at, i.updated_at, i.title,
    i.spec_comment_url, i.failure_comment_url,
    i.issue_text, i.revision_count, i.spec_feedback, i.origin, i.head_branch, i.last_head_sha,
    i.parent_id, i.phase,
    i.files_to_change && JSON.stringify(i.files_to_change), i.pr_files && JSON.stringify(i.pr_files),
  ];
  if (change.change_ref === null) return { columns: WORK_ITEM_COLUMNS, values };
  return { columns: `${WORK_ITEM_COLUMNS}, change_ref, change_url`, values: [...values, change.change_ref, change.change_url] };
}

/** Only the fields that actually change, as state_changes entries and `column = ?` assignments. */
export function diffPatch(
  current: WorkItem,
  patch: WorkItemPatch,
): { changes: StateChange["changes"]; sets: string[]; values: SqlValue[] } {
  const changes: StateChange["changes"] = {};
  const sets: string[] = [];
  const values: SqlValue[] = [];
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    const to = patch[key];
    if (to === undefined) continue;
    const from = current[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    (changes as Record<string, unknown>)[key] = { from, to };
    sets.push(`${key} = ?`);
    values.push(toColumn(key, to));
  }
  return { changes, sets, values };
}

function toColumn(key: string, value: unknown): SqlValue {
  if (value === null) return null;
  if (JSON_COLUMNS.has(key)) return JSON.stringify(value);
  return value as string | number;
}

function parseJson<T>(value: unknown): T {
  return (value === null || value === undefined ? null : JSON.parse(value as string)) as T;
}

export function rowToWorkItem(r: Row): WorkItem {
  return {
    id: r.id as WorkItemId,
    version: Number(r.version),
    source: { type: r.source_type as SourceType, id: r.source_id as string, link: r.source_link as string },
    title: (r.title as string | null | undefined) ?? null,
    requester_id: r.requester_id as WorkItem["requester_id"],
    project: r.project as string,
    problem: r.problem as string,
    resources: parseJson(r.resources),
    done_criteria: parseJson(r.done_criteria),
    desired_output: r.desired_output as string | null,
    scope: r.scope as string | null,
    allowed_paths: parseJson(r.allowed_paths),
    tier: r.tier === null ? null : (Number(r.tier) as WorkItem["tier"]),
    stage: r.stage as WorkItem["stage"],
    blocked_on: r.blocked_on as WorkItem["blocked_on"],
    blocked_reason: r.blocked_reason as string | null,
    close_reason: r.close_reason as WorkItem["close_reason"],
    loop_count: Number(r.loop_count),
    restart_count: Number(r.restart_count),
    token_cost: Number(r.token_cost),
    pr_number: r.pr_number === null ? null : Number(r.pr_number),
    merge_sha: r.merge_sha as string | null,
    fixes_pr: r.fixes_pr === null ? null : Number(r.fixes_pr),
    spec_comment_url: (r.spec_comment_url as string | null | undefined) ?? null,
    failure_comment_url: (r.failure_comment_url as string | null | undefined) ?? null,
    issue_text: (r.issue_text as string | null | undefined) ?? null,
    revision_count: Number(r.revision_count ?? 0),
    spec_feedback: (r.spec_feedback as string | null | undefined) ?? null,
    origin: (r.origin as WorkItem["origin"] | null | undefined) ?? "factory",
    head_branch: (r.head_branch as string | null | undefined) ?? null,
    last_head_sha: (r.last_head_sha as string | null | undefined) ?? null,
    parent_id: (r.parent_id as WorkItemId | null | undefined) ?? null,
    phase: r.phase === null || r.phase === undefined ? null : Number(r.phase),
    files_to_change: parseJson(r.files_to_change),
    pr_files: parseJson(r.pr_files),
    created_at: r.created_at as Timestamp,
    updated_at: r.updated_at as Timestamp,
  };
}

/** A run_attempts row. Its lease_token stays in the store: a fencing token is never returned. */
export function rowToRunAttempt(r: Row): RunAttempt {
  return {
    run_id: r.run_id as RunId,
    attempt: Number(r.attempt),
    worker_id: (r.worker_id as WorkerId | null) ?? null,
    status: r.status as RunAttempt["status"],
    started_at: (r.started_at as Timestamp | null) ?? null,
    finished_at: (r.finished_at as Timestamp | null) ?? null,
    error_code: (r.error_code as string | null) ?? null,
    failure_class: (r.failure_class as RunAttempt["failure_class"]) ?? null,
    tokens: Number(r.tokens),
  };
}

export function rowToRun(r: Row): Run {
  const input = parseJson<RunInput | null>(r.input ?? null);
  // An interactive run's notes and last finish are in its input column (design §5, 2026-11-01); older rows read none.
  const session = input?.session ?? null;
  return {
    id: r.id as RunId,
    work_item_id: r.work_item_id as WorkItemId,
    kind: r.kind as Run["kind"],
    idempotency_key: r.idempotency_key as string,
    status: r.status as Run["status"],
    attempt: Number(r.attempt),
    lease:
      r.lease_owner === null
        ? null
        : {
            owner: r.lease_owner as WorkerId,
            token: Number(r.lease_token),
            expires_at: r.lease_expires_at as Timestamp,
          },
    outcome: parseJson(r.outcome),
    acknowledged_at: r.acknowledged_at as Timestamp | null,
    started_at: (r.started_at as Timestamp | null | undefined) ?? null,
    finished_at: (r.finished_at as Timestamp | null | undefined) ?? null,
    not_before: (r.not_before as Timestamp | null | undefined) ?? null,
    input,
    paused_at: (r.paused_at as Timestamp | null | undefined) ?? null,
    paused_by: (r.paused_by as string | null | undefined) ?? null,
    session_id: (r.session_id as string | null | undefined) ?? null,
    resume: parseJson(r.pause_state ?? null),
    actor_id: (r.actor_id as UserId | null | undefined) ?? null,
    transcript_url: (r.transcript_url as string | null | undefined) ?? null,
    session_tokens: r.session_tokens === null || r.session_tokens === undefined ? null : Number(r.session_tokens),
    session_notes: session?.notes ?? [],
    last_finish: session?.last_finish ?? null,
    created_at: r.created_at as Timestamp,
    updated_at: r.updated_at as Timestamp,
  };
}

export function rowToStateChange(r: Row): StateChange {
  return {
    id: r.id as StateChangeId,
    work_item_id: r.work_item_id as WorkItemId,
    version: Number(r.version),
    at: r.at as Timestamp,
    actor: parseJson(r.actor),
    reason: r.reason as string,
    changes: parseJson(r.changes),
    detail: parseJson(r.detail),
  };
}

export function rowToHandoff(r: Row): Handoff {
  return {
    id: r.id as HandoffId,
    run_id: r.run_id as RunId,
    work_item_id: r.work_item_id as WorkItemId,
    commit_sha: r.commit_sha as string,
    worked_on: r.worked_on as string,
    next_steps: r.next_steps as string,
    at: r.at as Timestamp,
  };
}

export function rowToHostSleep(r: Row): HostSleep {
  return {
    worker_id: r.worker_id as WorkerId,
    woke_at: r.woke_at as Timestamp,
    gap_ms: Number(r.gap_ms),
    run_id: (r.run_id as RunId | null) ?? null,
  };
}

export function rowToVerdict(r: Row): Verdict {
  return {
    id: r.id as VerdictId,
    work_item_id: r.work_item_id as WorkItemId,
    state_change_id: r.state_change_id as StateChangeId,
    verdict: r.verdict as VerdictKind,
    severity: r.severity as VerdictSeverity,
    reason: (r.reason as string | null) ?? null,
    comment_id: r.comment_id as string,
    target: r.target as VerdictTarget,
    at: r.at as Timestamp,
  };
}

export function rowToBudgetCheckpoint(r: Row): BudgetCheckpoint {
  return {
    id: r.id as BudgetCheckpointId,
    work_item_id: r.work_item_id as WorkItemId,
    tier: Number(r.tier) as BudgetCheckpoint["tier"],
    tokens_spent: Number(r.tokens_spent),
    budget: Number(r.budget),
    suggested_budget: Number(r.suggested_budget),
    answer: r.answer as BudgetCheckpoint["answer"],
    granted_budget: r.granted_budget === null || r.granted_budget === undefined ? null : Number(r.granted_budget),
    held_run_kind: r.held_run_kind as BudgetCheckpoint["held_run_kind"],
    held_run_key: r.held_run_key as string,
    held_run_not_before: (r.held_run_not_before as Timestamp | null | undefined) ?? null,
    outcome: (r.outcome as BudgetCheckpoint["outcome"] | undefined) ?? null,
    created_at: r.created_at as Timestamp,
    answered_at: (r.answered_at as Timestamp | null | undefined) ?? null,
  };
}

export function rowToUnreviewedMerge(r: Row): UnreviewedMerge {
  return {
    id: r.id as UnreviewedMergeId,
    project: r.project as string,
    pr_number: Number(r.pr_number),
    merge_sha: r.merge_sha as string,
    merger_id: (r.merger_id as UserId | null | undefined) ?? null,
    at: r.at as Timestamp,
  };
}

export function rowToDependencyEdge(r: Row): DependencyEdge {
  return {
    work_item_id: r.work_item_id as WorkItemId,
    depends_on: r.depends_on as string,
    kind: r.kind as DependencyEdge["kind"],
    state: r.state as DependencyEdge["state"],
    created_at: r.created_at as Timestamp,
    updated_at: r.updated_at as Timestamp,
  };
}

export function rowToClaimDecision(r: Row): ClaimDecision {
  return {
    run_id: r.run_id as RunId,
    work_item_id: r.work_item_id as WorkItemId,
    decision: r.decision as ClaimDecision["decision"],
    holder_work_item_id: (r.holder_work_item_id as WorkItemId | null) ?? null,
    holder_ref: r.holder_ref as string,
    holder_kind: r.holder_kind as ClaimDecision["holder_kind"],
    shared: JSON.parse(r.shared as string) as ClaimDecision["shared"],
    cost: Number(r.cost),
    threshold: Number(r.threshold),
    fallback: Number(r.fallback) === 1,
    approved_by: (r.approved_by as UserId | null) ?? null,
    held_since: (r.held_since as Timestamp | null) ?? null,
    at: r.at as Timestamp,
  };
}
