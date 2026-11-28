/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { FunctionComponent } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/runtime";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { syncCalendars } from "../src/calendar/index.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { readCalendarEvents } from "../src/ui/calendar-events-api.js";
import { resolveSettings } from "../src/core/settings.js";
import type { UiDeps } from "../src/ui/deps.js";
import type { HealthMonitor } from "../src/ui/health.js";
import type { UiSettings } from "../src/ui/settings-api.js";
import { FakeCalendarSource, calendarEvent } from "./calendar/fakes.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { newStore } from "./helpers/store.js";

// The Calendar page over the real read of GET /api/v1/calendar/events (src/ui/calendar-events-api.ts readCalendarEvents)
// on a test store: the live `calendar` setting says which calendars are connected, as on Settings → Integrations, and
// a sync row exists only once a sync ran. The 2026-11-19 report: Settings said google-calendar was connected, the
// Calendar page said "No calendar is connected", because the page's list came from the sync rows.
//
// This file runs in the node environment and installs jsdom's globals itself, instead of naming vitest's jsdom environment:
// the test store opens node:sqlite, and vitest's jsdom environment cannot load it on Node 22, whose builtinModules
// list leaves node:sqlite out ("Cannot bundle Node.js built-in"). The page's other tests, over a faked read, are in
// tests/ui-calendar-page.test.tsx. server.ts and health.ts are not loaded: they import the Settings modules.
const dom = await builtinEnvironments.jsdom.setup(globalThis, {});
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { cleanup, render, screen } = await import("@testing-library/react");
const { createElement } = await import("react");
// tsconfig.test.json checks this file without JSX, so the page's .tsx module is loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/calendar.js";
const { CalendarPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { CalendarPage: FunctionComponent };

const SLOW = { timeout: 5_000 };
const at = (day: number, h: number) => new Date(2026, 10, day, h).toISOString();
const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(CalendarPage)));
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-event]")].map((e) => e.dataset.event);

/** A store with `connected` as the live `calendar` setting; `sync` runs one calendar sync of google-calendar first. */
async function serve(connected: string[], sync: boolean) {
  // Today is Thursday 2026-11-12 (local), as in the page's other tests.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 12, 10, 0) });
  const clock = new FakeClock(new Date(2026, 10, 12, 9, 0));
  const { store } = await newStore(clock);
  await store.setSettingOverride({ key: "calendar", project: "", value: JSON.stringify(connected), actor: "owner@example.com" });
  if (sync) {
    const source = new FakeCalendarSource([calendarEvent("review", { starts_at: at(13, 14), ends_at: at(13, 15) })]);
    await syncCalendars(storeSql(store), [{ name: "google-calendar", source }], clock.now().getTime());
  }
  // Settings' Calendar section, as compose.ts uiCalendar builds its `listed`: the live setting over an empty base.
  const base = { file: {}, layers: { defaults: {}, projects: {} } };
  const listed = async () => resolveSettings(base, await store.listSettingOverrides()).values.calendar;
  const settings = { calendar: { flow: { listed } } } as unknown as UiSettings;
  const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: {} as HealthMonitor, settings };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: "tok_page", actor: "local:owner", commands: true });
    if (u.pathname !== "/api/v1/calendar/events") return json(404, { error: "Not found." });
    const r = await readCalendarEvents(d, u.searchParams.get("from"), u.searchParams.get("to"));
    return json(r.status, r.value);
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => dom.teardown(globalThis));

describe("Calendar page over the server read", () => {
  it("a connected, synced calendar shows its stored events", async () => {
    await serve(["google-calendar"], true);
    show();
    await screen.findByText("event review", undefined, SLOW);
    expect(entries()).toEqual(["google-calendar:review"]);
    expect(screen.queryByText("No calendar is connected.")).toBeNull();
    expect(screen.queryByText("Not synced yet")).toBeNull();
  });

  it("a connected calendar that never synced says \"Not synced yet\", not \"No calendar is connected\"", async () => {
    await serve(["google-calendar"], false);
    show();
    const notice = (await screen.findByText("Not synced yet", undefined, SLOW)).closest("[role=status]");
    expect(notice?.querySelector('[data-calendar-unsynced="google-calendar"]')?.textContent).toBe("google-calendar");
    expect(screen.queryByText("No calendar is connected.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect a calendar in Settings" })).toBeNull();
  });

  it("with no calendar connected, even with old sync rows and events, the empty state links to Settings → Integrations", async () => {
    await serve([], true);
    show();
    const link = await screen.findByRole("link", { name: "Connect a calendar in Settings" }, SLOW);
    expect(link.getAttribute("href")).toBe("/app/settings?tab=integrations#calendar");
    expect(screen.getByText("No calendar is connected.")).toBeTruthy();
    expect(entries()).toEqual([]);
  });

  it("schedule runs and next slots are agent entries on their days; a paused schedule gives none; no calendar source is read", async () => {
    const clock = new FakeClock(new Date(2026, 10, 12, 9, 0));
    const { store } = await newStore(clock);
    const base = { zone: "UTC", created_by: "local:owner" as UserId, created_at: "2026-11-01T00:00:00.000Z" as Timestamp };
    const ran = new Date(2026, 10, 10, 9).toISOString() as Timestamp;
    const next = new Date(2026, 10, 13, 9).toISOString() as Timestamp;
    await store.addSchedule({ ...base, id: "sch_a", title: "Daily digest", cadence: { kind: "daily", spec: "09:00" }, next_due_at: ran });
    expect(await store.claimScheduleOccurrence({ schedule_id: "sch_a", occurrence_at: ran, next_due_at: next, outcome: "fired" })).not.toBeNull();
    await store.addSchedule({ ...base, id: "sch_p", title: "Paused one", cadence: { kind: "daily", spec: "09:00" }, next_due_at: null });
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: {} as HealthMonitor, settings: { calendar: { flow: { listed: async () => [] } } } as unknown as UiSettings };
    const read = async (from: string, to: string) => ((await readCalendarEvents(d, from, to)).value as { days: { date: string; events: { kind: string; source: string; title: string; id: string; next?: boolean }[] }[] }).days;
    const week = await read("2026-11-09", "2026-11-15");
    const agent = (date: string) => week.find((x) => x.date === date)!.events;
    expect(agent("2026-11-10")).toMatchObject([{ kind: "agent", source: "agent", title: "Daily digest" }]);
    expect(agent("2026-11-13")).toMatchObject([{ kind: "agent", title: "Daily digest", next: true }]);
    expect(week.flatMap((x) => x.events).some((e) => e.title === "Paused one")).toBe(false);
    expect((await read("2026-11-16", "2026-11-22")).flatMap((x) => x.events)).toEqual([]);
  });
});
