// The app talks only to the JSON API under /api/v1 (design §9); nothing else is fetched. Its writes are
// POST /api/v1/settings (postSettings), POST /api/v1/items/:id/commands (postCommand) and POST /api/v1/pauses/resume
// (postResume), each with the per-process CSRF token (from GET /api/v1/settings, /api/v1/session or /api/v1/pauses)
// in x-csrf-token.

import { useQuery } from "@tanstack/react-query";

/** The supervisor's status (the status page's banner); null when the factory is stopped. */
export interface FactoryState {
  state: string;
  rev: string | null;
  target_rev: string | null;
  child_pid: number | null;
  since: string;
  /** The effective `workers` setting (file, override or default, capped at max_workers), not the status file's value. */
  workers: number;
  workers_source: "override" | "file" | "default";
  error: string | null;
  pending: string[];
}

/** What the factory needs from the operator besides a work item (design §9), with the command that clears it. */
export interface SystemAction {
  code: "migration_pending" | "token_expiring" | "claim_pause" | "worker_pause" | "claim_deadlock" | "revision_mismatch";
  text: string;
  command: string;
  /** When it ends by itself, else null. */
  until: string | null;
  /** The item it is about (a deadlock), else null. */
  work_item_id: string | null;
}

/** `/api/v1/overview`: the page's numbers. */
export interface Overview {
  as_of: string;
  /** The git revision the UI server runs; compared with WEB_REV. Null: unknown. */
  server_rev?: string | null;
  stages: Record<string, number>;
  /** Open items blocked on a person plus the system actions: "Needs you (N)". */
  needs_you: number;
  system_actions?: SystemAction[];
  running: number;
  queued: number;
  last_24h: { succeeded: number; failed: number; tokens: number };
  /** PRs recorded as merged with no work item in the last 7 days. */
  unreviewed_merges_7d?: number;
  /** Which plugins are in use: the tables show Issue and PR columns only for "github". */
  plugins?: { issues: "github" | null; prs: "github" | null };
  /** Absent when the server has no status function. */
  factory?: FactoryState | null;
}

export interface SourceRef {
  type: string;
  id: string;
  link: string;
}

/**
 * The local merge check of a ready-to-merge item (design §5 Merge check); null for any other item. `checking`:
 * no result yet for its current head. The shas and time say which base it was checked against, and when.
 */
export interface MergeCheckView {
  state: "mergeable" | "conflicts" | "checking";
  conflicts: string[];
  head_sha: string | null;
  base_sha: string | null;
  checked_at: string | null;
}

/** The short label shown next to a ready-to-merge item's state. */
export function mergeCheckLabel(m: MergeCheckView): string {
  if (m.state === "mergeable") return "Mergeable";
  if (m.state === "checking") return "Checking…";
  return `Conflicts: ${m.conflicts.length} ${m.conflicts.length === 1 ? "file" : "files"}`;
}

/**
 * The Merge button's data (design §9, issue #246): present only on a factory PR waiting for a human merge in a
 * project with the merge command on. The confirmation shows the title, tier, size and PR link; `files` and `lines`
 * are null when the server does not know them. `replies`: the item's merge requests.
 */
export interface MergeView {
  pr_number: number;
  pr_url: string | null;
  title: string | null;
  tier: number | null;
  files: number | null;
  lines: number | null;
  replies: CommandReply[];
}

/** Whether the Merge button (#246) is disabled: while the item has conflicts or is being checked. */
export function mergeBlocked(m: MergeCheckView | null | undefined): boolean {
  return !!m && m.state !== "mergeable";
}

/**
 * Why an item waits (design §9, issue #310): one sentence, who moves it next, and the same-repo issue numbers
 * the sentence names as `#N`. `ref_url` + a number is that issue's URL; null: show the number without a link.
 */
export interface Why {
  code: string;
  text: string;
  next_actor: "human" | "factory" | "other_item" | "none";
  refs: number[];
  ref_url: string | null;
}

export interface ItemRow {
  id: string;
  source: SourceRef;
  title: string | null;
  level: string;
  badges: string[];
  stage: string;
  tier: number | null;
  kind: string | null;
  blocked_on: string;
  blocked_reason: string | null;
  close_reason: string | null;
  run_status: string | null;
  pr_number: number | null;
  pr_url: string | null;
  /** The source issue; null for an adopted PR. */
  issue?: { number: number; url: string } | null;
  since: string;
  updated_at: string;
  version: number;
  dependents: number;
  conflicts: { automatic: number; person: number };
  merge_check?: MergeCheckView | null;
  merge?: MergeView | null;
  /**
   * What a Needs-you row says: the reason and the command to type (src/ui/need.ts); absent for other rows.
   * `anchor`: the item page's anchor of the newest factory thread entry (`msg-<seq>`), null when it has none.
   */
  need?: { reason: string; command: string | null; anchor?: string | null };
  why?: Why;
  /** The split parent (null for any other item) and this item's place among its phases. */
  parent_id?: string | null;
  phase?: number | null;
  /** The issue number this item waits on, when it is exactly one (a held phase's previous phase, one dependency). */
  waiting_on_number?: number | null;
  /** The item's queued or running run; `position` is a queued run's place in the queue. */
  run?: { kind: string; status: string; attempt: number; worker_id: string | null; started_at: string | null; position: number | null } | null;
  /** The item's latest claim decision; `holder` is "#92", `holder_id` the holding item when it has one. */
  claim?: { decision: string; holder: string | null; holder_id: string | null; approved: boolean; cost: number; threshold: number } | null;
}

