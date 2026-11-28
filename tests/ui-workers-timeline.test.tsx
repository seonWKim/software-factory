// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
// The Workers page's pure layout (design 09-dashboard-workers): lane packing by start time (overlapping runs never
// share a lane, and the lane count is the most runs at once), runs left out with no start time, the graph's layers
// (each dependent right of its prerequisite, a cycle that does not hang), the count of items with no dependencies,
// and what each tooltip says (an unknown field left out, never shown as 0). Then the page in the app at /app/workers:
// the 1h/6h/24h window switch (6h first), the 10-second refresh, bars and nodes with the shared Tooltip on hover and
// keyboard focus, a node's hover lighting its edges and its runs, a click opening the item, the left-out and
// no-dependency counts, and no control that edits anything.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { KIND_CATEGORIES, connectedNodes, kindCategory, layerOrder, packLanes, timelineSpans } from "../web/src/views/workers-layout.js";
import { nodeTipLines, runTipLines } from "../web/src/views/workers.js";

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** The most spans running at one moment, by a sweep over their starts and ends (an end before a start at the same time). */
function mostAtOnce(spans: readonly { start: number; end: number }[]): number {
  const events = spans.flatMap((s) => [[s.start, 1], [s.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, most = 0;
  for (const [, d] of events) most = Math.max(most, (now += d));
  return most;
}

describe("lane packing", () => {
  it("puts overlapping runs in different lanes and reuses a lane once its run has ended", () => {
    const runs = [
      { id: "a", start: 0, end: 10 },
      { id: "b", start: 5, end: 15 },
      { id: "c", start: 10, end: 20 }, // starts as a ends: a's lane is free again
      { id: "d", start: 6, end: 8 },
    ];
    const { placed, lanes } = packLanes(runs);
    const lane = Object.fromEntries(placed.map((p) => [p.run.id, p.lane]));
    expect(lane.a).not.toBe(lane.b);
    expect(lane.d).not.toBe(lane.a);
    expect(lane.d).not.toBe(lane.b);
    expect(lane.c).toBe(lane.a);
    expect(lanes).toBe(mostAtOnce(runs));
  });

  it("over many runs no two overlapping runs share a lane, and the lane count is the most running at once", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 20; round++) {
      const runs = Array.from({ length: 40 }, (_, i) => {
        const start = Math.floor(rand() * 1000);
        return { id: `r${i}`, start, end: start + 1 + Math.floor(rand() * 200) };
      });
      const { placed, lanes } = packLanes(runs);
      expect(placed.map((p) => p.run.id).sort()).toEqual(runs.map((r) => r.id).sort());
      for (const p of placed) for (const q of placed) if (p !== q && p.lane === q.lane) expect(overlaps(p.run, q.run), `${p.run.id} ${q.run.id}`).toBe(false);
      expect(lanes).toBe(mostAtOnce(runs));
    }
  });

  it("places runs in start order whatever the input order", () => {
    const { placed } = packLanes([{ start: 20, end: 30 }, { start: 0, end: 5 }]);
    expect(placed.map((p) => p.run.start)).toEqual([0, 20]);
    expect(placed.map((p) => p.lane)).toEqual([0, 0]);
  });
});

describe("timeline spans", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  it("leaves out runs with no start time and counts them, leaves out queued runs, ends a running run now and cuts the window's start", () => {
    const { spans, leftOut } = timelineSpans([
      { id: "run", status: "running", started_at: at(1), finished_at: null },
      { id: "nostart", status: "failed", started_at: null, finished_at: at(1) },
      { id: "queued", status: "queued", started_at: null, finished_at: null },
      { id: "early", status: "succeeded", started_at: at(8), finished_at: at(5) },
      { id: "old", status: "succeeded", started_at: at(9), finished_at: at(7) },
    ], now, 6 * 3_600_000);
    expect(leftOut).toBe(1);
    expect(spans.map((s) => s.run.id)).toEqual(["run", "early"]);
    expect(spans[0].end).toBe(now);
    expect(spans[1].start).toBe(now - 6 * 3_600_000);
  });
});

describe("run kind categories", () => {
  it("are the six categories, other holding update, manual, interactive and improve", () => {
    expect(KIND_CATEGORIES).toEqual(["triage", "implement", "review", "resolve", "merge-check", "other"]);
    for (const k of ["triage", "implement", "review", "resolve", "merge-check"]) expect(kindCategory(k)).toBe(k);
    for (const k of ["update", "manual", "interactive", "improve"]) expect(kindCategory(k)).toBe("other");
  });
});

