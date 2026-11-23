// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The item page's Changes tab (design 04-screenshots, 09-dashboard-item): the underline Tabs under the header, the
// Merge button above the tab panel on both tabs, and in Changes the stored screenshots by page, each at 390px and
// 1280px in light and dark, then the screenshot review's findings and unverified lines. Token classes only.

const AT = "2026-11-23T00:00:00.000Z";
const ID = "wi_7c1e00";
const RUN = "run_shot1";
const capture = (page: string, width: number, theme: string) => ({ page, width, theme, key: `${ID}/${RUN}/${page}-${width}-${theme}.png` });
// Stored out of order: the tab lists 390px then 1280px, light then dark.
const CAPTURES = ["items", "settings"].flatMap((p) => [capture(p, 1280, "dark"), capture(p, 390, "light"), capture(p, 1280, "light"), capture(p, 390, "dark")]);
const REVIEW = {
  run_id: "run_rev2", status: "succeeded",
  findings: [{ kind: "code", text: "breaks decision rule 1: the Work page's row actions wrap at 1280px, light" }],
  unverified: ["screenshots not captured: the capture of transcript at 390px, dark failed: timeout"],
  summary: "One layout rule broken.",
};
const item = (extra: object = {}) => ({
  id: ID, source: { type: "local", id: "local-7c1e", link: "local:local-7c1e" }, title: "Tighten the Work rows",
  stage: "REVIEW", close_reason: null, blocked_on: "human", blocked_reason: "merge_pending", tier: 2, loop_count: 0, restart_count: 0, token_cost: 0,
  change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3, created_at: AT, updated_at: AT,
  item_phase: "merge_pending", merge: { enabled: true, reason: null },
  why: { code: "merge", reason_code: "person", params: { reason: "Ready to merge" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null },
  ...extra,
});
const detail = (extra: object = {}) => ({
  as_of: AT, item: item(), timeline: [], runs: [], commands: [{ name: "verdict", usage: "/verdict", description: "verdict", allowed: true, reason: null }], replies: [], spec: null,
  screenshots: { run_id: RUN, status: "succeeded", captures: CAPTURES, reason: null },
  screenshot_review: REVIEW,
  ...extra,
});

let body: Record<string, unknown>;
let images: string[];

beforeEach(() => {
  body = detail();
  images = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.split("?")[0]!;
    if (path === "/api/v1/screenshot") {
      const q = new URLSearchParams(url.split("?")[1]);
      images.push(`${q.get("page")}-${q.get("width")}-${q.get("theme")}`);
      return new Response(JSON.stringify({ data_url: "data:image/png;base64,iVBORw0KGgo=" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const bodies: Record<string, unknown> = {
      [`/api/v1/items/${ID}`]: body,
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 1, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
    };
    const out = bodies[path];
    if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  history.replaceState(null, "", `/app/items/${ID}?tab=changes`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

const changes = () => document.querySelector("[data-item-changes]") as HTMLElement;

describe("item page: Changes tab", () => {
  it("is a tab on the shared Tabs, selected from the URL, beside Overview", async () => {
    mount();
    const tabs = await screen.findByRole("tablist", { name: "Item views" });
    expect(within(tabs).getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["Overview", "false"], ["Changes", "true"]]);
    expect(changes()).not.toBeNull();
  });

  it("lists each page's screenshots at 390px and 1280px, in light and dark, each image read once", async () => {
    mount();
    await screen.findByRole("tablist", { name: "Item views" });
    for (const page of ["items", "settings"]) {
      const list = changes().querySelector(`[data-screenshot-page="${page}"]`)!;
      expect([...list.querySelectorAll("[data-screenshot]")].map((li) => li.getAttribute("data-screenshot"))).toEqual(["390-light", "390-dark", "1280-light", "1280-dark"]);
      expect([...list.querySelectorAll("figcaption")].map((f) => f.textContent)).toEqual(["390px · Light", "390px · Dark", "1280px · Light", "1280px · Dark"]);
    }
    expect(await screen.findByRole("img", { name: "items at 390px, light" })).toBeTruthy();
    await vi.waitFor(() => expect(changes().querySelectorAll("img")).toHaveLength(8));
    expect(images.sort()).toEqual(CAPTURES.map((c) => `${c.page}-${c.width}-${c.theme}`).sort());
    // The fixture's data, said once.
    expect(changes().textContent).toContain("sample data the page check uses");
  });

  it("shows the screenshot review's findings and what it did not check", async () => {
    mount();
    const review = await screen.findByRole("region", { name: "Screenshot review" });
    expect(within(review).getByText(REVIEW.findings[0]!.text)).toBeTruthy();
    expect(review.querySelector("[data-screenshot-unverified]")!.textContent).toBe(REVIEW.unverified[0]);
  });

  it("keeps the Merge button on the page while the tab is shown, outside the tab's content", async () => {
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    const merge = await within(decide).findByRole("button", { name: "Merge" });
    expect(changes().contains(merge)).toBe(false);
    // The overview's blocks are not on this tab.
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(changes()).toBeNull();
    expect(location.search).toBe("");
    expect(within(screen.getByRole("region", { name: "What you need to decide" })).getByRole("button", { name: "Merge" })).toBeTruthy();
  });

  it("with no screenshot run shows an empty state that says when screenshots come; a capture that failed says why", async () => {
    body = detail({ screenshots: null, screenshot_review: null });
    mount();
    expect(await screen.findByText("No screenshots yet")).toBeTruthy();
    expect(screen.getByText("No screenshot review yet")).toBeTruthy();
    cleanup();
    body = detail({ screenshots: { run_id: RUN, status: "succeeded", captures: [], reason: "Chrome is not installed on this worker" }, screenshot_review: null });
    mount();
    const reason = await vi.waitFor(() => {
      const el = document.querySelector("[data-screenshots-reason]");
      if (!el) throw new Error("no reason shown yet");
      return el;
    });
    expect(reason.textContent).toContain("Chrome is not installed on this worker");
    expect(reason.closest("[role=alert]")).not.toBeNull();
  });

  it("uses colour token classes only: no hex colour and no palette class", async () => {
    mount();
    await vi.waitFor(() => expect(changes().querySelectorAll("img")).toHaveLength(8));
    const html = changes().outerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:red|green|blue|gray|slate|zinc|neutral|amber|yellow|emerald)-\d{2,3}\b/);
    const source = readFileSync(join(import.meta.dirname, "..", "web", "src", "views", "item-changes.tsx"), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
