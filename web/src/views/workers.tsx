import { useState } from "react";
import { type GraphEdge, type GraphNode, type ItemGraph, WINDOW_MS, WORKER_WINDOWS, type WindowRun, type WindowRuns, type WorkerWindow, useItemGraph, useWindowRuns } from "../api/workers.js";
import { Card } from "../components/ui/card.js";
import { FOCUS } from "../components/ui/control.js";
import { Tooltip } from "../components/ui/menu.js";
import { EmptyState, PageHeader, PageToolbar } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { en, type MessageKey } from "../i18n/en.js";
import { locale, t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { duration, errorLabel, localClock, localDateTime, runStatusLabel, termLabel } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { runKindLabel } from "./common.js";
import { type KindCategory, KIND_CATEGORIES, connectedNodes, kindCategory, layerOrder, packLanes, timelineSpans } from "./workers-layout.js";

// The Workers page (design 09-dashboard-workers): a timeline of the runs in the window, packed into lanes so the
// lanes in use at a moment are the runs that ran at once, and the items' dependency graph in layers left to right.
// Read only: the window switch is the only control. Bars and nodes are links to the item, each in the shared Tooltip;
// hovering or focusing a node highlights its edges and its runs. Plain elements and one SVG on token colours.

/** The fill of each kind category (tokens `kind-*`). */
const KIND_FILL: Readonly<Record<KindCategory, string>> = {
  triage: "bg-kind-triage",
  implement: "bg-kind-implement",
  review: "bg-kind-review",
  resolve: "bg-kind-resolve",
  "merge-check": "bg-kind-merge-check",
  other: "bg-kind-other",
};

const KIND_LABEL: Readonly<Record<KindCategory, MessageKey>> = {
  triage: "workers.kind.triage",
  implement: "workers.kind.implement",
  review: "workers.kind.review",
  resolve: "workers.kind.resolve",
  "merge-check": "workers.kind.mergeCheck",
  other: "workers.kind.other",
};

/** A bar's look by run status: running pulses, failed has the failed colour's edge. */
const STATUS_LOOK: Readonly<Record<string, string>> = {
  running: "animate-pulse",
  failed: "border-2 border-failed",
  cancelled: "opacity-60",
};

/** A node's fill by stage. */
const STAGE_LOOK: Readonly<Record<string, string>> = {
  NEW: "bg-surface-2",
  READY: "bg-pill-warn-bg",
  RUNNING: "bg-pill-info-bg",
  REVIEW: "bg-pill-ok-bg",
  CLOSED: "border-dashed bg-surface text-text-2",
};

const LANE_PX = 28;
const NODE_W = 168;
const NODE_H = 36;
const GAP_X = 56;
const GAP_Y = 16;

const usd = (n: number): string => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(n);
const titleOf = (title: string | null): string => title || t("workers.untitled");

/** A stage in words: the item's stage phrase, else the code in words. */
function stageLabel(stage: string): string {
  const key = `why.stage.${stage}`;
  return key in en ? t(key as MessageKey) : termLabel(stage);
}

/** The bar tooltip's lines: what is known only; an unknown field is left out, never shown as 0. */
export function runTipLines(run: WindowRun, now: number): string[] {
  const lines = [titleOf(run.item_title), run.work_item_id, t("workers.tip.run", { kind: runKindLabel(run.kind), status: runStatusLabel(run.status) })];
  const started = run.started_at === null ? NaN : Date.parse(run.started_at);
  if (!Number.isNaN(started)) lines.push(t("workers.tip.started", { time: localDateTime(run.started_at!) }));
  if (run.finished_at !== null) {
    lines.push(t("workers.tip.finished", { time: localDateTime(run.finished_at) }));
    if (!Number.isNaN(started)) lines.push(t("workers.tip.duration", { duration: duration(Date.parse(run.finished_at) - started) }));
  } else if (run.status === "running" && !Number.isNaN(started)) {
    lines.push(t("workers.tip.runningFor", { duration: duration(Math.max(0, now - started)) }));
  }
  if (run.status === "failed" && run.error_code) lines.push(t("workers.tip.error", { error: errorLabel(run.error_code) }));
  if (run.model) lines.push(t("workers.tip.model", { model: run.model }));
  if (run.cost_usd !== null) lines.push(t("workers.tip.cost", { cost: usd(run.cost_usd) }));
  return lines;
}

/** The node tooltip's lines: title, id, stage, and the blocked reason when there is one. */
export function nodeTipLines(node: GraphNode): string[] {
  const lines = [titleOf(node.title), node.id, t("workers.tip.stage", { stage: stageLabel(node.stage) })];
  if (node.blocked_reason) lines.push(t("workers.tip.blocked", { reason: termLabel(node.blocked_reason) }));
  return lines;
}

/** Tooltip text: the first line (the title) in bold, the id in mono, the rest plain. */
function TipText({ lines }: { lines: string[] }) {
  return (
    <span className="flex flex-col gap-0.5 text-left">
      {lines.map((l, i) => (
        <span key={i} className={cn(i === 0 && "font-semibold", i === 1 && "font-mono break-all")}>{l}</span>
      ))}
    </span>
  );
}

function Legend() {
  return (
    <ul aria-label={t("workers.legend")} className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2">
      {KIND_CATEGORIES.map((k) => (
        <li key={k} className="flex items-center gap-1">
          <span aria-hidden className={cn("size-3 rounded-control", KIND_FILL[k])} />
          {t(KIND_LABEL[k])}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span aria-hidden className="size-3 animate-pulse rounded-control bg-kind-other" />
        {runStatusLabel("running")}
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className="size-3 rounded-control border-2 border-failed bg-kind-other" />
        {runStatusLabel("failed")}
      </li>
    </ul>
  );
}

/** The timeline: one row per lane, a bar per run, the window's start, middle and now under it. */
export function Timeline({ data, windowMs, highlight }: { data: WindowRuns; windowMs: number; highlight: string | null }) {
  const now = Date.parse(data.as_of);
  const from = now - windowMs;
  const { spans, leftOut } = timelineSpans(data.runs, now, windowMs);
  const { placed, lanes } = packLanes(spans);
  const pct = (ms: number): string => `${((ms - from) / windowMs) * 100}%`;
  return (
    <div data-timeline>
      <p className="text-sm text-text-2">
        {placed.length === 0 ? t("workers.timeline.empty") : t("workers.timeline.lanes", { count: lanes })}
        {leftOut > 0 && <span data-left-out className="ml-3">{t("workers.timeline.leftOut", { count: leftOut })}</span>}
      </p>
      {/* Scrolls inside the card at phone width; the plot keeps a minimum width so short runs stay visible. */}
      <div data-timeline-scroll className="mt-3 overflow-x-auto">
        <div className="relative min-w-160">
          <ul aria-label={t("workers.timeline.label")} className="relative min-h-48" style={{ height: Math.max(1, lanes) * LANE_PX }}>
            {Array.from({ length: lanes }, (_, i) => (
              <li key={`lane-${i}`} aria-hidden className="absolute inset-x-0 border-b border-border" style={{ top: (i + 1) * LANE_PX - 1 }} />
            ))}
            {placed.map(({ run: s, lane }) => {
              const run = s.run;
              const lit = highlight === run.work_item_id;
              const lines = runTipLines(run, now);
              return (
                <li key={run.id} className="absolute" style={{ left: pct(s.start), width: `max(${((s.end - s.start) / windowMs) * 100}%, 4px)`, top: lane * LANE_PX + 4, height: LANE_PX - 8 }}>
                  <Tooltip text={<TipText lines={lines} />} placement={lane < lanes / 2 ? "bottom" : "top"} align={s.start - from < windowMs / 2 ? "start" : "end"} className="h-full w-full">
                    <span
                      aria-hidden
                      data-bar
                      className={cn(
                        "block h-full w-full rounded-control",
                        KIND_FILL[kindCategory(run.kind)],
                        STATUS_LOOK[run.status],
                        lit && "ring-2 ring-text-1 ring-offset-1 ring-offset-surface",
                        highlight !== null && !lit && "opacity-40",
                      )}
                    />
                    {/* The link is the bar's hit area, centred on it and at least 24x24px (the small-target rule); the drawn bar keeps its time width. */}
                    <Link
                      href={itemPath(run.work_item_id)}
                      aria-label={`${lines[0]}: ${lines[2]}`}
                      data-run={run.id}
                      data-highlight={lit ? "true" : undefined}
                      className={cn("absolute top-1/2 left-1/2 h-full min-h-6 w-full min-w-6 -translate-x-1/2 -translate-y-1/2 rounded-control", FOCUS)}
                    />
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          <span aria-hidden data-now className="absolute top-0 right-0 bottom-6 w-px bg-text-1" />
          <div aria-hidden className="mt-1 flex justify-between text-xs text-text-2 tabular-nums">
            <span>{localClock(new Date(from).toISOString())}</span>
            <span>{localClock(new Date(from + windowMs / 2).toISOString())}</span>
            <span>{t("workers.timeline.now")}</span>
          </div>
        </div>
      </div>
      <Legend />
    </div>
  );
}

/** The graph: the items with an edge in layers left to right, edges as SVG curves, the count of items with none. */
export function DependencyGraph({ data, highlight, onHighlight }: { data: ItemGraph; highlight: string | null; onHighlight(id: string | null): void }) {
  const { nodes, alone } = connectedNodes(data.nodes, data.edges);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const { layer, row, layers, rows } = layerOrder(nodes.map((n) => n.id), edges);
  const x = (id: string) => layer.get(id)! * (NODE_W + GAP_X);
  const y = (id: string) => row.get(id)! * (NODE_H + GAP_Y);
  const width = Math.max(0, layers * (NODE_W + GAP_X) - GAP_X);
  const height = Math.max(0, rows * (NODE_H + GAP_Y) - GAP_Y);
  const touches = (e: GraphEdge) => highlight !== null && (e.from === highlight || e.to === highlight);
  return (
    <div data-graph>
      {nodes.length === 0 ? (
        <EmptyState title={t("workers.graph.empty")} />
      ) : (
        <div className="overflow-x-auto">
          <div className="relative min-h-48" style={{ width, height: Math.max(height, NODE_H) }}>
            <svg aria-hidden className="absolute inset-0 overflow-visible" width={width} height={height}>
              {edges.map((e) => {
                const x1 = x(e.from) + NODE_W, y1 = y(e.from) + NODE_H / 2, x2 = x(e.to), y2 = y(e.to) + NODE_H / 2;
                // An edge into an earlier or the same layer (a cycle) bends round the right side instead of crossing back.
                const mid = x2 > x1 ? (x1 + x2) / 2 : x1 + GAP_X / 2;
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    data-edge={`${e.from}>${e.to}`}
                    data-highlight={touches(e) ? "true" : undefined}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${x2 > x1 ? mid : x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    className={cn(touches(e) ? "stroke-text-1" : "stroke-border-strong", e.kind === "phase" && "[stroke-dasharray:4_3]", highlight !== null && !touches(e) && "opacity-40")}
                    strokeWidth={touches(e) ? 2 : 1}
                  />
                );
              })}
            </svg>
            <ul aria-label={t("workers.graph.label")}>
              {nodes.map((n) => {
                const lines = nodeTipLines(n);
                return (
                  <li key={n.id} className="absolute" style={{ left: x(n.id), top: y(n.id), width: NODE_W, height: NODE_H }}>
                    <Tooltip text={<TipText lines={lines} />} placement={row.get(n.id)! < rows / 2 ? "bottom" : "top"} align={layer.get(n.id)! < layers / 2 ? "start" : "end"} className="h-full w-full">
                      <Link
                        href={itemPath(n.id)}
                        data-node={n.id}
                        onMouseEnter={() => onHighlight(n.id)}
                        onMouseLeave={() => onHighlight(null)}
                        onFocus={() => onHighlight(n.id)}
                        onBlur={() => onHighlight(null)}
                        className={cn(
                          "flex h-full w-full items-center truncate rounded-control border border-border-strong px-2 text-sm text-text-1",
                          STAGE_LOOK[n.stage],
                          FOCUS,
                          highlight === n.id && "ring-2 ring-text-1",
                        )}
                      >
                        <span data-raw className="truncate">{lines[0]}</span>
                      </Link>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      <p data-alone className="mt-3 text-sm text-text-2">{t("workers.graph.alone", { count: alone })}</p>
    </div>
  );
}

/** The Workers page: the window switch in its PageToolbar, the timeline card and the graph card. Nothing on it edits anything. */
export function WorkersPage() {
  const [win, setWin] = useState<WorkerWindow>("6h");
  const [highlight, setHighlight] = useState<string | null>(null);
  const runs = useWindowRuns(win);
  const graph = useItemGraph(win);
  return (
    <div>
      <PageHeader title={t("page.workers")} description={t("workers.description")} />
      {/* The window narrows both cards, so it is a page control: the toolbar's second row. */}
      <PageToolbar>
        <SegmentedControl label={t("workers.window")} options={WORKER_WINDOWS.map((w) => ({ id: w, label: w }))} value={win} onChange={setWin} />
      </PageToolbar>
      <Card title={t("workers.timeline.title")}>
        {runs.data ? <Timeline data={runs.data} windowMs={WINDOW_MS[win]} highlight={highlight} /> : runs.isError ? <ErrorNote error={runs.error} /> : <Loading label="loading.timeline" onRetry={() => void runs.refetch()} />}
      </Card>
      <Card title={t("workers.graph.title")}>
        {graph.data ? <DependencyGraph data={graph.data} highlight={highlight} onHighlight={setHighlight} /> : graph.isError ? <ErrorNote error={graph.error} /> : <Loading label="loading.graph" onRetry={() => void graph.refetch()} />}
      </Card>
    </div>
  );
}