export interface Items {
  as_of: string;
  total: number;
  items: ItemRow[];
  facets: { state: Record<string, number>; allStates: number };
}

export interface RunRow {
  id: string;
  status: string;
  kind: string;
  work_item_id: string;
  attempt: number;
  owner: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
}

export interface QueueRow {
  position: number;
  id: string;
  kind: string;
  work_item_id: string;
  attempt: number;
  created_at: string;
  not_before: string | null;
  /** Why its item waits; null when the item is gone. */
  why?: Why | null;
}

/** One phase of a split parent, as the item API lists it. */
export interface PhaseRow {
  id: string;
  phase: number;
  title: string | null;
  stage: string;
  source: SourceRef;
}

export interface ItemDetail {
  as_of: string;
  item: {
    id: string;
    source: SourceRef;
    title: string | null;
    stage: string;
    close_reason: string | null;
    blocked_on: string;
    blocked_reason: string | null;
    tier: number | null;
    loop_count: number;
    restart_count: number;
    token_cost: number;
    pr_number: number | null;
    pr_url: string | null;
    /** The posted spec comment; null before triage posts it. */
    spec_comment_url?: string | null;
    /** A phase of a split spec: its parent's id and its place in merge order; both null on any other item. */
    parent_id?: string | null;
    phase?: number | null;
    /** A split parent's phases in phase order; empty for any other item. */
    phases?: PhaseRow[];
    version: number;
    created_at: string;
    updated_at: string;
    merge_check?: MergeCheckView | null;
    why?: Why;
  };
  timeline: {
    version: number;
    at: string;
    actor: { kind: string; id: string | null };
    reason: string | null;
    changes: Record<string, { from: string | null; to: string | null }>;
    detail: Record<string, string | null> | null;
  }[];
  runs: {
    id: string;
    kind: string;
    status: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    tokens: number | null;
    error: { code: string | null; detail: string | null } | null;
    /** One record per claim, in attempt order; the last one's worker is the run's worker. */
    attempts?: { attempt: number; worker_id: string | null }[];
  }[];
  /** Host sleeps recorded during one of the item's runs, newest first. */
  sleeps?: HostSleepRow[];
  /** The item's thread (src/ui/thread.ts), oldest first; every body already through the Withholder. */
  thread?: ThreadEntry[];
  /** The commands that apply in the item's current state, in the order to show them. */
  commands?: ItemCommand[];
  /** The item's app command requests, oldest first; the note is never returned. */
  replies?: CommandReply[];
  /** Run id → its stored transcript parts ("" is the main step); a run not listed has no transcript. */
  transcripts?: Record<string, string[]>;
  merge?: MergeView | null;
}

/** One entry of an item's thread: `author` is `factory` or `unknown` (no author is stored), `channel` the item's source type. */
export interface ThreadEntry {
  seq: number;
  at: string;
  kind: string;
  author: string;
  channel: string;
  /** The entry's id on the item page: `msg-<seq>`. */
  anchor: string;
  body: string;
}

/** One host sleep a worker saw (a wait that ended over 60 s late): ids, a time and a number only. */
export interface HostSleepRow {
  worker_id: string;
  woke_at: string;
  /** How late the wait ended, in ms. */
  gap_ms: number;
  run_id: string | null;
}

/** Which steps the transcript filter keeps (tool calls of that kind). */
export type StepFilter = "edits" | "commands" | "reads";

/** One step of a stored transcript; withheld text is "[withheld: <rule>]" and its tool is null. */
export interface TranscriptStep {
  id: string;
  kind: "text" | "tool_use" | "tool_result" | "result" | "system" | "error" | "plain" | "other" | "oversize";
  tool: string | null;
  text: string;
  is_error: boolean;
  withheld: boolean;
  truncated?: boolean;
}