describe("graph layers", () => {
  it("puts each dependent in a layer right of its prerequisite", () => {
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "d", to: "c" }];
    const { layer, row } = layerOrder(["c", "b", "a", "d"], edges);
    for (const e of edges) expect(layer.get(e.to)!, `${e.from} -> ${e.to}`).toBeGreaterThan(layer.get(e.from)!);
    expect(layer.get("a")).toBe(0);
    expect(layer.get("d")).toBe(0);
    // Two in one layer get two rows.
    expect(row.get("a")).not.toBe(row.get("d"));
  });

  it("does not hang on a cycle and still places every node", () => {
    const { layer, layers } = layerOrder(["x", "y", "z", "w"], [{ from: "x", to: "y" }, { from: "y", to: "z" }, { from: "z", to: "x" }, { from: "z", to: "w" }]);
    expect([...layer.keys()].sort()).toEqual(["w", "x", "y", "z"]);
    expect(layers).toBeGreaterThan(0);
    expect(layer.get("w")!).toBeGreaterThan(layer.get("z")!);
  });

  it("ignores edges to ids it was not given", () => {
    const { layer } = layerOrder(["a"], [{ from: "gone", to: "a" }]);
    expect(layer.get("a")).toBe(0);
  });
});

describe("items with no dependencies", () => {
  it("are left out of the graph and counted", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const { nodes: kept, alone } = connectedNodes(nodes, [{ from: "a", to: "b" }]);
    expect(kept.map((n) => n.id)).toEqual(["a", "b"]);
    expect(alone).toBe(3);
  });
});

describe("tooltips", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const base = { id: "r1", kind: "implement", work_item_id: "wi_1", attempt: 1, created_at: "2026-11-20T09:00:00.000Z", item_title: "Add the page", item_stage: "RUNNING", error_code: null, model: null, cost_usd: null };

  it("a finished failed run: title, id, kind and status, started, finished, duration, error, model and cost", () => {
    const lines = runTipLines({ ...base, status: "failed", started_at: "2026-11-20T10:00:00.000Z", finished_at: "2026-11-20T11:30:00.000Z", error_code: "checks_failed", model: "opus", cost_usd: 0.5 }, now);
    expect(lines[0]).toBe("Add the page");
    expect(lines[1]).toBe("wi_1");
    expect(lines[2]).toBe("Implement, Failed");
    expect(lines.some((l) => l.startsWith("Started "))).toBe(true);
    expect(lines.some((l) => l.startsWith("Finished "))).toBe(true);
    expect(lines).toContain("Took 1h 30m");
    expect(lines.some((l) => l.startsWith("Error: "))).toBe(true);
    expect(lines).toContain("Model: opus");
    expect(lines).toContain("Cost: $0.50");
    expect(lines.some((l) => l.startsWith("Running for"))).toBe(false);
  });

  it("a running run says how long it has run, and leaves out what is unknown instead of showing 0", () => {
    const lines = runTipLines({ ...base, status: "running", started_at: "2026-11-20T11:00:00.000Z", finished_at: null, item_title: null }, now);
    expect(lines[0]).toBe("Untitled item");
    expect(lines).toContain("Running for 1h");
    for (const gone of ["Finished", "Took", "Error", "Model", "Cost"]) expect(lines.some((l) => l.startsWith(gone)), gone).toBe(false);
    expect(lines.join(" ")).not.toMatch(/\$0|\b0s\b/);
  });

  it("a withheld title shows its marker and the item id still shows", () => {
    const lines = runTipLines({ ...base, status: "succeeded", started_at: null, finished_at: "2026-11-20T11:00:00.000Z", item_title: "[withheld: github_token]" }, now);
    expect(lines.slice(0, 2)).toEqual(["[withheld: github_token]", "wi_1"]);
    expect(lines.some((l) => l.startsWith("Took"))).toBe(false);
  });

  it("a node: title, id, stage and blocked reason", () => {
    expect(nodeTipLines({ id: "wi_2", title: "Base work", stage: "READY", blocked_reason: "spec_pending" })).toEqual(["Base work", "wi_2", "Stage: planned, not started", "Blocked: spec pending"]);
    expect(nodeTipLines({ id: "wi_3", title: null, stage: "CLOSED", blocked_reason: null })).toEqual(["Untitled item", "wi_3", "Stage: closed"]);
  });
});

