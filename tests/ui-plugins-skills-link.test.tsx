// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent };

// The Skills tab links a row to evals/<key> when its folder joined with its name is in GET /api/v1/evals.

const AT = "2026-11-15T00:00:00.000Z";
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const PLUGINS = {
  as_of: AT,
  csrf_token: "t",
  mcp: [],
  tools: [],
  skills: [
    { name: "tests-first", folder: "skills", description: null, roles: [], last_used: null },
    { name: "review-plan", folder: "skills", description: null, roles: [], last_used: null },
  ],
};

beforeEach(() => {
  history.replaceState(null, "", "/app/plugins?tab=skills");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/plugins") return json(PLUGINS);
    if (url === "/api/v1/evals") return json({ skills: ["skills/tests-first", "skills/review-plan/SKILL.md"] });
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plugins Skills tab eval links", () => {
  it("links a row whose key has a suite and leaves the others plain", async () => {
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(PluginsPage)));
    const link = await screen.findByRole("link", { name: "tests-first" });
    expect(link.getAttribute("href")).toBe(`/app/evals/${encodeURIComponent("skills/tests-first")}`);
    expect(screen.getByText("review-plan").closest("a")).toBeNull();
  });
});
