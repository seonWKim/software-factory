// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubBudget, Overview } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-pause.test.tsx does).
const PAGE_MODULE = "../web/src/views/pages.js";
const { HealthPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { HealthPage: FunctionComponent };

// The Health page's GitHub budget tab (design 09-dashboard-app, 2026-11-16): shown only while overview.github_budget
// is stored; it shows remaining of limit, the reset, the counted calls, a banner while waiting or low, and the token's
// days left when known.

const RESET = "2099-01-01T09:12:00.000Z";
const SLOW = { timeout: 5_000 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const budget = (over: Partial<GitHubBudget> = {}): GitHubBudget => ({
  limit: 5000, remaining: 812, reset_at: RESET, budget_share: 1, share_limit: null, counted: 37, state: "ok", as_of: RESET, replica_id: "host:42",
  wait_reason: null, ...over,
});
const overview = (over: Partial<Overview> = {}): Overview => ({
  as_of: RESET, stages: {}, needs_you: 0, open: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, ...over,
});

let current: Overview;
let overviewReads = 0;
let health: Record<string, unknown> = { checked_at: RESET, checks: [] };

beforeEach(() => {
  current = overview();
  overviewReads = 0;
  health = { checked_at: RESET, checks: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/overview") {
      overviewReads++;
      return json(200, current);
    }
    if (url === "/api/v1/health") return json(200, health);
    if (url === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show(tab?: string) {
  history.replaceState(null, "", tab ? `/app/health?tab=${tab}` : "/app/health");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(HealthPage)));
  return screen.findByRole("tablist", { name: "Health sections" }, SLOW);
}

const tabNames = (list: HTMLElement) => within(list).getAllByRole("tab").map((t) => t.textContent);

describe("Health page: before the server's first health run ends", () => {
  it("pending: keeps the Health checks placeholder and reads again until the stored report arrives", async () => {
    health = { checked_at: null, checks: [], pending: true };
    history.replaceState(null, "", "/app/health");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(HealthPage)));
    await waitFor(() => expect(screen.getByLabelText("Health checks").getAttribute("aria-busy")).toBe("true"));
    health = { checked_at: RESET, checks: [{ status: "ok", msg: "fine" }], pending: false };
    await screen.findByRole("tablist", { name: "Health sections" }, SLOW);
  });
});

describe("Health page: GitHub budget tab", () => {
  it("with overview.github_budget present the tab shows remaining of limit, reset, counted calls and github_token_days", async () => {
    current = overview({ github_budget: budget(), github_token_days: 12 });
    const list = await show();
    const tab = await within(list).findByRole("tab", { name: "GitHub budget" }, SLOW);
    // Added after the other tabs, which keep their order.
    expect(tabNames(list).slice(-2)).toEqual([expect.stringContaining("Merged without review"), "GitHub budget"]);
    fireEvent.click(tab);
    const panel = await screen.findByRole("region", { name: "GitHub budget" });
    expect(panel.textContent).toContain(`812 of 5000 calls left until ${RESET}`);
    expect(panel.textContent).toContain("counted 37 calls");
    expect(panel.querySelector("[data-token-days]")!.textContent).toBe("GitHub token: 12 days left.");
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("hides the tab when overview.github_budget is null, even with ?tab=github", async () => {
    current = overview({ github_budget: null, github_token_days: null });
    const list = await show("github");
    await screen.findByRole("region", { name: /Checks/ }, SLOW);
    // The overview has been read and rendered before the tab is looked for.
    await waitFor(() => expect(overviewReads).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(list).queryByRole("tab", { name: "GitHub budget" })).toBeNull();
    expect(screen.queryByRole("region", { name: "GitHub budget" })).toBeNull();
  });

  it("waiting shows its banner with the wait reason; low shows its banner; no token check shows no token line", async () => {
    current = overview({ github_budget: budget({ state: "waiting", remaining: 0, wait_reason: `waiting for the GitHub rate-limit reset at ${RESET}` }), github_token_days: null });
    await show("github");
    const waiting = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect(within(waiting).getByRole("alert").textContent).toContain(`waiting for the GitHub rate-limit reset at ${RESET}`);
    expect(waiting.querySelector("[data-token-days]")).toBeNull();
    cleanup();
    current = overview({ github_budget: budget({ state: "low", remaining: 100 }), github_token_days: "unknown" });
    await show("github");
    const low = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect(within(low).getByRole("alert").textContent).toContain("GitHub budget low");
    expect(low.querySelector("[data-token-days]")!.textContent).toBe("GitHub token: days left not checked yet.");
  });
});