const PAGE_AT = "2026-11-20T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(PAGE_AT) - h * 3_600_000).toISOString();
const run = (id: string, item: string, title: string, extra: object) => ({
  id, kind: "implement", work_item_id: item, attempt: 1, owner: null, heartbeat_at: null, lease_expires_at: null, created_at: at(5),
  started_at: at(2), finished_at: at(1), status: "succeeded", item_title: title, item_stage: "RUNNING", error_code: null, model: null, cost_usd: null, ...extra,
});
const RUNS = {
  as_of: PAGE_AT, window: "6h",
  runs: [
    run("r_run", "wi_dep", "Needs base", { status: "running", started_at: at(1), finished_at: null }),
    run("r_fail", "wi_base", "Base work", { kind: "review", status: "failed", error_code: "checks_failed", model: "opus", cost_usd: 1.25 }),
    run("r_nostart", "wi_base", "Base work", { status: "failed", started_at: null }),
    run("r_q", "wi_dep", "Needs base", { status: "queued", started_at: null, finished_at: null }),
  ],
};
const GRAPH = {
  as_of: PAGE_AT,
  nodes: [
    { id: "wi_base", title: "Base work", stage: "RUNNING", blocked_reason: null },
    { id: "wi_dep", title: "Needs base", stage: "READY", blocked_reason: "dependency_pending" },
    { id: "wi_alone", title: "On its own", stage: "NEW", blocked_reason: null },
  ],
  edges: [{ from: "wi_base", to: "wi_dep", kind: "dependency" }],
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": { as_of: PAGE_AT, stages: {}, needs_you: 0, running: 1, queued: 1, last_24h: { succeeded: 0, failed: 1, tokens: 0 }, system_actions: [] },
  "/api/v1/health": { checked_at: PAGE_AT, checks: [] },
  "/api/v1/runs": RUNS,
  "/api/v1/items/graph": GRAPH,
};

let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

async function mountWorkers() {
  history.replaceState(null, "", "/app/health?tab=runs");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findByRole("heading", { level: 1, name: "Health" });
  await screen.findByRole("list", { name: "Runs over time, one row per lane" });
  await screen.findByRole("list", { name: "Dependency graph, prerequisites on the left" });
}

const bar = (id: string) => document.querySelector(`[data-run="${id}"]`) as HTMLElement;
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement;

