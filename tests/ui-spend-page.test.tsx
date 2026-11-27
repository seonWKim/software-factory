// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingRow, SettingsView, SpendDay, SpendView } from "../web/src/api.js";
import { keyLabel } from "../web/src/lib/key-label.js";

// tsconfig.test.json checks this file without JSX, so the pages are built with createElement and their .tsx modules
// are loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const SPEND_MODULE = "../web/src/views/spend.js";
const SETTINGS_MODULE = "../web/src/views/settings.js";
const { SpendSection } = (await import(/* @vite-ignore */ SPEND_MODULE)) as { SpendSection: FunctionComponent };
const { SettingsPage } = (await import(/* @vite-ignore */ SETTINGS_MODULE)) as { SettingsPage: FunctionComponent };

// The Spend page (design 06-spend): today, this week and the last 30 days (cost and tokens), one daily bar chart,
// the tasks by cost with run count, kinds and a link to each, and the count of runs with no stored cost. And the
// Settings page's number field, which takes a decimal dollar budget such as 12.50.

const day = (d: string, cost_usd: number, tokens = 0, runs = 0, unknown = 0, top: SpendDay["top"] = []): SpendDay => ({ day: d, cost_usd, tokens, runs, unknown, top });
// 30 days ending Wednesday 2026-01-14; its week began Monday 2026-01-12.
const DAYS = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2025, 11, 16 + i)).toISOString().slice(0, 10), 0));
DAYS[27] = day("2026-01-12", 4, 4000, 2); // Monday
DAYS[29] = day("2026-01-14", 1.5, 2500, 3, 1); // today
DAYS[0] = day("2025-12-16", 10, 9000, 1);
const SPEND: SpendView = {
  as_of: "2026-01-14T12:00:00.000Z",
  today: "2026-01-14",
  week_start: "2026-01-12",
  budgets: { daily_usd: 20, weekly_usd: null },
  from: "2025-12-16",
  to: "2026-01-14",
  total: { cost_usd: 15.5, tokens: 15500, runs: 6, unknown: 1 },
  chat: { cost_usd: 2.25, tokens: 1200, turns: 7, unknown: 0 },
  coordinator: { cost_usd: 0.5, tokens: 300, turns: 1, unknown: 0 },
  days: DAYS,
  items: [
    { work_item_id: "wi_big", title: "Big task", cost_usd: 10, tokens: 9000, runs: 1, unknown: 0, kinds: ["implement"] },
    { work_item_id: "wi_mid", title: "Middle task", cost_usd: 4, tokens: 4000, runs: 2, unknown: 0, kinds: ["triage", "review"] },
    { work_item_id: "wi_small", title: null, cost_usd: 1.5, tokens: 2500, runs: 3, unknown: 1, kinds: ["implement"] },
  ],
  items_total: 3,
};

const budget = (key: string): SettingRow => ({
  key, description: "Dollars per UTC day.", kind: "number", value: "null", source: "default", file_value: null, default_value: "null",
  applies_at: "the next alarm step (each poll)", project_settable: false, projects: [],
});
const SETTINGS: SettingsView = {
  as_of: "2026-01-14T12:00:00.000Z", csrf_token: "tok", repo: "o/r", project: null, project_keys: [],
  keys: [budget("spend.daily_budget_usd"), budget("spend.weekly_budget_usd")], pr_only: [], ignored: [], history: [],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let posts: { url: string; body: Record<string, unknown> }[];
/** What GET /api/v1/spend answers, and the answers of its one-day reads by day. */
let view: SpendView;
let dayViews: Record<string, SpendView>;
let gets: string[];

beforeEach(() => {
  posts = [];
  view = SPEND;
  dayViews = {};
  gets = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json(200, { ok: true, lines: ["spend.daily_budget_usd = 12.5"] });
    }
    gets.push(url);
    if (url === "/api/v1/spend") return json(200, view);
    const one = /^\/api\/v1\/spend\?from=(\d{4}-\d{2}-\d{2})&to=\1$/.exec(url);
    if (one && dayViews[one[1]!]) return json(200, dayViews[one[1]!]);
    if (url === "/api/v1/settings") return json(200, SETTINGS);
    if (url === "/api/v1/session") return json(200, { as_of: "x", csrf_token: "tok", commands_enabled: false, actor: null, actor_source: null });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function show(page: FunctionComponent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(page)));
}

