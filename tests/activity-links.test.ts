// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectFor } from "../web/src/pages.js";
import { ActivityBody } from "../web/src/views/activity/page.js";
import { RESPONSES, installShellFixtures, mount } from "./ui-shell-fixtures.js";

// The links between Health's Activity tab and the pages whose runs it lists (design 09-dashboard-activity,
// 09-dashboard-schedules, 09-health): the tab and the old path's redirect, Schedules and the item page linking in, the
// schedule actor's About card linking back, and the schedules runs read giving each run its transcript link. The read is loaded by a specifier
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

describe("Health's Activity tab", () => {
  it("/app/health?tab=activity draws the actors under Health's one h1, the Activity tab selected", async () => {
    RESPONSES["/api/v1/activity"] = VIEW;
    history.replaceState(null, "", "/app/health?tab=activity");
    mount();
    expect(await screen.findByRole("table", { name: "Actors" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Health"]);
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "Checks" })).toBeNull();
  });

  it("/app/activity redirects to the tab, keeping ?actor=", async () => {
    expect(redirectFor("/app/activity")).toBe("/app/health?tab=activity");
    expect(redirectFor("/app/activity", "?actor=system:schedule")).toBe("/app/health?tab=activity&actor=system:schedule");
    RESPONSES["/api/v1/activity"] = VIEW;
    history.replaceState(null, "", "/app/health?tab=activity&actor=system:schedule");
    mount();
    expect(await screen.findByRole("heading", { name: "About Schedules" })).toBeTruthy();
    expect(`${location.pathname}${location.search}`).toBe("/app/health?tab=activity&actor=system:schedule");
  });

  it("no sidebar entry or page header link names Activity: the tab is its one way in on Health", async () => {
    history.replaceState(null, "", "/app/health");
    mount();
    await screen.findByRole("tab", { name: "Activity" });
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).queryByRole("link", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
  });
});

describe("links to the Activity tab", () => {
  it("Schedules links to the schedule actor's entry", async () => {
    RESPONSES["/api/v1/schedules"] = { schedules: [] };
    history.replaceState(null, "", "/app/schedules");
    mount();
    const link = await screen.findByRole("link", { name: "Activity" });
    expect(link.getAttribute("href")).toBe("/app/health?tab=activity&actor=system:schedule");
  });

  it("the item page links to Health's Activity tab", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    mount();
    const link = await screen.findByRole("link", { name: "Activity" });
    expect(link.getAttribute("href")).toBe("/app/health?tab=activity");
  });
});

describe("the About card's Back link", () => {
  it("the schedule actor links back to Schedules; every other actor has no Back link, as it is on Health already", () => {
    history.replaceState(null, "", "/app/health?tab=activity&actor=system:schedule");
    show();
    expect(screen.getByRole("heading", { name: "About Schedules" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Schedules" }).getAttribute("href")).toBe("/app/schedules");
    expect(screen.queryByRole("link", { name: "Back to Health" })).toBeNull();
    cleanup();
    history.replaceState(null, "", "/app/health?tab=activity&actor=system:cleanup");
    show();
    expect(screen.getByRole("heading", { name: "About Workspace cleanup" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
  });

  it("selects the actor ?actor= names; with none it keeps the first, and picking a row opens that actor", () => {
    history.replaceState(null, "", "/app/health?tab=activity");
    show();
    expect(screen.getByRole("heading", { name: "About Run reaper" })).toBeTruthy();
    cleanup();
    history.replaceState(null, "", "/app/health?tab=activity&actor=system:nobody");
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