describe("the Workers cards in Health's Runs tab", () => {
  it("has window segments 1h, 6h and 24h with 6h checked, and a switch reads the other window", async () => {
    await mountWorkers();
    const group = screen.getByRole("radiogroup", { name: "Time window" });
    const buttons = within(group).getAllByRole("radio");
    expect(buttons.map((b) => b.textContent)).toEqual(["1h", "6h", "24h"]);
    expect(within(group).getByRole("radio", { name: "6h" }).getAttribute("aria-checked")).toBe("true");
    expect(fetched).toContain("/api/v1/runs?window=6h");
    expect(fetched).toContain("/api/v1/items/graph?window=6h");
    fireEvent.click(within(group).getByRole("radio", { name: "1h" }));
    await vi.waitFor(() => expect(fetched).toContain("/api/v1/runs?window=1h"));
    expect(fetched).toContain("/api/v1/items/graph?window=1h");
    expect(within(group).getByRole("radio", { name: "1h" }).getAttribute("aria-checked")).toBe("true");
  });

  it("reads again every 10 seconds while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountWorkers();
    const count = () => fetched.filter((u) => u === "/api/v1/runs?window=6h").length;
    const before = count();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before));
  });

  it("draws a bar per started run coloured by kind and styled by status, and says how many runs it left out", async () => {
    await mountWorkers();
    // The drawn bar is the link's sibling; the link is its 24px hit area.
    const drawn = (id: string) => bar(id).parentElement!.querySelector("[data-bar]")!;
    expect(drawn("r_run").className).toContain("bg-kind-implement");
    expect(drawn("r_run").className).toContain("animate-pulse");
    expect(drawn("r_fail").className).toContain("bg-kind-review");
    expect(drawn("r_fail").className).toContain("border-failed");
    expect(bar("r_run").className).toContain("min-h-6");
    expect(bar("r_run").className).toContain("min-w-6");
    expect(bar("r_nostart")).toBeNull();
    expect(bar("r_q")).toBeNull();
    expect(document.querySelector("[data-left-out]")!.textContent).toBe("Left out (no start time): 1");
    expect(document.querySelector("[data-now]")).toBeTruthy();
    const legend = screen.getByRole("list", { name: "Legend" });
    for (const k of ["Triage", "Implement", "Review", "Resolve", "Merge check", "Other"]) expect(within(legend).getByText(k)).toBeTruthy();
  });

  it("the timeline scrolls inside its card instead of widening the page", async () => {
    await mountWorkers();
    const plot = screen.getByRole("list", { name: "Runs over time, one row per lane" });
    expect(plot.closest(".overflow-x-auto")).toBeTruthy();
    expect(plot.closest("section")!.contains(plot.closest(".overflow-x-auto"))).toBe(true);
  });

  it("hovering or focusing a bar opens its tooltip; a click opens the item", async () => {
    await mountWorkers();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(bar("r_fail").parentElement!);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Base work");
    expect(tip.textContent).toContain("wi_base");
    expect(tip.textContent).toContain("Model: opus");
    expect(tip.textContent).toContain("Cost: $1.25");
    fireEvent.mouseLeave(bar("r_fail").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(bar("r_run"));
    expect(screen.getByRole("tooltip").textContent).toContain("Running for");
    fireEvent.blur(bar("r_run"));
    fireEvent.click(bar("r_run"));
    await vi.waitFor(() => expect(location.pathname).toBe("/app/items/wi_dep"));
  });

  it("draws only items with an edge, counts the rest, and a node's hover lights its edges and its runs", async () => {
    await mountWorkers();
    expect(node("wi_base")).toBeTruthy();
    expect(node("wi_dep")).toBeTruthy();
    expect(node("wi_alone")).toBeNull();
    expect(document.querySelector("[data-alone]")!.textContent).toBe("1 items with no dependencies");
    const edge = document.querySelector('[data-edge="wi_base>wi_dep"]')!;
    expect(edge.getAttribute("data-highlight")).toBeNull();
    fireEvent.mouseEnter(node("wi_dep"));
    fireEvent.mouseEnter(node("wi_dep").parentElement!);
    expect(edge.getAttribute("data-highlight")).toBe("true");
    expect(bar("r_run").getAttribute("data-highlight")).toBe("true");
    expect(bar("r_fail").getAttribute("data-highlight")).toBeNull();
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Needs base");
    expect(tip.textContent).toContain("wi_dep");
    expect(tip.textContent).toContain("Stage: planned, not started");
    expect(tip.textContent).toContain("Blocked: dependency pending");
    fireEvent.mouseLeave(node("wi_dep"));
    expect(edge.getAttribute("data-highlight")).toBeNull();
  });

  it("keyboard focus on a node opens its tooltip and lights its runs; a click opens the item", async () => {
    await mountWorkers();
    fireEvent.focus(node("wi_base"));
    expect(screen.getByRole("tooltip").textContent).toContain("Base work");
    expect(bar("r_fail").getAttribute("data-highlight")).toBe("true");
    fireEvent.blur(node("wi_base"));
    expect(bar("r_fail").getAttribute("data-highlight")).toBeNull();
    fireEvent.click(node("wi_base"));
    await vi.waitFor(() => expect(location.pathname).toBe("/app/items/wi_base"));
  });

  it("sits after Runners and before Failures and Host sleeps, and its two cards have only the window switch to press", async () => {
    await mountWorkers();
    const sections = [...document.querySelectorAll("[data-health-section]")].map((e) => e.getAttribute("data-health-section"));
    expect(sections.slice(0, 1)).toEqual(["runners"]);
    expect(sections.slice(1, 3)).toEqual(["timeline", "graph"]);
    expect(sections.indexOf("failures")).toBeGreaterThan(2);
    for (const name of ["timeline", "graph"]) {
      const card = document.querySelector(`[data-health-section=${name}]`)!;
      const group = within(card as HTMLElement).queryByRole("radiogroup", { name: "Time window" });
      for (const b of card.querySelectorAll("button")) expect(group?.contains(b)).toBe(true);
      expect(card.querySelector("input, select, textarea, form")).toBeNull();
    }
  });

  it("renders in dark too", async () => {
    document.documentElement.classList.add("dark");
    await mountWorkers();
    expect(bar("r_fail")).toBeTruthy();
    expect(node("wi_dep")).toBeTruthy();
  });
});
