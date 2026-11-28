// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, CalendarEvents, CalendarSync } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/calendar.js";
const { CalendarPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { CalendarPage: FunctionComponent };

// The Calendar page over a faked read (its tests over the real server read and store are in
// tests/calendar-events-api.test.ts) (design 09-dashboard-app, Calendar page): Week and Month views of the stored calendar events from
// GET /api/v1/calendar/events, with previous, next and Today, shaded days for a day the last syncs did not cover, the
// stale-sync notice, an empty state that links to the Integrations tab of Settings, and Sync (toolbar) and Sync these
// days (the not-synced note), which post the days shown to POST /api/v1/calendar/sync. Today is fixed at Thursday 2026-11-12 (local).

const SLOW = { timeout: 5_000 };
/** An event as the read answers it; its instants matter only to the details tests, which set their own. */
const ev = (id: string, time: string | null, source = "google-calendar"): CalendarEvent => ({
  kind: "event", source, id, title: `event ${id}`, all_day: time === null, time, starts_at: "2026-11-13T00:00:00.000Z", ends_at: "2026-11-13T01:00:00.000Z", details: null,
});

/** The fake server: the stored events by date, the synced days, and the sources' sync state. */
let events: Record<string, CalendarEvent[]>;
let synced: { from: string; to: string };
let calendar: CalendarSync[];
let reads: { from: string; to: string }[];
/** The range of the sync request that waits, as the read answers `sync_pending`. */
let pending: { from: string; to: string } | null;
let syncPosts: { body: unknown; token: string | null }[];
/** What POST /api/v1/calendar/sync answers. */
let syncAnswer: { status: number; body: unknown };
const TOKEN = "tok_page";

/** Each date from `from` through `to`, as the route answers it. */
function answer(from: string, to: string): CalendarEvents {
  const days: CalendarEvents["days"] = [];
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  for (let n = 0; ; n++) {
    const t = new Date(y, m - 1, d + n);
    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    if (date > to) break;
    const ok = date >= synced.from && date <= synced.to;
    // The owner's own events show whether or not the day is synced, as the real read lists them.
    days.push({ date, synced: ok, events: (events[date] ?? []).filter((e) => ok || e.source === "local") });
  }
  return { from, to, days, calendar, sync_pending: pending?.from === from && pending.to === to };
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
  pending = null;
  syncPosts = [];
  syncAnswer = { status: 202, body: { state: "pending" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: TOKEN, actor: "local:owner", commands: true });
    if (u.pathname === "/api/v1/calendar/sync" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { from: string; to: string };
      syncPosts.push({ body, token: new Headers(init.headers).get("x-csrf-token") });
      if (syncAnswer.status === 202) pending = body;
      return json(syncAnswer.status, syncAnswer.body);
    }
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
/** Presses a button or a view segment (a radio) by its name. */
const press = (name: string) => fireEvent.click(screen.queryByRole("radio", { name }) ?? screen.getByRole("button", { name }));
/** Waits for the days of the read `from`..`to` to show. */
const shownRange = async (from: string, to: string) => {
  await screen.findByText((_, el) => el?.getAttribute("data-day") === from, undefined, SLOW);
  expect(lastRead()).toEqual({ from, to });
};

describe("Calendar page", () => {
  it("the view control is exactly Week and Month, Week selected on load", async () => {
    show();
    const control = await screen.findByRole("radiogroup", { name: "Calendar view" }, SLOW);
    expect(within(control).getAllByRole("radio").map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([["Week", "true"], ["Month", "false"]]);
    expect(screen.queryByRole("button", { name: "Day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upcoming" })).toBeNull();
  });

  it("one row of the page toolbar holds the view switch, then Previous week, Today, Next week, the period and Sync last, outside the Card", async () => {
    show();
    const toolbar = (await screen.findByRole("radiogroup", { name: "Calendar view" }, SLOW)).parentElement!;
    expect(toolbar.hasAttribute("data-calendar-toolbar")).toBe(true);
    await within(toolbar).findByRole("button", { name: "Sync" }, SLOW);
    expect(within(toolbar).getAllByRole("radio").map((b) => b.textContent)).toEqual(["Week", "Month", "All", "Human", "Agent"]);
    // Previous, Next and Sync are icon buttons: their names are their aria-labels.
    expect(within(toolbar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Previous week", "Today", "Next week", "Sync", "New event"]);
    const order = [...toolbar.querySelectorAll("[role=radiogroup], button:not([role=radio]), h2")].map((e) => e.tagName === "H2" ? "period" : e.getAttribute("aria-label") ?? e.textContent);
    expect(order).toEqual(["Calendar view", "Show entries", "Previous week", "Today", "Next week", "period", "Sync", "New event"]);
    expect(document.querySelectorAll("[data-calendar-toolbar]")).toHaveLength(1);
    expect(toolbar.closest("[data-page-toolbar]")).not.toBeNull();
    expect(toolbar.closest("section")).toBeNull();
  });

  it("Week shows Monday to Sunday of the current week, each day's events all-day first (a filled pill), then timed by time (a dot, the time, the title)", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    expect(heading()).toBe("Nov 9 – 15, 2026");
    const week = screen.getByRole("list", { name: "Nov 9 – 15, 2026" });
    expect(week.tagName).toBe("OL");
    // Seven flexible columns from xl up (no fixed min width, so no sideways scroll); stacked below it.
    expect(week.className.split(/\s+/)).toEqual(expect.arrayContaining(["grid-cols-1", "xl:grid-cols-7"]));
    expect(week.className).not.toMatch(/min-w-\[/);
    expect(week.closest(".overflow-x-auto")).toBeNull();
    expect([...week.querySelectorAll<HTMLElement>(":scope > li")].map((d) => d.dataset.day)).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    const friday = document.querySelector<HTMLElement>('[data-day="2026-11-13"]')!;
    expect(entries(friday)).toEqual(["google-calendar:holiday", "work:standup", "google-calendar:lunch"]);
    const holiday = friday.querySelector<HTMLElement>('[data-event="google-calendar:holiday"]')!;
    // All day: the pill is filled in the calendar's colour and holds the title only; timed: a dot, then the time.
    expect(holiday.hasAttribute("data-all-day")).toBe(true);
    expect(holiday.className).toMatch(/\bbg-kind-[a-z-]+\b/);
    expect(holiday.textContent).toBe("event holiday");
    const standup = friday.querySelector<HTMLElement>('[data-event="work:standup"]')!;
    expect(standup.hasAttribute("data-all-day")).toBe(false);
    expect(standup.querySelector("[data-colour]")!.className).toMatch(/\bbg-kind-/);
    expect(standup.textContent).toBe("09:30event standup");
    expect(within(holiday).queryByRole("button")).toBeNull();
    // Days before the synced window are shaded and carry no text; a synced day with no event shows no text line.
    const unsynced = document.querySelector<HTMLElement>('[data-day="2026-11-09"]')!;
    expect(unsynced.hasAttribute("data-not-synced")).toBe(true);
    expect(unsynced.className).toContain("bg-surface-2");
    expect(within(unsynced).getByRole("heading", { level: 3 }).textContent).toContain("Mon, Nov 9");
    expect(unsynced.querySelector("ul")).toBeNull();
    const empty = document.querySelector<HTMLElement>('[data-day="2026-11-12"]')!;
    expect(empty.hasAttribute("data-not-synced")).toBe(false);
    expect(empty.querySelector("p, ul")).toBeNull();
  });

  it("the period heading is the only h2, in the toolbar line, announced when it changes; the Card is named by it", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(h2.closest("[data-calendar-toolbar]")).not.toBeNull();
    expect(h2.getAttribute("aria-live")).toBe("polite");
    const card = screen.getByRole("region", { name: "Nov 9 – 15, 2026" });
    expect(card.querySelector("h2")).toBeNull();
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    expect(heading()).toBe("November 2026");
    expect(screen.getByRole("region", { name: "November 2026" })).toBeTruthy();
  });

  it("today's date sits on the neutral ink dot in Week and Month (no outline, no accent), and no other day's does", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    expect([...document.querySelectorAll("[data-today]")].map((e) => e.closest("[data-day]")!.getAttribute("data-day"))).toEqual(["2026-11-12"]);
    const dot = document.querySelector("[data-today]")!.className;
    expect(dot).toContain("bg-text-1");
    expect(dot).not.toMatch(/outline|accent/);
    expect(document.querySelector("[data-today]")!.textContent).toBe("12");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    const today = [...document.querySelectorAll<HTMLElement>("[data-today]")];
    expect(today.map((e) => e.closest("[data-day]")!.getAttribute("data-day"))).toEqual(["2026-11-12"]);
    expect(today[0]!.textContent).toBe("12");
  });

  it("each event has a colour from a token (the all-day pill's fill, the timed event's dot), the same for one source across reads", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    const strip = (id: string) => {
      const chip = document.querySelector<HTMLElement>(`[data-event="${id}"]`)!;
      return (chip.querySelector("[data-colour]") ?? chip).className.match(/bg-kind-[a-z-]+/)?.[0];
    };
    expect(strip("google-calendar:holiday")).toMatch(/bg-kind-/);
    expect(strip("google-calendar:holiday")).toBe(strip("google-calendar:lunch"));
    const before = strip("google-calendar:lunch");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    expect(strip("google-calendar:lunch")).toBe(before);
  });

  it("an event names its source only when more than one calendar is connected", async () => {
    calendar = [...calendar, { source: "work", synced_at: "2026-11-12T08:00:00.000Z", failed: false }];
    show();
    await shownRange("2026-11-09", "2026-11-15");
    expect(document.querySelector('[data-event="work:standup"]')!.textContent).toContain("work");
    expect(document.querySelector('[data-event="google-calendar:lunch"]')!.textContent).toContain("google-calendar");
  });

  it("Month shows the month's whole weeks, Monday first, the days outside it faint; every cell the same height, the day's number at its top right", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    expect(heading()).toBe("November 2026");
    const grid = screen.getByRole("table", { name: "November 2026" });
    const heads = within(grid).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads[0]).toBe(new Date(2026, 10, 9).toLocaleDateString(undefined, { weekday: "short" }));
    const cells = within(grid).getAllByRole("cell");
    // 2026-11-01 is a Sunday and the 30th a Monday: six weeks, Oct 26 to Dec 6.
    expect(cells.map((c) => c.dataset.day)).toHaveLength(42);
    expect([cells[0]!.dataset.day, cells.at(-1)!.dataset.day]).toEqual(["2026-10-26", "2026-12-06"]);
    expect(cells.filter((c) => c.hasAttribute("data-outside")).map((c) => c.dataset.day)).toEqual([
      "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31",
      "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06",
    ]);
    const number = (date: string) => grid.querySelector(`[data-day="${date}"] [aria-hidden]`)!;
    expect(number("2026-10-26").className).toContain("text-text-3");
    expect(number("2026-11-14").className).toContain("text-text-2");
    expect(number("2026-11-13").className).toContain("text-text-1");
    // One fixed height for every cell (so a busy day does not grow its week), the number at the top right.
    expect(new Set(cells.map((c) => c.className.split(/\s+/).find((k) => /^h-\d+$/.test(k))))).toEqual(new Set(["h-28"]));
    expect(number("2026-11-13").parentElement!.className).toContain("justify-end");
    const unsynced = grid.querySelector('[data-day="2026-11-05"]')!;
    expect(unsynced.hasAttribute("data-not-synced")).toBe(true);
    expect(unsynced.querySelector("[data-event]")).toBeNull();
  });

  it("a month cell shows all its events up to 3; with more, 2 and '+N more', which opens the day's whole list, each event opening its details over it", async () => {
    events["2026-11-19"] = [ev("x", "08:00"), ev("y", "09:00"), ev("z", "10:00")];
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    const grid = screen.getByRole("table", { name: "November 2026" });
    const full = grid.querySelector<HTMLElement>('[data-day="2026-11-19"]')!;
    expect(entries(full)).toEqual(["google-calendar:x", "google-calendar:y", "google-calendar:z"]);
    expect(full.querySelector("[data-more]")).toBeNull();
    const busy = grid.querySelector<HTMLElement>('[data-day="2026-11-20"]')!;
    expect(entries(busy)).toEqual(["google-calendar:a", "google-calendar:b"]);
    const more = busy.querySelector<HTMLElement>("[data-more]")!;
    expect(more.textContent).toBe("+3 more");
    expect(more.getAttribute("aria-label")).toBe("+3 more on Fri, Nov 20");
    fireEvent.click(more);
    const list = document.querySelector<HTMLElement>("dialog[open][data-popover]")!;
    expect(list.querySelector("h2")!.textContent).toBe(new Date(2026, 10, 20).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    expect(entries(list)).toEqual(["google-calendar:a", "google-calendar:b", "google-calendar:c", "google-calendar:d", "google-calendar:e"]);
    // An event in the list opens its details over the list; a press inside them keeps the list open; Esc closes the top one only.
    fireEvent.click(list.querySelector<HTMLElement>('[data-event="google-calendar:d"]')!);
    const open = () => [...document.querySelectorAll<HTMLElement>("dialog[open][data-popover]")];
    expect(open().map((d) => d.querySelector("h2")!.textContent)).toEqual([list.querySelector("h2")!.textContent, "event d"]);
    fireEvent.pointerDown(open()[1]!.querySelector("[data-panel-body]")!);
    expect(open()).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(open().map((d) => d.querySelector("h2")!.textContent)).toEqual([list.querySelector("h2")!.textContent]));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(open()).toHaveLength(0));
  });

  it("below sm Month is a compact grid of numbers and dots, with the selected day's events under it (today's on load)", async () => {
    vi.stubGlobal("innerWidth", 390);
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    const grid = screen.getByRole("table", { name: "November 2026" });
    // No event chip inside the grid: a day is a button with its number and up to 3 dots, named with its count.
    expect(grid.querySelector("[data-event]")).toBeNull();
    const friday = within(grid).getByRole("button", { name: "Fri, Nov 20, 5 events" });
    expect(friday.querySelectorAll("[data-colour]")).toHaveLength(3);
    expect(within(grid).getByRole("button", { name: "Thu, Nov 12, no events" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-selected-day]")!.getAttribute("data-selected-day")).toBe("2026-11-12");
    expect(document.querySelector("[data-selected-day]")!.textContent).toContain("No events");
    fireEvent.click(friday);
    expect(friday.getAttribute("aria-pressed")).toBe("true");
    const day = document.querySelector<HTMLElement>('[data-selected-day="2026-11-20"]')!;
    expect(entries(day)).toEqual(["google-calendar:a", "google-calendar:b", "google-calendar:c", "google-calendar:d", "google-calendar:e"]);
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
    await shownRange("2026-10-26", "2026-12-06");
    press("Previous month");
    await shownRange("2026-09-28", "2026-11-01");
    expect(heading()).toBe("October 2026");
    press("Next month");
    press("Next month");
    await shownRange("2026-11-30", "2027-01-03");
    expect(heading()).toBe("December 2026");
    press("Next month");
    await shownRange("2026-12-28", "2027-01-31");
    expect(heading()).toBe("January 2027");
    press("Today");
    await shownRange("2026-10-26", "2026-12-06");
    expect(heading()).toBe("November 2026");
  });

  it("one note above the grid names the unsynced days, and is absent when every day is synced", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    const note = screen.getByRole("status");
    expect(note.getAttribute("data-tone")).toBe("info");
    expect(note.textContent).toContain(`Not synced: ${new Date(2026, 10, 9).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – `);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    press("Next week");
    await shownRange("2026-11-16", "2026-11-22");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelectorAll("[data-not-synced]")).toHaveLength(0);
  });

  it("a period outside the synced window shades every day, and no day of it is drawn as empty", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Previous week");
    await shownRange("2026-11-02", "2026-11-08");
    expect(screen.getByText(/Not synced:/, { selector: "[role=status] *" })).toBeTruthy();
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

  it("with no calendar connected the empty state links to the Integrations tab of Settings", async () => {
    calendar = [];
    synced = { from: "9999-01-01", to: "9999-01-01" };
    show();
    const link = await screen.findByRole("link", { name: "Connect a calendar in Settings" }, SLOW);
    expect(link.getAttribute("href")).toBe("/app/settings?tab=integrations#calendar");
    // No calendar connected: nothing to sync, so no Sync button.
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  });

  it("with no calendar connected the grid shows the local events and no day is shaded; a note above it links to Settings", async () => {
    calendar = [];
    synced = { from: "9999-01-01", to: "9999-01-01" };
    events = { "2026-11-13": [{ ...ev("mine", "09:30", "local"), repeats: "none" }] };
    show();
    await shownRange("2026-11-09", "2026-11-15");
    expect(entries()).toEqual(["local:mine"]);
    expect(document.querySelectorAll("[data-not-synced]")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("No calendar is connected");
    expect(screen.getByRole("button", { name: "New event" })).toBeTruthy();
  });

  /** The Sync buttons on the page, by their name: the toolbar's icon button by its aria-label, the note's by its text. */
  const syncButtons = () => screen.getAllByRole("button").filter((b) => /^(Sync|Sync these days|Syncing…)$/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

  it("Sync posts the days on screen with the token; both buttons show Syncing…, disabled, until it is done, and a second press sends nothing", { timeout: 15_000 }, async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    const sync = await screen.findByRole("button", { name: "Sync" }, SLOW);
    within(screen.getByRole("status")).getByRole("button", { name: "Sync these days" });
    fireEvent.click(sync);
    fireEvent.click(sync);
    await waitFor(() => expect(syncButtons().map((b) => [b.getAttribute("aria-label") ?? b.textContent, (b as HTMLButtonElement).disabled, b.getAttribute("aria-busy")])).toEqual([
      ["Syncing…", true, "true"],
      ["Syncing…", true, "true"],
    ]), SLOW);
    fireEvent.click(syncButtons()[0]!);
    fireEvent.click(syncButtons()[1]!);
    expect(syncPosts).toEqual([{ body: { from: "2026-11-09", to: "2026-11-15" }, token: TOKEN }]);
    // The controller ran it: the next read says no request waits and the days are synced.
    pending = null;
    synced = { from: "2026-11-09", to: "2026-12-11" };
    await screen.findByRole("button", { name: "Sync" }, { timeout: 8_000 });
    expect(document.querySelectorAll("[data-not-synced]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Sync these days" })).toBeNull();
    expect(syncPosts).toHaveLength(1);
  });

  it("in Month, Sync posts the first and last day on screen (the month's whole weeks); Sync these days posts the same range", async () => {
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    fireEvent.click(await within(screen.getByRole("status")).findByRole("button", { name: "Sync these days" }, SLOW));
    await waitFor(() => expect(syncPosts.map((p) => p.body)).toEqual([{ from: "2026-10-26", to: "2026-12-06" }]), SLOW);
    pending = null;
    press("Previous month");
    await shownRange("2026-09-28", "2026-11-01");
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }, SLOW));
    await waitFor(() => expect(syncPosts.map((p) => p.body).at(-1)).toEqual({ from: "2026-09-28", to: "2026-11-01" }), SLOW);
  });

  it("a refused Sync shows the server's reason and the buttons can be pressed again", async () => {
    syncAnswer = { status: 403, body: { error: "Only the owner syncs the calendars; you are local:other." } };
    show();
    await shownRange("2026-11-09", "2026-11-15");
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }, SLOW));
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toContain("Only the owner syncs the calendars");
    await waitFor(() => expect(syncButtons().every((b) => !(b as HTMLButtonElement).disabled)).toBe(true), SLOW);
  });
});

