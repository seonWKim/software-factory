// Row mapping and patch diffing shared by the SQL FactoryStore implementations.
// Columns are identical across backends: JSON as text, timestamps as ISO-8601 strings.

import { randomUUID } from "node:crypto";
import type {
  Handoff,
  HandoffId,
  Run,
  RunId,
  SourceType,
  StateChange,
  StateChangeId,
  Timestamp,
  WorkItem,
  WorkItemId,
  WorkItemPatch,
  WorkerId,
} from "../../core/types.js";
import type { NewWorkItem } from "../../interfaces/factory-store.js";

export type Row = Record<string, unknown>;

const JSON_COLUMNS = new Set(["resources", "done_criteria", "allowed_paths"]);
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
];

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function newWorkItem(input: NewWorkItem, now: Timestamp): WorkItem {
  return {
    id: newId("wi") as WorkItemId,
    version: 1,
    source: input.source,
    requester_id: input.requester_id,
    project: input.project,
    problem: input.problem,
    resources: input.resources,
    done_criteria: null,
    desired_output: null,
    scope: null,
    allowed_paths: [],
    tier: null,
    stage: "NEW",
    blocked_on: "none",
    blocked_reason: null,
    close_reason: null,
    loop_count: 0,
    restart_count: 0,
    token_cost: 0,
    pr_number: null,
    merge_sha: null,
    fixes_pr: null,
    created_at: now,
    updated_at: now,
  };
}

/** Column values for INSERT INTO work_items, in WORK_ITEM_COLUMNS order. */
export const WORK_ITEM_COLUMNS =
  "id, version, source_type, source_id, source_link, requester_id, project, problem, resources, done_criteria, " +
  "desired_output, scope, allowed_paths, tier, stage, blocked_on, blocked_reason, close_reason, loop_count, " +
  "restart_count, token_cost, pr_number, merge_sha, fixes_pr, created_at, updated_at";

export function workItemValues(i: WorkItem): (string | number | null)[] {
  return [
    i.id, i.version, i.source.type, i.source.id, i.source.link, i.requester_id, i.project, i.problem,
    JSON.stringify(i.resources), i.done_criteria && JSON.stringify(i.done_criteria), i.desired_output, i.scope,
    JSON.stringify(i.allowed_paths), i.tier, i.stage, i.blocked_on, i.blocked_reason, i.close_reason, i.loop_count,
    i.restart_count, i.token_cost, i.pr_number, i.merge_sha, i.fixes_pr, i.created_at, i.updated_at,
  ];
}

/** Only the fields that actually change, as state_changes entries and `column = ?` assignments. */
export function diffPatch(
  current: WorkItem,
  patch: WorkItemPatch,
): { changes: StateChange["changes"]; sets: string[]; values: (string | number | null)[] } {
  const changes: StateChange["changes"] = {};
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
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

function toColumn(key: string, value: unknown): string | number | null {
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
    created_at: r.created_at as Timestamp,
    updated_at: r.updated_at as Timestamp,
  };
}

export function rowToRun(r: Row): Run {
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