/** One page of a run's stored transcript (GET /api/v1/items/<id>/runs/<run>/transcript). */
export interface TranscriptPage {
  run: {
    id: string;
    kind: string;
    status: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    worker_id: string | null;
    outcome: { status: string; error_code: string | null; detail: string | null; summary: string | null } | null;
  };
  parts: string[];
  part: string;
  format: "stream-json" | "plain";
  size: number;
  mode: "forward" | "tail";
  filter: StepFilter | null;
  start: number;
  /** The next page's byte offset; null at the end (or for a tail page). */
  next: number | null;
  /** Steps before `start` exist (a tail page, or a later forward page). */
  earlier: boolean;
  steps: TranscriptStep[];
}

export interface ItemCommand {
  name: string;
  usage: string;
  description: string;
}

/** One app command request: `handled_at` null while the controller has not applied or refused it. */
export interface CommandReply {
  seq: number;
  command: string | null;
  created_at: string;
  handled_at: string | null;
  refusal: string | null;
}

/** `/api/v1/session`: the token item commands send, and whether `ui.user_id` is set. */
export interface Session {
  as_of: string;
  csrf_token: string;
  commands_enabled: boolean;
}

export type CommandResult = { ok: true; seq: number } | { ok: false; error: string };

export interface Health {
  checked_at: string;
  checks: { status: string; msg: string }[];
  /** The 10 newest host sleeps, newest first. */
  sleeps?: HostSleepRow[];
}

/** `/api/v1/unreviewed-merges`: PRs that merged with no work item, newest first. */
export interface UnreviewedMerges {
  as_of: string;
  merges: { project: string | null; pr_number: number; pr_url: string | null; merge_sha: string | null; merged_by: string | null; recorded_at: string }[];
}

/** One settable key on the Settings page. Values are JSON text, as `factory settings set` takes them. */
export interface SettingRow {
  key: string;
  /** What the key controls, from the settings core module. */
  description: string;
  kind: "number" | "boolean" | "models" | "model_by";
  value: string;
  source: "override" | "file" | "default";
  file_value: string | null;
  default_value: string;
  applies_at: string;
  project_settable: boolean;
  projects: { project: string; value: string; source: "override" | "file" }[];
  /** workers only: the file's max_workers, and the cap when the stored value is above it. */
  max?: number;
  capped_at?: number | null;
}

/** `/api/v1/settings`. */
export interface SettingsView {
  as_of: string;
  /** Sent back in x-csrf-token on every write; a reload fetches a new one after a restart. */
  csrf_token: string;
  /** The configured repo's owner/name: the `project` a per-project write names. */
  repo: string;
  /** Its stored label; null: none stored, so per-project writes go through `factory settings`. */
  project: string | null;
  project_keys: string[];
  keys: SettingRow[];
  pr_only: { key: string; note: string; description: string }[];
  ignored: { key: string; project: string | null; value: string; reason: string }[];
  history: { seq: number; at: string; actor: string; key: string; project: string | null; old_value: string | null; new_value: string | null }[];
}

export type SettingsWrite = { action: "set"; key: string; value: string; project?: string } | { action: "reset"; key: string; project?: string };

/** The answer to a write: the CLI's lines, or its refusal. */
export type WriteResult = { ok: true; lines: string[] } | { ok: false; error: string };

/** `/api/v1/data/tables`: every store table (design §9 Data page). */
export interface DataTables {
  as_of: string;
  tables: { name: string; rows: number; columns: string[]; hidden: string[] }[];
}

/** A cell as the API returns it: hidden columns are "[hidden]", withheld text "[withheld: <rule>]". */
export type DataCell = string | number | null;

/** `/api/v1/data/tables/:name`: one page of a table's rows, newest first. */
export interface DataPageBody {
  as_of: string;
  table: string;
  columns: string[];
  hidden: string[];
  order_by: string[];
  filter: { column: string; value: string | null } | null;
  total: number;
  page: number;
  limit: number;
  rows: Record<string, DataCell>[];
  /** Run id → the work item that owns it, for the run ids in this page. */
  run_items: Record<string, string>;
}

/** One claim pause in effect (design §5 Restarts). `ends_at`: for model_stall, the next probe time. */
export interface PauseRow {
  name: string;
  ends_at: string;
  /** When a model stall began; absent for the pauses that have no start time. */
  since?: string | null;
}

/** `/api/v1/pauses`: the pauses in effect; `csrf_token` is null when the server has no resume route. */
export interface PausesView {
  pauses: PauseRow[];
  csrf_token: string | null;
}

declare const __FACTORY_REV__: string | null | undefined;

/** The git revision built into this app (Vite `define`, web/vite.config.ts); null in a test or a build without git. */
export const WEB_REV: string | null = typeof __FACTORY_REV__ === "string" ? __FACTORY_REV__ : null;

/** One live worker process of `/api/v1/workers` (`processes`). `slots` 0 is a draining process. */
export interface WorkerProcess {
  process_id: string;
  pid: number;
  host: string;
  slots: number;
  max_slots: number;
  busy: number;
  idle: number;
  started_at: string;
  reported_at: string;
  runs: { id: string; kind: string; work_item_id: string; worker_id: string; started_at: string | null }[];
}

