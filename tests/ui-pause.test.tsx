// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PausesView } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the pages are built with createElement and their .tsx
// module is loaded by a specifier the node check skips (as tests/ui-settings-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/pages.js";
const { FloorPage, HealthPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { FloorPage: FunctionComponent; HealthPage: FunctionComponent };

// Claim pauses on the Floor and Health pages (issue #291, design §5 Restarts and §9): each pause in effect with
// when it ends and a "Resume now" button that posts to /api/v1/pauses/resume with the CSRF token; a refusal
// shows next to that button.

const TOKEN = "tok_pause";
const ENDS = "2099-01-01T00:00:00.000Z";
let view: PausesView;
let posts: { url: string; init: RequestInit }[] = [];
let answer: { status: number; body: unknown };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  view = { pauses: [{ name: "rate_limit", ends_at: ENDS }, { name: "forge_auth", ends_at: ENDS }], csrf_token: TOKEN };
  answer = { status: 200, body: { name: "rate_limit", ended: true, pauses: [] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      if (answer.status === 200) view = { ...view, pauses: view.pauses.filter((p) => p.name !== JSON.parse(String(init.body)).name) };
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/pauses") return json(200, view);
    if (url === "/api/v1/health") return json(200, { checked_at: ENDS, checks: [] });
    if (url === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(page: FunctionComponent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(page)));
  return screen.findByRole("list", { name: "Claim pauses" });
}

describe.each([["Floor", () => FloorPage], ["Health", () => HealthPage]] as const)("%s page claim pauses", (_name, page) => {
  it("lists each active pause with its name, when it ends and a Resume now button", async () => {
    const list = await show(page());
    const items = [...list.querySelectorAll<HTMLElement>("li[data-pause]")];
    expect(items.map((li) => li.getAttribute("data-pause"))).toEqual(["rate_limit", "forge_auth"]);
    for (const li of items) {
      expect(li.textContent).toContain(ENDS);
      expect(within(li).getByRole("button", { name: "Resume now" })).toBeTruthy();
    }
  });

  it("Resume now posts the pause name with the CSRF token, and the pause leaves the list", async () => {
    const list = await show(page());
    const li = list.querySelector<HTMLElement>('li[data-pause="rate_limit"]')!;
    fireEvent.click(within(li).getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(list.querySelector('li[data-pause="rate_limit"]')).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/pauses/resume");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ name: "rate_limit" });
    expect(list.querySelector('li[data-pause="forge_auth"]')).not.toBeNull();
  });

  it("an error from the endpoint shows next to that button", async () => {
    answer = { status: 403, body: { error: "Resuming needs write permission (approve_spec): no_role." } };
    const list = await show(page());
    const li = list.querySelector<HTMLElement>('li[data-pause="forge_auth"]')!;
    fireEvent.click(within(li).getByRole("button", { name: "Resume now" }));
    const alert = await within(li).findByRole("alert");
    expect(alert.textContent).toContain("approve_spec");
    expect(within(list.querySelector<HTMLElement>('li[data-pause="rate_limit"]')!).queryByRole("alert")).toBeNull();
  });
});

describe("no pause in effect", () => {
  it("shows no pause list on the Floor page", async () => {
    view = { pauses: [], csrf_token: TOKEN };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(FloorPage)));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/v1/pauses")).toBe(true));
    expect(screen.queryByRole("list", { name: "Claim pauses" })).toBeNull();
  });
});
