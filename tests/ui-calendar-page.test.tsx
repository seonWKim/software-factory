// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvents, CalendarSync, EventRow } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/calendar.js";
const { CalendarPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { CalendarPage: FunctionComponent };

// The Calendar page (design 09-dashboard-app, Calendar page): Week and Month views of the stored calendar events from
// GET /api/v1/calendar/events, with previous, next and Today, "Not synced" for a day the last syncs did not cover, the
// stale-sync notice, and an empty state that links to Settings → Calendar. Today is fixed at Thursday 2026-11-12 (local).

const SLOW = { timeout: 5_000 };
const ev = (id: string, time: string | null, source = "google-calendar"): EventRow => ({ kind: "event", source, id, title: `event ${id}`, all_day: time === null, time });

/** The fake server: the stored events by date, the synced days, and the sources' sync state. */
let events: Record<string, EventRow[]>;
let synced: { from: string; to: string };
let calendar: CalendarSync[];
let reads: { from: string; to: string }[];

/** Each date from `from` through `to`, as the route answers it. */
function answer(from: string, to: string): CalendarEvents {
  const days: CalendarEvents["days"] = [];
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  for (let n = 0; ; n++) {
    const t = new Date(y, m - 1, d + n);
    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    if (date > to) break;
    const ok = date >= synced.from && date <= synced.to;
    days.push({ date, synced: ok, events: ok ? (events[date] ?? []) : [] });
  }
  return { from, to, days, calendar };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 12, 10, 0) });
  events = {
    "2026-11-13": [ev("holiday", null), ev("standup", "09:30", "work"), ev("lunch", "12:00")],
    "2026-11-20": [ev("a", "08:00"), ev("b", "09:00"), ev("c", "10:00"), ev("d", "11:00"), ev("e", "12:00")],
  };
  synced = { from: "2026-11-12", to: "2026-12-11" };
  calendar = [{ source: "google-calendar", synced_at: "2026-11-12T08:00:00.000Z", failed: false }];
  reads = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url, "http://127.0.0.1");
    if (u.pathname !== "/api/v1/calendar/events") return new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
    const range = { from: u.searchParams.get("from")!, to: u.searchParams.get("to")! };
    reads.push(range);
    return new Response(JSON.stringify(answer(range.from, range.to)), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(CalendarPage)));
const entries = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>("[data-event]")].map((e) => e.dataset.event);
const heading = () => screen.getByRole("heading", { level: 2 }).textContent;
const lastRead = () => reads.at(-1);
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
/** Waits for the days of the read `from`..`to` to show. */
const shownRange = async (from: string, to: string) => {
  await screen.findByText((_, el) => el?.getAttribute("data-day") === from, undefined, SLOW);
  expect(lastRead()).toEqual({ from, to });
};

