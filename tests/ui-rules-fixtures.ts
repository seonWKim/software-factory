// Shared builders, fetch stub and state for the Rules page tests (tests/ui-rules-*.test.tsx). Tests read and write the
// state as s.current, s.posts and so on, because an ES import cannot be reassigned. This file holds no test, so vitest's
// include glob does not pick it up.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { expect, vi } from "vitest";
import type { RuleEntryView, RulesView } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-users-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/rules.js";
export const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

export const TOKEN = "tok_rules";
export const SLOW = { timeout: 5_000 };
export const AT = "2026-11-07T00:00:00.000Z";

export const view = (over: Partial<RulesView> = {}): RulesView => ({
  enabled: true,
  applied: null,
  error: null,
  csrf_token: TOKEN,
  judge: null,
  home: null,
  turn_on: null,
  entries: [
    { id: "P-0007", title: "Split the review prompt", state: "held", kind: "edit-asset", target: "prompts/review.md", judged: null, draft: null, draft_error: null },
    {
      id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: null, draft_error: null,
      draft: { default: "Keep every flag.", exception: "a deprecated flag", incidents: ["T-1"], scope: "CLI" },
    },
  ],
  ...over,
});
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const s: {
  current: RulesView;
  /** GET /api/v1/standing's answer. */
  standing: unknown;
  posts: { url: string; init: RequestInit }[];
  answer: { status: number; body: unknown };
  gets: string[];
  /** GET /api/v1/rules/entry's answer: a detail view, one per ID, or an HTTP status for a failed read. */
  detail: RuleEntryView | number | ((id: string) => RuleEntryView);
} = {
  current: view(),
  standing: null,
  posts: [],
  answer: { status: 200, body: {} },
  gets: [],
  detail: { id: "C-012", error: null, detail: null },
};

/** Sets the defaults and stubs fetch; each test file calls it in its beforeEach. */
export function reset() {
  s.current = view();
  s.standing = { as_of: AT, csrf_token: TOKEN, rules: [], proposals: [] };
  s.posts = [];
  s.gets = [];
  s.detail = { id: "C-012", error: null, detail: null };
  s.answer = { status: 200, body: { id: "C-012", verdict: "promote" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      s.posts.push({ url, init });
      // The settings route's answer to Turn on: the ledger is on from the next GET.
      if (url === "/api/v1/settings" && s.answer.status === 200) s.current = view();
      return json(s.answer.status, s.answer.body);
    }
    s.gets.push(url);
    if (url === "/api/v1/rules") return json(200, s.current);
    if (url === "/api/v1/standing") return json(200, s.standing);
    if (url.startsWith("/api/v1/rules/entry?")) {
      if (typeof s.detail === "number") return json(s.detail, { error: "boom" });
      return json(200, typeof s.detail === "function" ? s.detail(new URL(url, "http://x").searchParams.get("id")!) : s.detail);
    }
    return json(404, { error: "Not found." });
  }));
}

/** Each test file calls it in its afterEach. */
export function teardown() {
  cleanup();
  vi.unstubAllGlobals();
}

export async function show() {
  history.replaceState(null, "", "/app/rules");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
}

/** The page's two sections, by title. */
export const section = (name: "In effect" | "Waiting for you") => screen.getByRole("region", { name });
/** Opens the page's one Details disclosure (at its end) once the rules are loaded, and returns it. */
export async function openDetails(): Promise<HTMLElement> {
  const details = await waitFor(() => {
    const d = document.querySelector<HTMLDetailsElement>("details[data-page-details]");
    if (!d) throw new Error("no page Details yet");
    return d;
  }, SLOW);
  if (!details.open) fireEvent.click(details.querySelector("summary")!);
  return details;
}

export const card = (id: string) => document.querySelector<HTMLElement>(`[data-rule="${id}"]`)!;
/** A card's "Why and where" toggle: the summary of its Disclosure. */
export const whyToggle = (id: string) => within(card(id)).getByText("Why and where").closest("summary")!;
export const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-dialog]")!;
/** Picks a verdict: Promote is the row's visible button; Hold and Reject are items of its ⋯ menu. */
export const choose = (el: HTMLElement, label: string) => {
  if (label === "Promote") {
    fireEvent.click(within(el).getByRole("button", { name: "Promote" }));
    return;
  }
  fireEvent.click(within(el).getByRole("button", { name: /^Decide:/ }));
  fireEvent.click(within(el).getByRole("menuitem", { name: label }));
};
export const sent = () => s.posts.map((p) => JSON.parse(String(p.init.body)));

export const HOMES = [{ path: "/Users/me/agents", missing: "bin/evolve" }, { path: "/Users/me/.agents", missing: null }];

export const off = (over: Partial<RulesView> = {}): RulesView =>
  view({ enabled: false, entries: [], home: { path: "/Users/me/.agents", missing: null, homes: [HOMES[1]!] }, turn_on: '{"tacit":"agents-home"}', ...over });

export const h1s = () => screen.queryAllByRole("heading", { level: 1 }).map((h) => h.textContent);

export const APPLIED: RulesView["applied"] = {
  rules: [
    { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: null, incidents: ["T-1"], judged: "2026-10-01", raw: null },
    { id: "C-002", name: "flags", default: "Keep every flag.", exceptions: null, scope: null, incidents: ["T-2"], judged: "2026-11-13", raw: null },
    { id: null, name: null, default: null, exceptions: null, scope: null, incidents: null, judged: null, raw: "## Notes" },
  ],
  elsewhere: [],
};

export const applied = (id: string) => document.querySelector<HTMLElement>(`[data-applied="${id}"]`)!;

export const PUSHBACKS = { rows: [{ id: "T-0201", pushback: "keep the --json flag", date: "2026-11-20" }, { id: "T-0202", pushback: "요약 먼저", date: null }], error: null };

export const proposalEntry = (title = "Quiet notify"): RulesView["entries"] => [
  { id: "P-20261103-34e9", title, state: "open", kind: "edit-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null },
];

export const openDialog = async (label: string) => {
  await show();
  await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
  choose(card("P-20261103-34e9"), label);
  await waitFor(() => expect(dialog().querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
};
