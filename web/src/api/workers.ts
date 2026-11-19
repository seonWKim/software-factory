// The Workers page (design 09-dashboard-workers): GET /api/v1/runs?window= (running, queued and finished runs with
// their item's title and stage) and GET /api/v1/items/graph?window= (items and their dependency edges). Read-only.
// A null field is unknown and is left out on the page, never shown as 0.

import { useApi } from "./client.js";
import { API } from "./routes.js";

/** The windows the page offers; 6h is the default. */
export const WORKER_WINDOWS = ["1h", "6h", "24h"] as const;
export type WorkerWindow = (typeof WORKER_WINDOWS)[number];
export const WINDOW_MS: Readonly<Record<WorkerWindow, number>> = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000 };

/** The page reads again every 10 seconds while it is visible. */
export const WORKERS_POLL_MS = 10_000;

export interface WindowRun {
  id: string;
  status: string;
  kind: string;
  work_item_id: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  /** Through the Withholder: a withheld title is its marker. Null: the item has none. */
  item_title: string | null;
  item_stage: string | null;
  error_code: string | null;
  model: string | null;
  cost_usd: number | null;
}

export interface WindowRuns {
  as_of: string;
  window: WorkerWindow;
  runs: WindowRun[];
}

export interface GraphNode {
  id: string;
  title: string | null;
  stage: string;
  blocked_reason: string | null;
}

/** `from` is what `to` depends on (or the split parent of phase `to`). */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "dependency" | "phase";
}

export interface ItemGraph {
  as_of: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const useWindowRuns = (w: WorkerWindow) => useApi<WindowRuns>(API.runsIn(w), WORKERS_POLL_MS);
export const useItemGraph = (w: WorkerWindow) => useApi<ItemGraph>(API.itemGraph(w), WORKERS_POLL_MS);