describe("Calendar page", () => {
  it("is a sidebar page at /app/calendar in the Tasks group, right after Tasks", () => {
    expect(routeFor("/app/calendar").page.label).toBe("Calendar");
    const tasks = PAGES.filter((p) => p.group === "tasks").map((p) => p.path);
    expect(tasks.indexOf("calendar")).toBe(tasks.indexOf("tasks") + 1);
  });

  it("the view control is exactly Week and Month, Week selected on load", async () => {
    show();
    const control = await screen.findByRole("group", { name: "Calendar view" }, SLOW);
    expect(within(control).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Week", "true"], ["Month", "false"]]);
    expect(screen.queryByRole("button", { name: "Day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upcoming" })).toBeNull();
  });

  it("Week shows Monday to Sunday of the current week, each day's events all-day first, then timed by time, with time or 'all day' and source", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    expect(heading()).toBe("Nov 9 – 15, 2026");
    const week = screen.getByRole("list", { name: "Nov 9 – 15, 2026" });
    expect([...week.querySelectorAll<HTMLElement>(":scope > li")].map((d) => d.dataset.day)).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    const friday = document.querySelector<HTMLElement>('[data-day="2026-11-13"]')!;
    expect(entries(friday)).toEqual(["google-calendar:holiday", "work:standup", "google-calendar:lunch"]);
    const holiday = friday.querySelector<HTMLElement>('[data-event="google-calendar:holiday"]')!;
    expect(holiday.textContent).toContain("all day");
    expect(holiday.textContent).toContain("google-calendar");
    expect(friday.querySelector('[data-event="work:standup"]')!.textContent).toContain("09:30");
    expect(within(holiday).queryByRole("button")).toBeNull();
    // Days before the synced window say so; a synced day with no event is not drawn as not synced.
    expect(document.querySelector('[data-day="2026-11-09"] [data-not-synced]')!.textContent).toBe("Not synced");
    expect(document.querySelector('[data-day="2026-11-12"] [data-not-synced]')).toBeNull();
    expect(document.querySelector('[data-day="2026-11-12"]')!.textContent).toContain("No events");
  });

  it("Month shows a Monday-first grid of the month: up to 3 events a cell, then '+N more', empty cells outside the month", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-11-01", "2026-11-30");
    expect(heading()).toBe("November 2026");
    const grid = screen.getByRole("table", { name: "November 2026" });
    const heads = within(grid).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads[0]).toBe(new Date(2026, 10, 9).toLocaleDateString(undefined, { weekday: "short" }));
    const cells = within(grid).getAllByRole("cell");
    // 2026-11-01 is a Sunday: six empty cells before it, and the grid ends on a Sunday (the 30th is a Monday).
    expect(cells.slice(0, 7).map((c) => c.dataset.day ?? "")).toEqual(["", "", "", "", "", "", "2026-11-01"]);
    expect(cells.slice(0, 6).every((c) => c.textContent === "")).toBe(true);
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((c) => c.dataset.day).map((c) => c.dataset.day)).toHaveLength(30);
    const busy = grid.querySelector<HTMLElement>('[data-day="2026-11-20"]')!;
    expect(entries(busy)).toEqual(["google-calendar:a", "google-calendar:b", "google-calendar:c"]);
    expect(busy.textContent).toContain("+2 more");
    expect(grid.querySelector('[data-day="2026-11-05"]')!.textContent).toContain("Not synced");
  });

  it("Week: previous and next move by one week, Today returns to the current week; the heading and the read follow", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Previous week");
    await shownRange("2026-11-02", "2026-11-08");
    expect(heading()).toBe("Nov 2 – 8, 2026");
    press("Next week");
    press("Next week");
    await shownRange("2026-11-16", "2026-11-22");
    expect(heading()).toBe("Nov 16 – 22, 2026");
    press("Next week");
    press("Next week");
    await shownRange("2026-11-30", "2026-12-06");
    expect(heading()).toBe("Nov 30 – Dec 6, 2026");
    press("Today");
    await shownRange("2026-11-09", "2026-11-15");
    expect(heading()).toBe("Nov 9 – 15, 2026");
  });

  it("Month: previous and next move by one month, Today returns to the current month; the heading and the read follow", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-11-01", "2026-11-30");
    press("Previous month");
    await shownRange("2026-10-01", "2026-10-31");
    expect(heading()).toBe("October 2026");
    press("Next month");
    press("Next month");
    await shownRange("2026-12-01", "2026-12-31");
    expect(heading()).toBe("December 2026");
    press("Next month");
    await shownRange("2027-01-01", "2027-01-31");
    expect(heading()).toBe("January 2027");
    press("Today");
    await shownRange("2026-11-01", "2026-11-30");
    expect(heading()).toBe("November 2026");
  });

  it("a period outside the synced window says it is not synced, and no day of it is drawn as empty", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Previous week");
    await shownRange("2026-11-02", "2026-11-08");
    expect(screen.getByText(/not synced/, { selector: "[role=status] *" })).toBeTruthy();
    expect(document.querySelectorAll("[data-not-synced]")).toHaveLength(7);
    expect(screen.queryByText("No events")).toBeNull();
  });

  it("a source whose last sync failed is named with its last sync, and its stored events stay listed", async () => {
    calendar = [{ source: "google-calendar", synced_at: "2026-11-12T08:00:00.000Z", failed: true }];
    show();
    const stale = (await screen.findByText(/google-calendar: showing the stored events, last synced/, undefined, SLOW)).closest("[data-calendar-stale]");
    expect(stale).not.toBeNull();
    expect(entries()).toEqual(["google-calendar:holiday", "work:standup", "google-calendar:lunch"]);
  });

  it("with no calendar connected the empty state links to Settings → Calendar", async () => {
    calendar = [];
    synced = { from: "9999-01-01", to: "9999-01-01" };
    show();
    const link = await screen.findByRole("link", { name: "Connect a calendar in Settings" }, SLOW);
    expect(link.getAttribute("href")).toBe("/app/settings#calendar");
  });
});
