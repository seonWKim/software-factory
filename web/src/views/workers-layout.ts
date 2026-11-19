// Pure layout of the Workers page (design 09-dashboard-workers): which lane each run's bar sits in on the timeline,
// and which layer and row each item sits in on the dependency graph. No React, no DOM: tests call these directly.

/** The timeline's kind categories, in legend order. Every other run kind (update, manual, interactive, improve) is `other`. */
export const KIND_CATEGORIES = ["triage", "implement", "review", "resolve", "merge-check", "other"] as const;
export type KindCategory = (typeof KIND_CATEGORIES)[number];

/** The category a run kind is drawn in. */
export function kindCategory(kind: string): KindCategory {
  return (KIND_CATEGORIES as readonly string[]).includes(kind) ? (kind as KindCategory) : "other";
}

/** A time span in ms since the epoch; `end` is not part of it, so a run that ends when another starts does not overlap it. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Greedy lane packing by start time: runs sorted by start (then end), each put in the lowest lane whose last run has
 * ended by its start. Overlapping runs never share a lane, and the lane count is the most runs running at once.
 */
export function packLanes<T extends Span>(runs: readonly T[]): { placed: { run: T; lane: number }[]; lanes: number } {
  const order = [...runs].sort((a, b) => a.start - b.start || a.end - b.end);
  const ends: number[] = [];
  const placed: { run: T; lane: number }[] = [];
  for (const run of order) {
    let lane = ends.findIndex((end) => end <= run.start);
    if (lane === -1) lane = ends.length;
    ends[lane] = run.end;
    placed.push({ run, lane });
  }
  return { placed, lanes: ends.length };
}

/** A run as the timeline reads it: its start, its finish (null while it runs) and its status. */
export interface TimedRun {
  status: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * The runs the timeline draws, as spans in the window ending at `now`: a running run ends now, a start before the
 * window is cut to the window's start. Queued runs are not on the timeline; a run with no start time is left out and counted.
 */
export function timelineSpans<T extends TimedRun>(runs: readonly T[], now: number, windowMs: number): { spans: (Span & { run: T })[]; leftOut: number } {
  const from = now - windowMs;
  const spans: (Span & { run: T })[] = [];
  let leftOut = 0;
  for (const run of runs) {
    if (run.status === "queued") continue;
    const started = run.started_at === null ? NaN : Date.parse(run.started_at);
    if (Number.isNaN(started)) {
      leftOut++;
      continue;
    }
    const finished = run.finished_at === null ? now : Date.parse(run.finished_at);
    const end = Math.min(Number.isNaN(finished) ? now : finished, now);
    if (end < from) continue;
    spans.push({ run, start: Math.max(started, from), end: Math.max(end, Math.max(started, from)) });
  }
  return { spans, leftOut };
}

export interface Edge {
  from: string;
  to: string;
}

/** The nodes that have at least one edge, in input order, and how many have none. */
export function connectedNodes<T extends { id: string }>(nodes: readonly T[], edges: readonly Edge[]): { nodes: T[]; alone: number } {
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const kept = nodes.filter((n) => linked.has(n.id));
  return { nodes: kept, alone: nodes.length - kept.length };
}

/**
 * Layers left to right: an item sits one layer right of the furthest-right item it depends on (`from` of an edge into
 * it), so every edge points right. A cycle cannot hang it: when only nodes in a cycle are left, the first of them in
 * input order is placed from its placed prerequisites alone. Within a layer, nodes keep input order. Edges to ids
 * not in `ids` are ignored.
 */
export function layerOrder(ids: readonly string[], edges: readonly Edge[]): { layer: Map<string, number>; row: Map<string, number>; layers: number; rows: number } {
  const known = new Set(ids);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (known.has(e.from) && known.has(e.to) && e.from !== e.to) preds.get(e.to)!.push(e.from);
  const layer = new Map<string, number>();
  const left = [...ids];
  while (left.length > 0) {
    let i = left.findIndex((id) => preds.get(id)!.every((p) => layer.has(p)));
    if (i === -1) i = 0; // only cycles left: break one
    const id = left.splice(i, 1)[0]!;
    const placed = preds.get(id)!.filter((p) => layer.has(p)).map((p) => layer.get(p)! + 1);
    layer.set(id, Math.max(0, ...placed));
  }
  const row = new Map<string, number>();
  const filled: number[] = [];
  for (const id of ids) {
    const l = layer.get(id)!;
    row.set(id, filled[l] ?? 0);
    filled[l] = (filled[l] ?? 0) + 1;
  }
  return { layer, row, layers: filled.length, rows: Math.max(0, ...filled.map((n) => n ?? 0)) };
}
