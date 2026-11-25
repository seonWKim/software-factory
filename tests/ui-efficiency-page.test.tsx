// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EfficiencyFigure, EfficiencyTierMerges, EfficiencyView, EfficiencyWeek } from "../web/src/api/efficiency.js";

// Health's Efficiency tab (design 06-efficiency): one Card with the finished-item charts and their totals, the picked
// week's figures with the change from the week before ("−18%", "so far" for the running week), "no data" for a week
// with none, the left-out and not-counted numbers, the week's slowest and costliest items linking to their pages, and
// the per-tier merge record with the rule's result (an empty state with no merge).

const PAGE_MODULE = "../web/src/views/pages.js";
const { HealthPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { HealthPage: FunctionComponent };

const SLOW = { timeout: 5_000 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HOUR = 3_600_000;

const fig = (over: Partial<EfficiencyFigure> = {}): EfficiencyFigure => ({ median: null, p90: null, median_change: null, p90_change: null, not_counted: 0, ...over });
const week = (start: string, over: Partial<EfficiencyWeek> = {}): EfficiencyWeek => ({
  start, current: false, finished: 0, finished_change: null, tokens: fig(), total: fig(), agent: fig(), waiting: fig(), slowest: [], costliest: [], ...over,
});
const item = (id: string, title: string, total_ms: number, cost_usd: number) => ({
  work_item_id: id, title, merged_at: "2026-11-19T00:00:00.000Z", total_ms, agent_ms: HOUR, waiting_ms: total_ms - HOUR, tokens: 1000, cost_usd, runs_without_usage: 0,
});
const bars = (n: number, step: number, counts: Record<number, number> = {}) => Array.from({ length: n }, (_, i) => ({ start: new Date(Date.parse("2026-09-28T00:00:00.000Z") + i * step).toISOString(), count: counts[i] ?? 0 }));

const tierRow = (tier: number | null, over: Partial<EfficiencyTierMerges> = {}): EfficiencyTierMerges => ({
  tier, merged: 0, reverted_or_fixed: 0, not_accept: 0, sample: 0, sample_bad: 0, sample_critical: 0, rule: "too_few", qualifies: false, ...over,
});
const tierRows: EfficiencyTierMerges[] = [
  tierRow(1, { merged: 12, reverted_or_fixed: 1, not_accept: 2, sample: 50, sample_bad: 1, rule: "met", qualifies: true }),
  tierRow(2, { merged: 7, reverted_or_fixed: 2, sample: 50, sample_bad: 2, sample_critical: 1, rule: "not_met" }),
  tierRow(3, { merged: 3, sample: 30 }),
  tierRow(4, { rule: "never" }),
  tierRow(5, { rule: "never" }),
  tierRow(null),
];
let merges: EfficiencyTierMerges[] = tierRows;

const weeks = bars(8, 7 * 24 * HOUR, { 6: 2, 7: 1 });
const view: EfficiencyView = {
  as_of: "2026-11-20T12:30:00.000Z",
  hours: { bars: bars(24, HOUR, { 23: 1 }), total: 1 },
  days: { bars: bars(14, 24 * HOUR, { 13: 1 }), total: 1 },
  weeks: { bars: weeks, total: 3 },
  week_figures: [
    ...weeks.slice(0, 6).map((b) => week(b.start.slice(0, 10))),
    week(weeks[6]!.start.slice(0, 10), { finished: 2, tokens: fig({ median: 1000, p90: 1000 }), slowest: [item("wi_old", "Older task", 10 * HOUR, 1)], costliest: [item("wi_old", "Older task", 10 * HOUR, 1)] }),
    week(weeks[7]!.start.slice(0, 10), {
      current: true, finished: 1, finished_change: -50,
      tokens: fig({ median: 820, p90: 820, median_change: -18, p90_change: 5, not_counted: 2 }),
      total: fig({ median: 8 * HOUR, p90: 8 * HOUR, median_change: -18 }),
      agent: fig({ median: 2 * HOUR, p90: 2 * HOUR, not_counted: 1 }),
      waiting: fig({ median: 6 * HOUR, p90: 6 * HOUR }),
      slowest: [item("wi_new", "Newest task", 8 * HOUR, 3)],
      costliest: [item("wi_new", "Newest task", 8 * HOUR, 3)],
    }),
  ],
  left_out: { total: 3, cancelled: 1, rejected: 1, failed: 1 },
  runs_without_usage: 2,
  merges: tierRows,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/efficiency") return json(200, { ...view, merges });
    if (url === "/api/v1/health") return json(200, { checked_at: view.as_of, checks: [] });
    if (url === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
    if (url.startsWith("/api/v1/overview")) return json(200, { as_of: view.as_of, stages: {}, needs_you: 0, open: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  merges = tierRows;
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  history.replaceState(null, "", "/app/health?tab=efficiency");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(HealthPage)));
  const card = await screen.findByRole("region", { name: "Efficiency" }, SLOW);
  await within(card).findByText("Finished items", undefined, SLOW);
  return card;
}

describe("Health page: Efficiency tab", () => {
  it("?tab=efficiency opens the Cost tab at it and shows the charts' totals and the latest week's figures with their change", async () => {
    const card = await show();
    expect(screen.getByRole("tab", { name: "Cost" }).getAttribute("aria-selected")).toBe("true");
    expect(card.querySelectorAll("[data-chart]")).toHaveLength(3);
    expect(card.textContent).toContain("3 finished");
    expect(card.textContent).toContain("Week of 2026-11-16, so far");
    expect(card.querySelector("[data-finished]")!.textContent).toBe("1 finished−50% so far");
    expect(card.textContent).toContain("−18% so far");
    expect(card.textContent).toContain("+5% so far");
    expect(card.textContent).toContain("2 items not counted for tokens");
    expect(card.textContent).toContain("1 items not counted for time");
    expect(card.querySelector("[data-left-out]")!.textContent).toContain("3 items closed without finishing: 1 cancelled, 1 rejected, 1 failed");
    expect(card.textContent).toContain("2 runs have no stored token count");
    expect(within(card).getAllByRole("link", { name: "Newest task" })[0]!.getAttribute("href")).toContain("wi_new");
    // No item IDs in the visible text.
    expect(card.textContent).not.toContain("wi_");
  });

  it("a click on a week's bar picks that week; a week with no figures shows no data, never 0", async () => {
    const card = await show();
    const weekly = within(card).getByRole("list", { name: "Last 8 weeks" });
    const buttons = within(weekly).getAllByRole("button");
    fireEvent.click(buttons[6]!);
    expect(buttons[6]!.getAttribute("aria-pressed")).toBe("true");
    expect(card.textContent).toContain("Week of 2026-11-09");
    expect(card.textContent).not.toContain("so far");
    expect(within(card).getAllByRole("link", { name: "Older task" }).length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(card.textContent).toContain("Week of 2026-09-28");
    expect(card.textContent).toContain("no data");
    expect(card.textContent).toContain("No item finished this week.");
    expect(location.search).toBe("?tab=efficiency");
  });

  it("shows the per-tier merge record and whether each tier meets the rule, in a table under Merges by risk level", async () => {
    const card = await show();
    const table = await within(card).findByRole("table", { name: "Merges by risk level" }, SLOW);
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["Risk level 1", "12", "1", "2", "Met"],
      ["Risk level 2", "7", "2", "0", "Not met: 2 reverted or fixed forward, 1 critical"],
      ["Risk level 3", "3", "0", "0", "Too few merges: 30 of 50"],
      ["Risk level 4", "0", "0", "0", "Never"],
      ["Risk level 5", "0", "0", "0", "Never"],
      ["No risk level", "0", "0", "0", "Too few merges: 0 of 50"],
    ]);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Risk level", "Merges, 30 days", "Reverted or fixed forward", "Your verdicts other than accept", "Rule"]);
  });

  it("with no merge recorded, Merges by risk level shows an empty state instead of the table", async () => {
    merges = tierRows.map((r) => tierRow(r.tier, { rule: r.rule === "never" ? "never" : "too_few" }));
    const card = await show();
    expect(await within(card).findByText("No merge is recorded yet.", undefined, SLOW)).toBeTruthy();
    expect(within(card).queryByRole("table", { name: "Merges by risk level" })).toBeNull();
  });
});