// Event details (design 09-dashboard-tasks-calendar, event details, 2026-11-24): a chip is a button that opens the
// whole event beside it (a Popover from sm up, a sheet below), with notes shown as text, never as HTML.
describe("Calendar page: event details", () => {
  const LONG = "Your interview with Acme Platform Infrastructure: final round with the hiring committee and a system design session";
  const NOTES = '<b>Agenda</b><br>Prep: <a href="https://example.com/prep">prep doc</a> and <a href="javascript:alert(1)">run me</a><img src=x onerror="alert(2)"><script>alert(3)</script> &lt;not a tag&gt;';
  const full = (): CalendarEvent => ({
    kind: "event", source: "google-calendar", id: "interview", title: LONG, all_day: false, time: "17:00",
    starts_at: new Date(2026, 10, 13, 17, 0).toISOString(), ends_at: new Date(2026, 10, 13, 18, 30).toISOString(),
    details: {
      calendar: "Work", location: "Room 1201", description: NOTES,
      organizer: { name: "Coordinator", email: "coord@example.com", response: null },
      attendees: [{ name: "Coordinator", email: "coord@example.com", response: "accepted" }, { name: null, email: "panel@example.com", response: "tentative" }],
      conference_url: "https://meet.example.com/abc", link: "https://calendar.google.com/calendar/event?eid=1", time_zone: null,
    },
  });
  const panel = () => document.querySelector<HTMLElement>("dialog[open]");
  const chip = async () => {
    await shownRange("2026-11-09", "2026-11-15");
    return document.querySelector<HTMLButtonElement>('[data-event="google-calendar:interview"]')!;
  };

  it("the popover's body keeps its content height: no box from the panel to its body grows from a zero flex basis, which Safari and the cmux browser drew 24px tall (owner #92)", async () => {
    events = { "2026-11-13": [full()] };
    show();
    fireEvent.click(await chip());
    const p = panel()!;
    expect(p.hasAttribute("data-popover")).toBe(true);
    const body = p.querySelector<HTMLElement>("[data-panel-body]")!;
    expect(body.querySelector("[data-event-detail]")).not.toBeNull();
    for (let el: HTMLElement | null = body; el && el !== p; el = el.parentElement) {
      // flex-1 is flex: 1 1 0%; WebKit sized the body from that 0 (check:responsive's panel-collapsed checks the result in the Mac's WebKit).
      expect(el.className.split(/\s+/)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(flex-1|basis-0|grow)$/)]));
      expect(el.className.split(/\s+/)).toContain("min-h-0");
    }
    expect(p.className).toMatch(/max-h-\[/);
  });

  it("pressing a truncated event opens beside it its full title, day and time range with the zone, calendar, place, video link, people and the event's page; Esc closes it and focus returns to the event", async () => {
    events = { "2026-11-13": [full()] };
    show();
    const button = await chip();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The chip cuts the title at 2 lines; its accessible name still holds the whole title.
    expect(button.textContent).toContain(LONG);
    expect(screen.getByRole("button", { name: new RegExp(`17:00.*${LONG}`) })).toBe(button);
    fireEvent.click(button);
    const p = panel()!;
    expect(p).not.toBeNull();
    expect(p.hasAttribute("data-popover")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(p).getByRole("heading", { level: 2 }).textContent).toBe(LONG);
    const when = p.querySelector("[data-event-when] dd")!.textContent!;
    expect(when).toContain("Friday, November 13, 2026");
    expect(when).toMatch(/5:00\s*–\s*6:30\sPM/);
    expect(when).toMatch(/GMT|UTC/);
    expect(p.textContent).toContain("Work");
    expect(p.querySelector("[data-event-location] dd")!.textContent).toBe("Room 1201");
    expect(p.querySelector<HTMLAnchorElement>("[data-event-meeting]")!.href).toBe("https://meet.example.com/abc");
    expect([...p.querySelectorAll("[data-person]")].map((e) => e.textContent)).toEqual(["Coordinatorcoord@example.com · Organizer · Going", "panel@example.comMaybe"]);
    // The link is pinned in the footer, outside the body that scrolls, so long details never push it out of view.
    const link = p.querySelector<HTMLAnchorElement>("[data-panel-footer] [data-event-link]")!;
    expect(p.querySelector("[data-panel-body] [data-event-link]")).toBeNull();
    expect([link.textContent, link.href, link.target, link.rel]).toEqual(["Open in Google Calendar", "https://calendar.google.com/calendar/event?eid=1", "_blank", "noopener noreferrer"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("notes written as HTML are shown as text: no element comes from them, an http link stays a link, a javascript: link is only its label", async () => {
    events = { "2026-11-13": [full()] };
    show();
    fireEvent.click(await chip());
    const notes = panel()!.querySelector<HTMLElement>("[data-event-notes]")!;
    expect(notes.textContent).toBe("Agenda\nPrep: prep doc: https://example.com/prep and run me <not a tag>");
    expect(notes.querySelectorAll("b, img, script")).toHaveLength(0);
    expect([...notes.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/prep"]);
    expect(document.querySelector("img[src=x], script:not([src])")).toBeNull();
  });

  it("an all-day event says All day; an event with no details still shows its day and calendar", async () => {
    events = { "2026-11-13": [{ ...ev("holiday", null), starts_at: new Date(2026, 10, 13).toISOString(), ends_at: new Date(2026, 10, 14).toISOString(), details: null }] };
    show();
    await shownRange("2026-11-09", "2026-11-15");
    fireEvent.click(document.querySelector<HTMLElement>('[data-event="google-calendar:holiday"]')!);
    const p = panel()!;
    expect(p.querySelector("[data-event-when] dd")!.textContent).toBe("Friday, November 13, 2026All day");
    expect(p.textContent).toContain("google-calendar");
    expect(p.querySelector("[data-event-link], [data-event-notes]")).toBeNull();
  });

  it("below sm the details open as a sheet over the page with the whole title, and in Month too", async () => {
    vi.stubGlobal("innerWidth", 390);
    events = { "2026-11-13": [full()] };
    show();
    await shownRange("2026-11-09", "2026-11-15");
    press("Month");
    await shownRange("2026-10-26", "2026-12-06");
    // The compact month lists the selected day's events under the grid.
    fireEvent.click(screen.getByRole("button", { name: "Fri, Nov 13, 1 event" }));
    fireEvent.click(document.querySelector<HTMLElement>('[data-event="google-calendar:interview"]')!);
    const p = panel()!;
    expect(p.hasAttribute("data-popover")).toBe(false);
    expect(p.textContent).toContain(LONG);
    expect(p.querySelector("[data-event-notes]")).not.toBeNull();
  });

  describe("the All / Human / Agent filter", () => {
    beforeEach(() => {
      events["2026-11-14"] = [{ ...ev("sch_1:2026-11-14T07:00:00.000Z", "07:00", "agent"), kind: "agent", title: "Daily digest" }, { ...ev("sch_1:next", "08:00", "agent"), kind: "agent", title: "Daily digest", next: true }];
    });
    const chips = () => [...document.querySelectorAll<HTMLElement>("[data-event]")].map((e) => e.dataset.event);
    const pick = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

    it("is a SegmentedControl All, Human, Agent in that order, All checked on load", async () => {
      show();
      await screen.findByText("event holiday", undefined, SLOW);
      const group = screen.getByRole("radiogroup", { name: "Show entries" });
      expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Human", "Agent"]);
      expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
    });

    it("Human hides agent entries and Agent hides human events, in Week and Month", async () => {
      show();
      await screen.findByText("event holiday", undefined, SLOW);
      expect(chips()).toContain("agent:sch_1:next");
      pick("Human");
      expect(chips()).toContain("google-calendar:holiday");
      expect(chips().some((c) => c?.startsWith("agent:"))).toBe(false);
      pick("Agent");
      expect(chips()).toEqual(["agent:sch_1:2026-11-14T07:00:00.000Z", "agent:sch_1:next"]);
      fireEvent.click(screen.getByRole("radio", { name: "Month" }));
      await screen.findAllByText("Daily digest", undefined, SLOW);
      expect(chips().every((c) => c?.startsWith("agent:"))).toBe(true);
      pick("Human");
      expect(chips().some((c) => c?.startsWith("agent:"))).toBe(false);
    });

    it("an agent entry has the Agent Badge (info), the next slot says Next run, and its details have no Edit or Delete", async () => {
      show();
      await screen.findByText("event holiday", undefined, SLOW);
      const next = document.querySelector<HTMLElement>('[data-event="agent:sch_1:next"]')!;
      expect(within(next).getByText("Agent").closest("[data-level]")?.getAttribute("data-level")).toBe("info");
      expect(within(next).getByText("Next run")).toBeTruthy();
      expect(document.querySelector('[data-event="agent:sch_1:2026-11-14T07:00:00.000Z"]')!.textContent).not.toContain("Next run");
      fireEvent.click(next);
      await screen.findByRole("dialog", undefined, SLOW).catch(() => undefined);
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });
  });
});