describe("Spend page", () => {
  it("shows today, this week and the last 30 days, each with cost and tokens", async () => {
    show(SpendSection);
    const today = await screen.findByText("Today");
    const totals = (label: string) => document.querySelector<HTMLElement>(`[data-total="${label}"]`)!.textContent;
    expect(today).toBeTruthy();
    expect(totals("Today")).toContain("$1.50");
    expect(totals("Today")).toContain("2.5k tokens");
    expect(totals("This week")).toContain("$5.50");
    expect(totals("This week")).toContain("6.5k tokens");
    expect(totals("Last 30 days")).toContain("$15.50");
    expect(totals("Last 30 days")).toContain("15.5k tokens");
  });

  it("shows chat and coordinator spend in their own tiles, apart from the run totals", async () => {
    view = { ...SPEND, coordinator: { cost_usd: 0.5, tokens: 300, turns: 1, unknown: 0 } };
    show(SpendSection);
    await screen.findByText("Today");
    const totals = (label: string) => document.querySelector<HTMLElement>(`[data-total="${label}"]`)!.textContent;
    expect(totals("Chat")).toContain("$2.25");
    expect(totals("Chat")).toContain("1.2k tokens");
    expect(totals("Chat")).toContain("7 turns");
    expect(totals("Coordinator")).toContain("$0.50");
    expect(totals("Coordinator")).toContain("1 turn");
    expect(totals("Coordinator")).not.toContain("1 turns");
    expect(totals("Last 30 days")).toContain("$15.50");
    expect(totals("Today")).toContain("$1.50");
    expect(screen.queryByTestId("spend-unknown-chat")).toBeNull();
    expect(screen.queryByTestId("spend-unknown-coordinator")).toBeNull();
  });

  it("names how many chat turns and coordinator cycles had no cost, never as $0", async () => {
    view = { ...SPEND, chat: { cost_usd: 0, tokens: 0, turns: 3, unknown: 3 }, coordinator: { cost_usd: 1, tokens: 10, turns: 2, unknown: 1 } };
    show(SpendSection);
    await screen.findByText("Today");
    expect(screen.getByTestId("spend-unknown-chat").textContent).toBe("3 chat turns reported no cost; they are counted apart, never as $0.");
    expect(screen.getByTestId("spend-unknown-coordinator").textContent).toBe("1 coordinator cycle reported no cost; it is counted apart, never as $0.");
    expect(screen.getByTestId("spend-unknown").textContent).toContain("1 run reported no cost");
  });

  it("shows each period's budget against its spent amount, 'No budget set.' when none, and the alert-only note", async () => {
    view = { ...SPEND, budgets: { daily_usd: 20, weekly_usd: null } };
    show(SpendSection);
    await screen.findByText("Today");
    const totals = (label: string) => document.querySelector<HTMLElement>(`[data-total="${label}"]`)!.textContent;
    expect(totals("Today")).toContain("$1.50 of $20 today");
    expect(totals("This week")).toContain("No budget set.");
    expect(totals("Last 30 days")).not.toContain("budget");
    const note = screen.getByTestId("spend-budget-note");
    expect(note.textContent).toContain("At 80% and 100% of a budget an alert appears in Needs you. No work stops.");
    expect(within(note).getByRole("link", { name: "Change in Settings" }).getAttribute("href")).toBe("/app/settings");
    expect(document.body.textContent).not.toMatch(/spend\.(daily|weekly)_budget_usd/);
  });

  it("a weekly budget shows 'this week' and keeps the cents of $12.50", async () => {
    view = { ...SPEND, budgets: { daily_usd: null, weekly_usd: 12.5 } };
    show(SpendSection);
    await screen.findByText("Today");
    expect(document.querySelector<HTMLElement>('[data-total="This week"]')!.textContent).toContain("$5.50 of $12.50 this week");
    expect(document.querySelector<HTMLElement>('[data-total="Today"]')!.textContent).toContain("No budget set.");
  });

  it("draws one bar per day, the highest day full height, each named with its day and cost", async () => {
    show(SpendSection);
    const chart = await screen.findByRole("list", { name: "Cost per UTC day, last 30 days" });
    const bars = chart.querySelectorAll("li");
    expect(bars).toHaveLength(SPEND.days.length);
    expect(bars[0]!.textContent).toBe("2025-12-16: $10.00");
    expect(bars[0]!.querySelector<HTMLElement>("[aria-hidden]")!.style.height).toBe("100%");
    expect(bars[29]!.querySelector<HTMLElement>("[aria-hidden]")!.style.height).toBe("15%");
    expect(bars[1]!.querySelector<HTMLElement>("[aria-hidden]")!.style.height).toBe("0%");
    // Token colour only, no hex.
    expect(bars[0]!.querySelector<HTMLElement>("[aria-hidden]")!.className).toContain("bg-accent");
  });

  it("lists the tasks by cost with run count and kinds, each linking to its item", async () => {
    show(SpendSection);
    const table = await screen.findByRole("table", { name: "Tasks by cost" });
    const rows = [...table.querySelectorAll("tbody > tr")];
    expect(rows.map((r) => r.querySelector("a")!.textContent)).toEqual(["Big task", "Middle task", "wi_small"]);
    expect(rows.map((r) => r.querySelector("a")!.getAttribute("href"))).toEqual(["/app/items/wi_big", "/app/items/wi_mid", "/app/items/wi_small"]);
    expect(rows[1]!.textContent).toContain("$4.00");
    expect(rows[1]!.textContent).toContain("triage, review");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Item", "Cost", "Tokens", "Runs", "Kinds", "No cost"]);
  });

  it("says how many runs had no stored cost, apart from the totals", async () => {
    show(SpendSection);
    expect((await screen.findByTestId("spend-unknown")).textContent).toBe("1 run reported no cost; it is counted apart, never as $0.");
  });
});

