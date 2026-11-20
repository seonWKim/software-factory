// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalRow, ProposalsView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/proposals.js";
const { ProposalsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { ProposalsPage: FunctionComponent };

// The Proposals page (design 09-dashboard-proposals, issue #496): each proposal with its golden evidence (catch and
// false-alarm rates before and after, the cases replayed) and its change behind "Show the change"; a waiting one has
// Promote, Hold and Reject, which POST /api/v1/proposals/verdict with the CSRF token. Its state is unchanged until then.

const TOKEN = "tok_proposals";
const SLOW = { timeout: 5_000 };
const cases = (verdict: "bug" | "pass") => [{ id: "1", expect: "should_flag" as const, verdict }, { id: "2", expect: "should_pass" as const, verdict: "pass" as const }];

const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: "prop_1", state: "pending", reason: null, error_code: "checks_failed", run_count: 3, file: "prompts/review.md", why: "The reviewer missed failing tests.",
  diff: "--- a/prompts/review.md\n+++ b/prompts/review.md\n@@ -1,1 +1,2 @@\n-REVIEW\n+REVIEW\n+Check the tests.", before: { cases: cases("pass"), catch_rate: 0, false_alarm_rate: 0 },
  after: { cases: cases("bug"), catch_rate: 1, false_alarm_rate: 0 }, rules: null, needs_human_merge: true, decided_at: null, filed: false, created_at: "2026-11-20T00:00:00.000Z",
  ...over,
});

let current: ProposalsView;
let posts: unknown[];

beforeEach(() => {
  current = { csrf_token: TOKEN, proposals: [row(), row({ id: "prop_2", state: "watching", run_count: 2, why: null, diff: null, before: null, after: null })] };
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: string; verdict: string };
      posts.push({ url, token: (init.headers as Record<string, string>)["x-csrf-token"], body });
      const state = { promote: "promoted", reject: "rejected", hold: "held" }[body.verdict]!;
      current = { ...current, proposals: current.proposals.map((p) => (p.id === body.id ? { ...p, state } : p)) };
      return new Response(JSON.stringify({ id: body.id, state, unchanged: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/v1/proposals") return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(ProposalsPage)));
}
const item = (id: string) => document.querySelector<HTMLElement>(`[data-proposal="${id}"]`)!;

describe("Proposals page", () => {
  it("is a page at /app/proposals", () => {
    expect(routeFor("/app/proposals").page.label).toBe("Proposals");
    expect(PAGES.map((p) => p.path)).toContain("proposals");
  });

  it("shows each proposal with its evidence and the three verdict buttons; nothing is sent until one is pressed", async () => {
    show();
    const waiting = await screen.findByRole("list", { name: "Waiting for you" }, SLOW);
    expect(within(waiting).getAllByRole("listitem").map((li) => li.dataset.proposal)).toEqual(["prop_1"]);
    const evidence = item("prop_1").querySelector("[data-evidence]")!;
    expect(evidence.textContent).toContain("Problems caught0% before, 100% after");
    expect(evidence.textContent).toContain("False alarms0% before, 0% after");
    expect(within(item("prop_1")).getByText("Show the change")).toBeTruthy();
    expect(within(item("prop_1")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Promote", "Hold", "Reject"]);
    expect(posts).toEqual([]);
    // A watching proposal is listed without a verdict.
    expect(within(item("prop_2")).queryAllByRole("button")).toEqual([]);
    expect(item("prop_2").textContent).toContain("too few to suggest a change yet");
  });

  it.each([["Promote", "promote", "Promoted"], ["Hold", "hold", "On hold"], ["Reject", "reject", "Rejected"]])("%s sends its verdict with the CSRF token", async (label, verdict, badge) => {
    show();
    await screen.findByRole("list", { name: "Waiting for you" }, SLOW);
    fireEvent.click(within(item("prop_1")).getByRole("button", { name: label }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/proposals/verdict", token: TOKEN, body: { id: "prop_1", verdict } }]));
    await waitFor(() => expect(item("prop_1").textContent).toContain(badge));
  });

  it("without the token (no right to decide) shows no verdict buttons", async () => {
    current = { ...current, csrf_token: null };
    show();
    await screen.findByRole("list", { name: "Waiting for you" }, SLOW);
    expect(within(item("prop_1")).queryAllByRole("button", { name: /Promote|Hold|Reject/ })).toEqual([]);
    expect(item("prop_1").textContent).toContain("Only someone who may approve plans can decide here.");
  });

  it("an empty list says what the page is for", async () => {
    current = { csrf_token: TOKEN, proposals: [] };
    show();
    expect(await screen.findByText("No proposals yet", undefined, SLOW)).toBeTruthy();
  });
});
