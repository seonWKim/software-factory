// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
// The Workers page (design 09-dashboard-workers) in the app at /app/workers: the 1h/6h/24h window switch (6h first),
// the 10-second refresh, bars and nodes with the shared Tooltip on hover and keyboard focus, a node's hover
// lighting its edges and its runs, a click opening the item, the left-out and no-dependency counts, and no control
// that edits anything.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

const AT = "2026-11-20T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(AT) - h * 3_600_000).toISOString();
const run = (id: string, item: string, title: string, extra: object) => ({
  id, kind: "implement", work_item_id: item, attempt: 1, owner: null, heartbeat_at: null, lease_expires_at: null, created_at: at(5),
  started_at: at(2), finished_at: at(1), status: "succeeded", item_title: title, item_stage: "RUNNING", error_code: null, model: null, cost_usd: null, ...extra,
});
const RUNS = {
  as_of: AT, window: "6h",
  runs: [
    run("r_run", "wi_dep", "Needs base", { status: "running", started_at: at(1), finished_at: null }),
    run("r_fail", "wi_base", "Base work", { kind: "review", status: "failed", error_code: "checks_failed", model: "opus", cost_usd: 1.25 }),
    run("r_nostart", "wi_base", "Base work", { status: "failed", started_at: null }),
    run("r_q", "wi_dep", "Needs base", { status: "queued", started_at: null, finished_at: null }),
  ],
};
const GRAPH = {
  as_of: AT,
  nodes: [
    { id: "wi_base", title: "Base work", stage: "RUNNING", blocked_reason: null },
    { id: "wi_dep", title: "Needs base", stage: "READY", blocked_reason: "dependency_pending" },
    { id: "wi_alone", title: "On its own", stage: "NEW", blocked_reason: null },
  ],
  edges: [{ from: "wi_base", to: "wi_dep", kind: "dependency" }],
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 1, queued: 1, last_24h: { succeeded: 0, failed: 1, tokens: 0 }, system_actions: [] },
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
  history.replaceState(null, "", "/app/workers");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findByRole("heading", { level: 1, name: "Workers" });
  await screen.findByRole("list", { name: "Runs over time, one row per lane" });
  await screen.findByRole("list", { name: "Dependency graph, prerequisites on the left" });
}

const bar = (id: string) => document.querySelector(`[data-run="${id}"]`) as HTMLElement;
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement;

describe("the Workers page", () => {
  it("opens at /app/workers, in the sidebar's System block after Health, and stays there", async () => {
    await mountWorkers();
    const system = screen.getByRole("navigation", { name: "System" });
    const hrefs = [...system.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.indexOf("/app/workers")).toBe(hrefs.indexOf("/app/health") + 1);
    expect(within(system).getByRole("link", { name: "Workers" })).toBeTruthy();
    expect(location.pathname).toBe("/app/workers");
  });

  it("has window buttons 1h, 6h and 24h with 6h pressed, and a switch reads the other window", async () => {
    await mountWorkers();
    const group = screen.getByRole("group", { name: "Time window" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["1h", "6h", "24h"]);
    expect(within(group).getByRole("button", { name: "6h" }).getAttribute("aria-pressed")).toBe("true");
    expect(fetched).toContain("/api/v1/runs?window=6h");
    expect(fetched).toContain("/api/v1/items/graph?window=6h");
    fireEvent.click(within(group).getByRole("button", { name: "1h" }));
    await vi.waitFor(() => expect(fetched).toContain("/api/v1/runs?window=1h"));
    expect(fetched).toContain("/api/v1/items/graph?window=1h");
    expect(within(group).getByRole("button", { name: "1h" }).getAttribute("aria-pressed")).toBe("true");
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
    expect(bar("r_run").className).toContain("bg-kind-implement");
    expect(bar("r_run").className).toContain("animate-pulse");
    expect(bar("r_fail").className).toContain("bg-kind-review");
    expect(bar("r_fail").className).toContain("border-failed");
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
    expect(tip.textContent).toContain("Stage: specced, not started");
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

  it("has no control that edits anything: its only buttons are the window switch", async () => {
    await mountWorkers();
    const main = document.querySelector("main")!;
    const group = within(main).getByRole("group", { name: "Time window" });
    for (const b of within(main).getAllByRole("button")) expect(group.contains(b)).toBe(true);
    expect(main.querySelector("input, select, textarea, form")).toBeNull();
  });

  it("renders in dark too", async () => {
    document.documentElement.classList.add("dark");
    await mountWorkers();
    expect(bar("r_fail")).toBeTruthy();
    expect(node("wi_dep")).toBeTruthy();
  });
});
