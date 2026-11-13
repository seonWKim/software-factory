// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingRow, SettingsView, SpendDay, SpendView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the pages are built with createElement and their .tsx modules
// are loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const SPEND_MODULE = "../web/src/views/spend.js";
const SETTINGS_MODULE = "../web/src/views/settings.js";
const { SpendPage } = (await import(/* @vite-ignore */ SPEND_MODULE)) as { SpendPage: FunctionComponent };
const { SettingsPage } = (await import(/* @vite-ignore */ SETTINGS_MODULE)) as { SettingsPage: FunctionComponent };

// The Spend page (design 06-spend): today, this week and the last 30 days (cost and tokens), one daily bar chart,
// the tasks by cost with run count, kinds and a link to each, and the count of runs with no stored cost. And the
// Settings page's number field, which takes a decimal dollar budget such as 12.50.

const day = (d: string, cost_usd: number, tokens = 0, runs = 0, unknown = 0): SpendDay => ({ day: d, cost_usd, tokens, runs, unknown });
// 30 days ending Wednesday 2026-01-14; its week began Monday 2026-01-12.
const DAYS = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2025, 11, 16 + i)).toISOString().slice(0, 10), 0));
DAYS[27] = day("2026-01-12", 4, 4000, 2); // Monday
DAYS[29] = day("2026-01-14", 1.5, 2500, 3, 1); // today
DAYS[0] = day("2025-12-16", 10, 9000, 1);
const SPEND: SpendView = {
  as_of: "2026-01-14T12:00:00.000Z",
  today: "2026-01-14",
  week_start: "2026-01-12",
  from: "2025-12-16",
  to: "2026-01-14",
  total: { cost_usd: 15.5, tokens: 15500, runs: 6, unknown: 1 },
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

beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json(200, { ok: true, lines: ["spend.daily_budget_usd = 12.5"] });
    }
    if (url === "/api/v1/spend") return json(200, SPEND);
    if (url === "/api/v1/settings") return json(200, SETTINGS);
    if (url === "/api/v1/session") return json(200, { as_of: "x", csrf_token: "tok", commands_enabled: false, actor: null, actor_source: null });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(page: FunctionComponent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(page)));
}

describe("Spend page", () => {
  it("is a sidebar page at /app/spend, right after Failures", () => {
    expect(routeFor("/app/spend").page.label).toBe("Spend");
    const paths = PAGES.map((p) => p.path);
    expect(paths.indexOf("spend")).toBe(paths.indexOf("failures") + 1);
  });

  it("shows today, this week and the last 30 days, each with cost and tokens", async () => {
    show(SpendPage);
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

  it("draws one bar per day, the highest day full height, each named with its day and cost", async () => {
    show(SpendPage);
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
    show(SpendPage);
    const table = await screen.findByRole("table", { name: "Tasks by cost" });
    const rows = [...table.querySelectorAll("tbody > tr")];
    expect(rows.map((r) => r.querySelector("a")!.textContent)).toEqual(["Big task", "Middle task", "wi_small"]);
    expect(rows.map((r) => r.querySelector("a")!.getAttribute("href"))).toEqual(["/app/items/wi_big", "/app/items/wi_mid", "/app/items/wi_small"]);
    expect(rows[1]!.textContent).toContain("$4.00");
    expect(rows[1]!.textContent).toContain("triage, review");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Item", "Cost", "Tokens", "Runs", "Kinds", "No cost"]);
  });

  it("says how many runs had no stored cost, apart from the totals", async () => {
    show(SpendPage);
    expect((await screen.findByTestId("spend-unknown")).textContent).toBe("1 run reported no cost; it is counted apart, never as $0.");
  });
});

describe("Settings page: dollar budgets", () => {
  it("an unset budget shows an empty number field that takes a fraction such as 12.50, and saves it", async () => {
    show(SettingsPage);
    const field = (await screen.findByLabelText("spend.daily_budget_usd")) as HTMLInputElement;
    expect(field.type).toBe("number");
    expect(field.step).toBe("any");
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "12.50" } });
    expect(field.validity.valid).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save spend.daily_budget_usd" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ action: "set", key: "spend.daily_budget_usd", value: "12.50" });
  });
});
