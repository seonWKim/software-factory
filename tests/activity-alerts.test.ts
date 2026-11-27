// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTab } from "../web/src/views/activity/page.js";

// The Alerts card of Health's Activity tab (design 09-dashboard-activity): each open alert with a Clear button; Clear posts
// the alert's ID to POST /api/v1/alarms/dismiss, the list is read again, and a refusal shows in a Notice.

const T0 = "2026-11-26T10:00:00.000Z";
const view = (alerts) => ({ as_of: T0, retention_days: 30, actors: [], alerts });
const ALERT = (id, text) => ({ alert_id: id, text, created_at: T0 });
let open, posts, refuse;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mountPage() {
  open = [ALERT("al_1", "Zero tokens"), ALERT("al_2", "Red main")];
  posts = [];
  refuse = null;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url: url, body });
      if (refuse !== null) return json({ error: refuse }, 409);
      open = open.filter((a) => a.alert_id !== body.alert_id);
      return json({ dismissed: true });
    }
    if (url.startsWith("/api/v1/session")) return json({ as_of: T0, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    if (url.startsWith("/api/v1/activity")) { reads++; return json(view(open)); }
    return json({ error: "Not found." }, 404);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(ActivityTab)));
  return () => reads;
}

describe("the Alerts card", () => {
  it("shows each open alert with a Clear button", async () => {
    mountPage();
    const card = await screen.findByRole("region", { name: "Factory alerts" });
    expect(within(card).getByText("Zero tokens")).toBeTruthy();
    expect(within(card).getByText("Red main")).toBeTruthy();
    expect(within(card).getAllByRole("button", { name: /Clear alert/ })).toHaveLength(2);
  });

  it("Clear posts that alert's ID to /api/v1/alarms/dismiss and reads the list again", async () => {
    const reads = mountPage();
    const clear = await screen.findByRole("button", { name: "Clear alert: Red main" });
    await waitFor(() => expect(clear.hasAttribute("disabled")).toBe(false));
    const before = reads();
    fireEvent.click(clear);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/v1/alarms/dismiss", body: { alert_id: "al_2" } });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText("Red main")).toBeNull());
    expect(screen.getByText("Zero tokens")).toBeTruthy();
  });

  it("a refusal shows in a Notice and leaves the alert", async () => {
    mountPage();
    refuse = "No such alert.";
    const clear = await screen.findByRole("button", { name: "Clear alert: Zero tokens" });
    await waitFor(() => expect(clear.hasAttribute("disabled")).toBe(false));
    fireEvent.click(clear);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Could not clear the alert");
    expect(notice.textContent).toContain("No such alert.");
    expect(screen.getByText("Zero tokens")).toBeTruthy();
  });
});
