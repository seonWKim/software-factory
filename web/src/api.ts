// The app talks only to the JSON API under /api/v1 (design §9); nothing else is fetched. Its writes are
// POST /api/v1/settings (postSettings) and POST /api/v1/pauses/resume (postResume), each with the per-process
// CSRF token from its GET (/api/v1/settings, /api/v1/pauses).

import { useQuery } from "@tanstack/react-query";

/** The supervisor's status (the status page's banner); null when the factory is stopped. */
export interface FactoryState {
  state: string;
  rev: string | null;
  target_rev: string | null;
  child_pid: number | null;
  since: string;
  workers: number;
  error: string | null;
  pending: string[];
}

/** `/api/v1/overview`: the page's numbers. */
export interface Overview {
  as_of: string;
  stages: Record<string, number>;
  /** Open items blocked on a person: "Needs you (N)". */
  needs_you: number;
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

/** Whether the Merge button (#246) is disabled: while the item has conflicts or is being checked. */
export function mergeBlocked(m: MergeCheckView | null | undefined): boolean {
  return !!m && m.state !== "mergeable";
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
    version: number;
    created_at: string;
    updated_at: string;
    merge_check?: MergeCheckView | null;
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
  }[];
}

export interface Health {
  checked_at: string;
  checks: { status: string; msg: string }[];
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
}

/** `/api/v1/pauses`: the pauses in effect; `csrf_token` is null when the server has no resume route. */
export interface PausesView {
  pauses: PauseRow[];
  csrf_token: string | null;
}

export const API = {
  overview: "/api/v1/overview",
  items: "/api/v1/items",
  item: (id: string) => `/api/v1/items/${encodeURIComponent(id)}`,
  runs: "/api/v1/runs",
  queue: "/api/v1/queue",
  workers: "/api/v1/workers",
  health: "/api/v1/health",
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

/** POST /api/v1/settings: a set or reset, with the CSRF token. A refusal comes back as `{ ok: false, error }`. */
export async function postSettings(token: string, body: SettingsWrite): Promise<WriteResult> {
  const res = await fetch(API.settings, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify(body),
  });
  let value: { ok?: boolean; lines?: string[]; error?: string } = {};
  try {
    value = (await res.json()) as typeof value;
  } catch {
    // An error without a JSON body: say the status.
  }
  if (res.ok && value.ok) return { ok: true, lines: value.lines ?? [] };
  return { ok: false, error: value.error ?? `HTTP ${res.status}` };
}

/** POST /api/v1/pauses/resume: ends one pause now. A refusal (403, 400, …) comes back as `{ ok: false, error }`. */
export async function postResume(token: string, name: string): Promise<{ ok: true; ended: boolean } | { ok: false; error: string }> {
  const res = await fetch(API.resume, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify({ name }),
  });
  let value: { ended?: boolean; error?: string } = {};
  try {
    value = (await res.json()) as typeof value;
  } catch {
    // An error without a JSON body: say the status.
  }
  if (res.ok) return { ok: true, ended: value.ended === true };
  return { ok: false, error: value.error ?? `HTTP ${res.status}` };
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
