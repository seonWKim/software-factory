// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectFor } from "../web/src/pages.js";
import { ActivityBody } from "../web/src/views/activity/page.js";
import { RESPONSES, installShellFixtures, mount } from "./ui-shell-fixtures.js";

// The links between the Activity page and the pages whose runs it lists (design 09-dashboard-activity,
// 09-dashboard-schedules, 09-health): the route, Schedules and Health and the item page linking in, the About card
// linking back, and the schedules runs read giving each run its transcript link. The read is loaded by a specifier
// vite does not follow, because it reaches the store, which jsdom cannot bundle; it runs here over a fake store.

// The read imports two modules that reach the store and the repo root, which jsdom cannot load; it uses neither beyond apiError.
vi.mock("../src/ui/api.js", () => ({ apiError: (status: number, error: string) => ({ status, value: { error } }) }));
vi.mock("../src/ui/alarms.js", () => ({}));

installShellFixtures();
afterEach(cleanup);

const T0 = "2026-11-26T10:00:00.000Z";
const actor = (actor_id: string, name: string) => ({ actor_id, name, about: `${name} does things.`, state: "idle", now: "Waiting", last_at: null, next_run_at: null, transcript: null, actions: [] });
const VIEW = { as_of: T0, retention_days: 30, actors: [actor("system:reaper", "Run reaper"), actor("system:schedule", "Schedules"), actor("system:cleanup", "Workspace cleanup")], alerts: [] };

function show(view = VIEW) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(ActivityBody, { view, now: Date.parse(T0) })));
}

describe("the Activity route", () => {
  it("/app/activity opens the Activity page, not Work", async () => {
    RESPONSES["/api/v1/activity"] = VIEW;
    history.replaceState(null, "", "/app/activity");
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
    expect(location.pathname).toBe("/app/activity");
    expect(screen.queryByRole("heading", { level: 1, name: "Work" })).toBeNull();
    expect(redirectFor("/app/activity")).toBeNull();
  });
});

describe("links to the Activity page", () => {
  it("Schedules links to the schedule actor's entry", async () => {
    RESPONSES["/api/v1/schedules"] = { schedules: [] };
    history.replaceState(null, "", "/app/schedules");
    mount();
    const link = await screen.findByRole("link", { name: "Activity" });
    expect(link.getAttribute("href")).toBe("/app/activity?actor=system:schedule");
  });

  it("Health links to the Activity page", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    const link = await screen.findByRole("link", { name: "Activity" });
    expect(link.getAttribute("href")).toBe("/app/activity");
  });

  it("the item page links to the Activity page", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    mount();
    const link = await screen.findByRole("link", { name: "Activity" });
    expect(link.getAttribute("href")).toBe("/app/activity");
  });
});

describe("the About card's Back link", () => {
  it("the schedule actor links back to Schedules; every other actor to Health", () => {
    history.replaceState(null, "", "/app/activity?actor=system:schedule");
    show();
    expect(screen.getByRole("heading", { name: "About Schedules" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Schedules" }).getAttribute("href")).toBe("/app/schedules");
    expect(screen.queryByRole("link", { name: "Back to Health" })).toBeNull();
    cleanup();
    history.replaceState(null, "", "/app/activity?actor=system:cleanup");
    show();
    expect(screen.getByRole("heading", { name: "About Workspace cleanup" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Health" }).getAttribute("href")).toBe("/app/health");
  });

  it("selects the actor ?actor= names; with none it keeps the first, and picking a row opens that actor", () => {
    history.replaceState(null, "", "/app/activity");
    show();
    expect(screen.getByRole("heading", { name: "About Run reaper" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Health" })).toBeTruthy();
    cleanup();
    history.replaceState(null, "", "/app/activity?actor=system:nobody");
    show();
    expect(screen.getByRole("heading", { name: "About Run reaper" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("table", { name: "Actors" })).getByText("Schedules"));
    expect(screen.getByRole("heading", { name: "About Schedules" })).toBeTruthy();
  });
});

describe("the schedules runs read", () => {
  const READ = "../src/ui/schedules-api.js";
  const run = (recorded_at: string) => ({ schedule_id: "sch_1", occurrence_at: recorded_at, outcome: "fired", recorded_at });
  const claim = (at: string, ref: string | null, subject = "sch_1") => ({ seq: 1, actor_id: "system:schedule", kind: "schedule_run", subject, outcome: "fired", reason: "due", ref, at });

  it("gives each run its transcript link when its claim started one, and null when none", async () => {
    const { readScheduleRuns } = await import(/* @vite-ignore */ READ);
    const T = (n: number) => `2026-11-2${n}T08:00:00.000Z`;
    const store = {
      listSchedules: async () => [{ id: "sch_1" }],
      listScheduleRuns: async () => [run(T(3)), run(T(4)), run(T(5))],
      listActivity: async () => [
        claim(T(3), "/api/v1/items/wi_9/runs/run_9/transcript"),
        claim(T(4), "/api/v1/schedules/runs?schedule=sch_1"),
        claim(T(5), "/api/v1/items/wi_8/runs/run_8/transcript", "sch_other"),
      ],
    };
    const r = await readScheduleRuns({ store }, "sch_1");
    expect(r.status).toBe(200);
    expect(r.value.runs.map((x) => x.transcript)).toEqual(["/app/items/wi_9/runs/run_9", null, null]);
  });
});