/** `/api/v1/workers`. `processes_error` is set when the processes could not be read. */
export interface WorkersView {
  as_of: string;
  workers: { owner: string; running: number }[];
  processes?: WorkerProcess[];
  processes_error?: string;
}

/** `/api/v1/failures`: failed runs of a window grouped by error code. */
export interface FailureRun {
  id: string;
  work_item_id: string;
  kind: string;
  attempt: number;
  detail: string;
  worker: string | null;
  finished_at: string | null;
}
export interface FailureGroup {
  code: string;
  /** Plain words for a known code; null for an unknown one. */
  description: string | null;
  count: number;
  last_seen: string | null;
  items: number;
  runs: FailureRun[];
}
export interface Failures {
  as_of: string;
  window: "24h" | "7d";
  cap: number;
  total: number;
  capped: boolean;
  groups: FailureGroup[];
}

export const API = {
  // The app's own revision goes along, so the server lists a mismatch in Needs you.
  overview: WEB_REV ? `/api/v1/overview?rev=${encodeURIComponent(WEB_REV)}` : "/api/v1/overview",
  items: "/api/v1/items",
  item: (id: string) => `/api/v1/items/${encodeURIComponent(id)}`,
  itemCommands: (id: string) => `/api/v1/items/${encodeURIComponent(id)}/commands`,
  session: "/api/v1/session",
  transcript: (id: string, run: string, params: URLSearchParams) => {
    const q = params.toString();
    return `/api/v1/items/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}/transcript${q ? `?${q}` : ""}`;
  },
  runs: "/api/v1/runs",
  queue: "/api/v1/queue",
  workers: "/api/v1/workers",
  health: "/api/v1/health",
  failures: (window: string) => `/api/v1/failures?window=${window}`,
  unreviewedMerges: "/api/v1/unreviewed-merges",
  settings: "/api/v1/settings",
  pauses: "/api/v1/pauses",
  resume: "/api/v1/pauses/resume",
  dataTables: "/api/v1/data/tables",
  dataTable: (name: string, params: URLSearchParams) => {
    const q = params.toString();
    return `/api/v1/data/tables/${encodeURIComponent(name)}${q ? `?${q}` : ""}`;
  },
} as const;

/** Polling interval while the document is visible; TanStack Query stops it while the tab is hidden. */
export const POLL_MS = 3000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** One API read, polled every POLL_MS while the document is visible. */
export function useApi<T>(url: string, pollMs: number | false = POLL_MS) {
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

/** A JSON POST with the CSRF token: the status and the parsed body ({} when the body is not JSON). */
async function postJson<T extends { error?: string }>(url: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; value: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify(body),
  });
  let value = {} as T;
  try {
    value = (await res.json()) as T;
  } catch {
    // An error without a JSON body: the caller says the status.
  }
  return { ok: res.ok, status: res.status, value };
}

/** POST /api/v1/settings: a set or reset, with the CSRF token. A refusal comes back as `{ ok: false, error }`. */
export async function postSettings(token: string, body: SettingsWrite): Promise<WriteResult> {
  const r = await postJson<{ ok?: boolean; lines?: string[]; error?: string }>(API.settings, token, body);
  if (r.ok && r.value.ok) return { ok: true, lines: r.value.lines ?? [] };
  return { ok: false, error: r.value.error ?? `HTTP ${r.status}` };
}

/** POST /api/v1/items/:id/commands: `{ command, note }`, the note only when it has text. 202 → the request's seq. */
export async function postCommand(token: string, id: string, command: string, note: string): Promise<CommandResult> {
  const text = note.trim();
  const r = await postJson<{ seq?: number; error?: string }>(API.itemCommands(id), token, text ? { command, note: text } : { command });
  if (r.ok) return { ok: true, seq: r.value.seq ?? 0 };
  return { ok: false, error: r.value.error ?? `HTTP ${r.status}` };
}

/** POST /api/v1/pauses/resume: ends one pause now. A refusal (403, 400, …) comes back as `{ ok: false, error }`. */
export async function postResume(token: string, name: string): Promise<{ ok: true; ended: boolean } | { ok: false; error: string }> {
  const r = await postJson<{ ended?: boolean; error?: string }>(API.resume, token, { name });
  if (r.ok) return { ok: true, ended: r.value.ended === true };
  return { ok: false, error: r.value.error ?? `HTTP ${r.status}` };
}

/**
 * One API read that never refetches on its own: no interval, no refetch on focus, mount or reconnect. Only the
 * Refresh button (which invalidates every query) reads it again. For the Data page, whose reads are heavier.
 */
export function useManualApi<T>(url: string | null) {
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url!),
    enabled: url !== null,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}
