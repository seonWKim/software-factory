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
// days left when known. Its lines, and the Checks card, are in plain words (design 09-health, 2026-11-20): numbers
// grouped by thousands, times local, no ISO time or file path outside the Details disclosure.

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
let healthBody: unknown;

/** The viewer's local clock time, as the page writes it ("9:51 PM"). */
const clock = (at: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));

/** The rendered text without the Details disclosures (`data-raw`) and code elements. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-raw], code").forEach((n) => n.remove());
  return copy.textContent ?? "";
}
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const FILE_PATH = /(^|[\s(])~?\/[\w.-]+\//;

beforeEach(() => {
  current = overview();
  overviewReads = 0;
  healthBody = { checked_at: RESET, checks: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/overview") {
      overviewReads++;
      return json(200, current);
    }
    if (url === "/api/v1/health") return json(200, healthBody);
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

describe("Health page: GitHub budget tab", () => {
  it("with overview.github_budget present the tab shows remaining of limit, reset, counted calls and github_token_days", async () => {
    current = overview({ github_budget: budget(), github_token_days: 12 });
    const list = await show();
    const tab = await within(list).findByRole("tab", { name: "GitHub budget" }, SLOW);
    // Added after the other tabs, which keep their order.
    expect(tabNames(list).slice(-2)).toEqual([expect.stringContaining("Merged without review"), "GitHub budget"]);
    fireEvent.click(tab);
    const panel = await screen.findByRole("region", { name: "GitHub budget" });
    expect(panel.textContent).toContain(`812 of 5,000 GitHub requests left; resets at ${clock(RESET)}`);
    expect(panel.textContent).toContain("This factory made 37 of them since the last reset.");
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
    expect(within(waiting).getByRole("alert").textContent).toBe(`No GitHub requests left until ${clock(RESET)}. GitHub reads and writes wait; local work goes on.`);
    // The stored reason, with its ISO time, is behind Details only.
    expect(waiting.querySelector("[data-raw]")!.textContent).toContain(`waiting for the GitHub rate-limit reset at ${RESET}`);
    expect(visibleText(waiting)).not.toMatch(ISO);
    expect(waiting.querySelector("[data-token-days]")).toBeNull();
    cleanup();
    current = overview({ github_budget: budget({ state: "low", remaining: 100 }), github_token_days: "unknown" });
    await show("github");
    const low = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect(within(low).getByRole("alert").textContent).toContain("GitHub budget low");
    expect(low.querySelector("[data-token-days]")!.textContent).toBe("GitHub token: days left not checked yet.");
  });

  it("groups the numbers by thousands, says the share with no bracketed number, and keeps the replica and ISO reset behind Details", async () => {
    current = overview({ github_budget: budget({ remaining: 4844, counted: 1250, share_limit: 5000, budget_share: 1 }), github_token_days: null });
    await show("github");
    const panel = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    const lines = [...panel.querySelectorAll("[data-github-budget] > p")].map((p) => p.textContent);
    expect(lines).toEqual([
      `4,844 of 5,000 GitHub requests left; resets at ${clock(RESET)}`,
      "This factory made 1,250 of them since the last reset.",
      "Your share: 5,000 requests.",
    ]);
    expect(visibleText(panel)).not.toMatch(ISO);
    expect(visibleText(panel)).not.toContain("host:42");
    expect(panel.querySelector("[data-raw]")!.textContent).toContain("host:42");
  });
});

describe("Health page: the Checks card", () => {
  const AGO = new Date(Date.now() - 5 * 60_000).toISOString();

  it("all ok: 'All N checks pass · 5m ago', the rows folded with no second count", async () => {
    healthBody = { checked_at: AGO, checks: [
      { status: "ok", msg: "Your secret file is private", detail: "secret file at /home/u/.env is private (mode 600)" },
      { status: "ok", msg: "GitHub labels: all present", detail: 'status label "sf: triaging" exists' },
      { status: "ok", msg: "GitHub: 2,566 of 5,000 requests left this hour", detail: "GitHub: 2566/5000 left, resets 12:50, synced by replica host:42" },
    ] };
    await show();
    const card = await screen.findByRole("region", { name: "All 3 checks pass · 5m ago" }, SLOW);
    const folded = within(card).getByTestId("ok-checks") as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector("summary")!.textContent).toBe("Show the checks");
    // The count is said once: in the title.
    expect(card.textContent!.match(/\b3\b/g)).toHaveLength(1);
    // Each row: its status, then its sentence; the raw text only behind its Details.
    const rows = [...folded.querySelectorAll("li")].map((li) => visibleText(li));
    expect(rows).toEqual(["OKYour secret file is private", "OKGitHub labels: all present", "OKGitHub: 2,566 of 5,000 requests left this hour"]);
    expect(visibleText(card)).not.toMatch(FILE_PATH);
    expect(visibleText(card)).not.toContain("host:42");
    expect([...card.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n")).toContain("/home/u/.env");
  });

  it("a fail or warn: the title says how many need attention, and those rows come first", async () => {
    healthBody = { checked_at: AGO, checks: [
      { status: "ok", msg: "fine" },
      { status: "warn", msg: "GitHub labels: 2 missing (run: npm run setup)", detail: 'status label "sf: done" exists (run: npm run setup)' },
      { status: "fail", msg: "Your secret file can be read by other users; the fix is in Details", detail: "secret file at /home/u/.env is private (mode 644; run: chmod 600 /home/u/.env)" },
    ] };
    await show();
    const card = await screen.findByRole("region", { name: "2 checks need attention · 5m ago" }, SLOW);
    const firstRows = [...card.querySelectorAll("ul")[0]!.children].map((li) => visibleText(li as HTMLElement));
    expect(firstRows[0]).toContain("Your secret file can be read by other users");
    expect(firstRows[1]).toContain("GitHub labels: 2 missing (run: npm run setup)");
    expect(within(card).getByTestId("ok-checks").querySelector("summary")!.textContent).toBe("1 ok");
    expect(visibleText(card)).not.toMatch(FILE_PATH);
  });
});
