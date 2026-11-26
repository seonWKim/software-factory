// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBody } from "../web/src/views/activity/page.js";

// The Activity page (design 09-dashboard-activity) in the DOM. It imports no store: under jsdom vite cannot bundle
// node:sqlite, so the read and the capability are tested in tests/activity-api.test.ts.

const T0 = "2026-11-26T10:00:00.000Z";
const TRANSCRIPT = "/api/v1/items/wi_1/runs/run_1/transcript";
afterEach(cleanup);

const VIEW = {
  as_of: T0, retention_days: 30,
  actors: [
    { actor_id: "system:schedule", name: "Schedules", about: "Starts work.", state: "attention", now: "Waiting", last_at: T0, next_run_at: null, transcript: { kind: "transcript", href: "/app/items/wi_1/runs/run_1", text: TRANSCRIPT },
      actions: [{ seq: 1, kind: "schedule_run", subject: "s1", outcome: "failed", reason: "no slot", at: T0, link: { kind: "transcript", href: "/app/items/wi_1/runs/run_1", text: TRANSCRIPT } }] },
    { actor_id: "system:cleanup", name: "Workspace cleanup", about: "Cleans.", state: "idle", now: "Waiting", last_at: null, next_run_at: null, transcript: null, actions: [] },
  ],
  alerts: [{ alert_id: "al_1", text: "Zero tokens", created_at: T0 }],
};

function show(view = VIEW) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["/api/v1/session"], { csrf_token: "tok" });
  return render(createElement(QueryClientProvider, { client }, createElement(ActivityBody, { view, now: Date.parse(T0) })));
}

describe("the Activity page", () => {
  it("shows the Actors Card with a row, Badge state and Transcript button per actor, then the About Card with its recent actions", () => {
    show();
    const actors = screen.getByRole("region", { name: "Actors" });
    expect(within(actors).getAllByRole("row")).toHaveLength(3);
    expect(within(actors).getByText("Needs a look")).toBeTruthy();
    expect(within(actors).getAllByRole("button", { name: /Transcript of/ })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "About Schedules" })).toBeTruthy();
    const about = screen.getByRole("table", { name: "Recent actions of Schedules" });
    expect(about.textContent).toContain("failed");
    expect(about.textContent).toContain("no slot");
    expect(within(about).getByRole("link", { name: "Transcript" }).getAttribute("href")).toBe("/app/items/wi_1/runs/run_1");
  });

  it("clears a factory alert with a button labelled Clear", () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ dismissed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    show();
    const clear = screen.getByRole("button", { name: /Clear alert/ });
    expect(clear.textContent).toBe("Clear");
    fireEvent.click(clear);
    expect(fetched).toHaveBeenCalledWith("/api/v1/alarms/dismiss", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });
});