// The owner's example: 30 days ending 2026-11-15, the most on 2026-11-07 ($568.79).
const NOV = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2026, 9, 17 + i)).toISOString().slice(0, 10), 0));
const NOV7 = NOV.findIndex((d) => d.day === "2026-11-07");
NOV[NOV7] = day("2026-11-07", 568.79, 1_200_000, 14, 1, [
  { work_item_id: "wi_a", title: "Spend chart hover details", cost_usd: 300 },
  { work_item_id: "wi_b", title: "Desktop app", cost_usd: 200 },
  { work_item_id: "wi_c", title: null, cost_usd: 60 },
]);
NOV[NOV7 + 1] = day("2026-11-08", 20, 30_000, 2, 0, [{ work_item_id: "wi_a", title: "Spend chart hover details", cost_usd: 20 }]);
const NOV_ITEMS: SpendView["items"] = [
  { work_item_id: "wi_a", title: "Spend chart hover details", cost_usd: 320, tokens: 600_000, runs: 6, unknown: 0, kinds: ["implement"] },
  { work_item_id: "wi_b", title: "Desktop app", cost_usd: 200, tokens: 400_000, runs: 4, unknown: 0, kinds: ["implement"] },
  { work_item_id: "wi_c", title: null, cost_usd: 60, tokens: 200_000, runs: 3, unknown: 0, kinds: ["review"] },
  { work_item_id: "wi_d", title: "Other day only", cost_usd: 8.79, tokens: 30_000, runs: 3, unknown: 1, kinds: ["triage"] },
];
const NOV_VIEW: SpendView = {
  as_of: "2026-11-15T12:00:00.000Z", today: "2026-11-15", week_start: "2026-11-09", budgets: { daily_usd: null, weekly_usd: null }, from: "2026-10-17", to: "2026-11-15",
  total: { cost_usd: 588.79, tokens: 1_230_000, runs: 16, unknown: 1 }, chat: { cost_usd: 0, tokens: 0, turns: 0, unknown: 0 }, coordinator: { cost_usd: 0, tokens: 0, turns: 0, unknown: 0 }, days: NOV, items: NOV_ITEMS, items_total: 4,
};
const NOV7_VIEW: SpendView = {
  ...NOV_VIEW, from: "2026-11-07", to: "2026-11-07", total: { cost_usd: 568.79, tokens: 1_200_000, runs: 14, unknown: 1 },
  days: [NOV[NOV7]!], items: NOV_ITEMS.slice(0, 3), items_total: 3,
};

describe("Spend page: its note (design 09-health, 2026-11-20)", () => {
  it("says what the costs are in one short sentence, with no code", async () => {
    show(SpendSection);
    const note = await screen.findByText("What the agent runs cost, by day (UTC).");
    expect(note.textContent).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });
});

