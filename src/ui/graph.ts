// The Workers page's reads (design 09-dashboard-workers): GET /api/v1/runs (with an optional window) and
// GET /api/v1/items/graph?window=. Read-only: store reads only, no schema change. Graph nodes are the open items and
// the items closed in the window; edges come from controller_dependency_edges (a dependent waits for the item whose
// source id it names) and from a split item's parent_id to each phase. An edge whose other end is not a node is left
// out. Titles, blocked reasons, error codes and models pass the Withholder (the caller's `text`); ids, stages and
// kinds are store codes and go out as they are.

import { type Run, type Stage, type Timestamp, type WorkItem, type WorkItemId, outcomeCost } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { LIST_LIMIT } from "./list.js";

const HOUR_MS = 60 * 60 * 1000;

/** The windows the page offers, by name. */
const WINDOWS: Readonly<Record<string, number>> = { "1h": HOUR_MS, "6h": 6 * HOUR_MS, "24h": 24 * HOUR_MS };

/** The window's length for a `window` value, or null when the value is not one of WINDOWS. */
function windowMs(value: string): number | null {
  return Object.hasOwn(WINDOWS, value) ? WINDOWS[value]! : null;
}

const WINDOW_ERROR = "window must be 1h, 6h or 24h.";

/** The model a run's usage names, or null when unknown. */
function runModel(run: Pick<Run, "outcome">): string | null {
  const o = run.outcome;
  const usage = o?.status === "succeeded" ? (o.data.usage as { model?: unknown } | undefined) : o?.usage;
  return typeof usage?.model === "string" ? usage.model : null;
}

type ApiAnswer = { status: number; value: unknown };

/**
 * GET /api/v1/runs: the running and queued runs, each as `row` (api.ts's runRow). With `window` (1h, 6h or 24h; any
 * other value is a 400) it adds the runs finished in the window, and each run also carries its finish time, its item's
 * title (through the Withholder) and stage, its error code when it failed, and its model and cost when known (null
 * when not). Items are read once each.
 */
export async function windowRuns(
  c: { store: Pick<FactoryStore, "getWorkItem" | "listRunsByStatus" | "listRunsFinishedWithin">; text(value: string | null, channel?: "run_outcome"): Promise<string | null>; now: Date },
  window: string | null,
  row: (r: Run) => Promise<object>,
): Promise<ApiAnswer> {
  const ms = window === null ? null : windowMs(window);
  if (window !== null && ms === null) return { status: 400, value: { error: WINDOW_ERROR } };
  const s = c.store;
  const list = [...(await s.listRunsByStatus(["running"], LIST_LIMIT)), ...(await s.listRunsByStatus(["queued"], LIST_LIMIT)), ...(ms === null ? [] : await s.listRunsFinishedWithin(ms))];
  const items = new Map<WorkItemId, Promise<WorkItem | null>>();
  const runs = [];
  for (const r of list) {
    if (ms === null) {
      runs.push(await row(r));
      continue;
    }
    if (!items.has(r.work_item_id)) items.set(r.work_item_id, s.getWorkItem(r.work_item_id));
    const it = await items.get(r.work_item_id)!;
    runs.push({
      ...(await row(r)),
      finished_at: r.finished_at,
      item_title: await c.text(it?.title || null),
      item_stage: it?.stage ?? null,
      error_code: r.outcome?.status === "failed" ? await c.text(r.outcome.error_code, "run_outcome") : null,
      model: await c.text(runModel(r)),
      cost_usd: outcomeCost(r.outcome),
    });
  }
  return { status: 200, value: { as_of: c.now.toISOString(), ...(ms === null ? {} : { window }), runs } };
}

export interface GraphCtx {
  store: Pick<FactoryStore, "listWorkItemsWhere" | "listDependencyEdges">;
  /** The value through the Withholder; null stays null. */
  text(value: string | null): Promise<string | null>;
  now: Date;
}

export interface GraphNode {
  id: WorkItemId;
  title: string | null;
  stage: Stage;
  blocked_reason: string | null;
}

/** `from` is the prerequisite (or the split parent), `to` the item that waits for it (or the phase). */
export interface GraphEdge {
  from: WorkItemId;
  to: WorkItemId;
  kind: "dependency" | "phase";
}

/**
 * GET /api/v1/items/graph?window=: every node and every edge between two nodes, each edge once. No window reads 6h;
 * any other value is a 400.
 */
export async function itemGraph(c: GraphCtx, window: string | null): Promise<ApiAnswer> {
  const ms = windowMs(window ?? "6h");
  if (ms === null) return { status: 400, value: { error: WINDOW_ERROR } };
  const since = new Date(c.now.getTime() - ms).toISOString() as Timestamp;
  const open = await c.store.listWorkItemsWhere({ exclude_closed: true, limit: LIST_LIMIT });
  const closed = await c.store.listWorkItemsWhere({ stage: "CLOSED", updated_since: since, limit: LIST_LIMIT });
  const items = new Map<WorkItemId, WorkItem>();
  for (const it of [...open, ...closed]) items.set(it.id, it);
  const bySource = new Map<string, WorkItemId>();
  for (const it of items.values()) if (!bySource.has(it.source.id)) bySource.set(it.source.id, it.id);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: WorkItemId | undefined, to: WorkItemId, kind: GraphEdge["kind"]) => {
    if (from === undefined || from === to || !items.has(from) || !items.has(to)) return;
    const key = `${from}\n${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  for (const e of await c.store.listDependencyEdges()) add(bySource.get(e.depends_on), e.work_item_id, "dependency");
  for (const it of items.values()) if (it.parent_id !== null) add(it.parent_id, it.id, "phase");

  const nodes: GraphNode[] = [];
  for (const it of items.values()) {
    nodes.push({ id: it.id, title: await c.text(it.title || null), stage: it.stage, blocked_reason: await c.text(it.blocked_reason) });
  }
  return { status: 200, value: { as_of: c.now.toISOString(), nodes, edges } };
}
