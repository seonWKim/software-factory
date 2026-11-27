// The Work, Workers, Failures and Spend pages: GET /api/v1/runs, /api/v1/queue, /api/v1/workers, /api/v1/failures and /api/v1/spend.

import type { Why } from "./items.js";

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

/** `/api/v1/spend`: cost and tokens of the agent runs per UTC day and per item. `unknown`: runs with no stored cost, never added as 0. */
export interface SpendTotals {
  cost_usd: number;
  tokens: number;
  runs: number;
  unknown: number;
}
/** The chat turns' or coordinator cycles' totals of the range, apart from the runs; `turns` counts cycles for the coordinator. `unknown`: rows with no stored cost, never added as 0. */
export interface SpendTurnTotals {
  cost_usd: number;
  tokens: number;
  turns: number;
  unknown: number;
}
export interface SpendDay extends SpendTotals {
  day: string;
  /** The day's items with the most known cost, at most 3, most first. */
  top: { work_item_id: string; title: string | null; cost_usd: number }[];
}
export interface SpendItem extends SpendTotals {
  work_item_id: string;
  title: string | null;
  kinds: string[];
}
export interface SpendView {
  as_of: string;
  /** Today's UTC day and the Monday its week began (YYYY-MM-DD). */
  today: string;
  week_start: string;
  /** The daily and weekly budgets in dollars; null: none set. */
  budgets: { daily_usd: number | null; weekly_usd: number | null };
  from: string;
  to: string;
  total: SpendTotals;
  /** Chat turns and coordinator cycles, each apart from `total`, the days, the items and the budgets. */
  chat: SpendTurnTotals;
  coordinator: SpendTurnTotals;
  days: SpendDay[];
  /** By cost, highest first; at most a cap of them, `items_total` in all. */
  items: SpendItem[];
  items_total: number;
}
