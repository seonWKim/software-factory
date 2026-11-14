// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayRow, EventRow, TaskRow, TasksView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/calendar.js";
const { CalendarPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { CalendarPage: FunctionComponent };

// The Calendar page (design 09-dashboard-app and 02-tasks): the stored calendar events from GET /api/v1/tasks, in a
// Day and an Upcoming view, with the stale-sync notice and an empty state that links to Settings → Calendar.

const SLOW = { timeout: 5_000 };
const ev = (id: string, time: string | null, source = "google-calendar"): EventRow => ({ kind: "event", source, id, title: `event ${id}`, all_day: time === null, time });
const task = (id: string): TaskRow => ({ id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null });
const view = (over: Partial<TasksView> = {}): TasksView => ({
  today_date: "2026-11-12", today: { overdue: [], due: [] }, upcoming: [], projects: [],
  calendar: [{ source: "google-calendar", synced_at: "2026-11-12T08:00:00.000Z", failed: false }], csrf_token: "tok", can_build: true, ...over,
});

let current: TasksView;
beforeEach(() => {
  current = view();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/v1/tasks" ? current : { error: "Not found." }), { status: url === "/api/v1/tasks" ? 200 : 404, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(CalendarPage)));
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-event]")].map((e) => e.dataset.event);

describe("Calendar page", () => {
  it("is a sidebar page at /app/calendar in the Tasks group, right after Tasks", () => {
    expect(routeFor("/app/calendar").page.label).toBe("Calendar");
    const tasks = PAGES.filter((p) => p.group === "tasks").map((p) => p.path);
    expect(tasks.indexOf("calendar")).toBe(tasks.indexOf("tasks") + 1);
  });

  it("Day lists today's events, all-day first, then timed ones by time, each with its time or 'all day' and its source; tasks are left out", async () => {
    current = view({ today: { overdue: [], due: [ev("lunch", "12:00"), task("tk_a"), ev("holiday", null), ev("standup", "09:30", "work")] as DayRow[] } });
    show();
    await screen.findByText("event holiday", undefined, SLOW);
    expect(entries()).toEqual(["google-calendar:holiday", "work:standup", "google-calendar:lunch"]);
    const holiday = document.querySelector<HTMLElement>('[data-event="google-calendar:holiday"]')!;
    expect(holiday.textContent).toContain("all day");
    expect(holiday.textContent).toContain("google-calendar");
    expect(holiday.textContent).not.toContain("Event");
    expect(document.querySelector('[data-event="work:standup"]')!.textContent).toContain("09:30");
    expect(document.querySelector("[data-task]")).toBeNull();
    expect(within(holiday).queryByRole("button")).toBeNull();
  });

  it("Upcoming lists each of the next days' events under its date", async () => {
    current = view({
      upcoming: [
        { date: "2026-11-13", tasks: [ev("dentist", "08:00"), task("tk_soon")] as DayRow[] },
        { date: "2026-11-14", tasks: [ev("trip", null)] },
        { date: "2026-11-15", tasks: [task("tk_only")] },
      ],
    });
    show();
    await screen.findByRole("group", { name: "Calendar view" }, SLOW);
    fireEvent.click(screen.getByRole("button", { name: "Upcoming" }));
    expect(entries()).toEqual(["google-calendar:dentist", "google-calendar:trip"]);
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });

  it("a source whose last sync failed is named above the events, which stay listed", async () => {
    current = view({ today: { overdue: [], due: [ev("standup", "09:30")] }, calendar: [{ source: "google-calendar", synced_at: null, failed: true }] });
    show();
    expect((await screen.findByText(/google-calendar: showing the stored events/, undefined, SLOW)).closest("[data-calendar-stale]")).not.toBeNull();
    expect(entries()).toEqual(["google-calendar:standup"]);
  });

  it("with no calendar connected the empty state links to Settings → Calendar", async () => {
    current = view({ calendar: [] });
    show();
    const link = await screen.findByRole("link", { name: "Connect a calendar in Settings" }, SLOW);
    expect(link.getAttribute("href")).toBe("/app/settings#calendar");
  });

  it("with a calendar connected and no events the empty state has no link", async () => {
    show();
    await screen.findByText("No events today.", undefined, SLOW);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