describe("Spend page: the daily chart", () => {
  beforeEach(() => {
    view = NOV_VIEW;
    dayViews = { "2026-11-07": NOV7_VIEW };
  });
  const chart = () => screen.findByRole("list", { name: "Cost per UTC day, last 30 days" });
  const bar = async (d: string) => within((await chart()).querySelector<HTMLElement>(`[data-day="${d}"]`)!).getByRole("button");
  const taskLinks = () => [...screen.getByRole("table", { name: "Tasks by cost" }).querySelectorAll("tbody a")].map((a) => a.textContent);

  it("hovering the 2026-11-07 bar shows that day's cost, runs, tokens and top items, each linking to its item", async () => {
    show(SpendSection);
    fireEvent.mouseEnter(await bar("2026-11-07"));
    const tip = screen.getByRole("tooltip");
    expect(tip.className).toContain("top-0"); // beside the bar, so the chart's scroller does not clip it
    expect(tip.className).toMatch(/\b(left|right)-full\b/);
    expect(tip.textContent).toContain("2026-11-07");
    expect(tip.textContent).toContain("$568.79");
    expect(tip.textContent).toContain("14 runs");
    expect(tip.textContent).toContain("1.2M tokens");
    const links = within(tip).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Spend chart hover details", "Desktop app", "wi_c"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/app/items/wi_a", "/app/items/wi_b", "/app/items/wi_c"]);
    // It stays open while the pointer is on it, so its links can be clicked.
    fireEvent.mouseLeave(await bar("2026-11-07"), { relatedTarget: tip });
    fireEvent.mouseEnter(tip);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("keyboard focus on a bar shows the same tooltip, and focus can move to its links", async () => {
    show(SpendSection);
    const b = await bar("2026-11-07");
    fireEvent.focus(b);
    const link = within(screen.getByRole("tooltip")).getByRole("link", { name: "Desktop app" });
    fireEvent.blur(b, { relatedTarget: link });
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("the x-axis shows only the first and last dates; the y-axis shows cost labels with gridlines, the top one the most cost", async () => {
    show(SpendSection);
    await chart();
    const x = document.querySelector<HTMLElement>('[data-axis="x"]')!;
    expect([...x.children].map((c) => c.textContent)).toEqual(["2026-10-17", "2026-11-15"]);
    expect(x.textContent).not.toContain("$");
    const y = [...document.querySelectorAll<HTMLElement>('[data-axis="y"] [data-tick]')];
    expect(y.length).toBeGreaterThanOrEqual(2);
    expect(y.length).toBeLessThanOrEqual(3);
    expect(y[0]!.textContent).toBe("$568.79");
    for (const tick of y) expect(document.querySelector(`[data-gridline="${tick.dataset.tick}"]`)).toBeTruthy();
    // Bars and gridlines take token colours only.
    expect(document.querySelector<HTMLElement>("[data-gridline]")!.className).toContain("border-border");
  });

  it("clicking a bar filters the tasks to that day by a one-day read, totals and chart unchanged; clicking it again shows all", async () => {
    show(SpendSection);
    await screen.findByRole("table", { name: "Tasks by cost" });
    expect(taskLinks()).toContain("Other day only");
    const b = await bar("2026-11-07");
    fireEvent.click(b);
    await waitFor(() => expect(taskLinks()).toEqual(["Spend chart hover details", "Desktop app", "wi_c"]));
    expect(gets).toContain("/api/v1/spend?from=2026-11-07&to=2026-11-07");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLElement>('[data-total="Last 30 days"]')!.textContent).toContain("$588.79");
    expect((await chart()).querySelectorAll("li")).toHaveLength(30);
    fireEvent.click(b);
    await waitFor(() => expect(taskLinks()).toContain("Other day only"));
    expect(b.getAttribute("aria-pressed")).toBe("false");
  });

  it("a clear control shows all days in the table again", async () => {
    show(SpendSection);
    fireEvent.click(await bar("2026-11-07"));
    await waitFor(() => expect(taskLinks()).not.toContain("Other day only"));
    fireEvent.click(screen.getByRole("button", { name: "Show all days" }));
    await waitFor(() => expect(taskLinks()).toContain("Other day only"));
  });
});

describe("Settings page: dollar budgets", () => {
  it("Advanced links the Data page, which the sidebar does not show, and no longer Runners (a Health tab)", async () => {
    history.replaceState(null, "", "/app/settings?tab=advanced");
    show(SettingsPage);
    expect((await screen.findByRole("link", { name: "Data" })).getAttribute("href")).toBe("/app/data");
    expect(screen.queryByRole("link", { name: "Runners" })).toBeNull();
    expect(document.querySelector('a[href="/app/runners"]')).toBeNull();
  });

  it("an unset budget shows an empty number field that takes a fraction such as 12.50, and saves it", async () => {
    history.replaceState(null, "", "/app/settings?tab=advanced");
    show(SettingsPage);
    const field = (await screen.findByLabelText(`${keyLabel("spend.daily_budget_usd")}`)) as HTMLInputElement;
    expect(field.type).toBe("number");
    expect(field.step).toBe("any");
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "12.50" } });
    expect(field.validity.valid).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `Save ${keyLabel("spend.daily_budget_usd")}` }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ action: "set", key: "spend.daily_budget_usd", value: "12.50" });
  });
});
