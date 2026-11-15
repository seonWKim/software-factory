// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent };

// The Plugins page (design 09-dashboard-app, 2026-11-15): MCP, Skills and Tools tabs over GET /api/v1/plugins, the
// selected tab in the URL, a search box and an empty state per tab, and Approve or Revoke as POST /api/v1/packs/approvals.

const AT = "2026-11-15T00:00:00.000Z";
const LONG = `very-long-mcp-server-name-${"x".repeat(80)}`;

let view: PluginsView;
let posts: { url: string; init: RequestInit }[] = [];

const FULL: PluginsView = {
  as_of: AT,
  csrf_token: "pack-token",
  mcp: [
    { name: "docs-search", description: "Searches the team docs.", source: "pack", status: "waiting" },
    { name: "tracker", description: "Reads the issue tracker.", source: "pack", status: "approved" },
    { name: LONG, description: null, source: "pack", status: "off" },
  ],
  skills: [{ name: "deploy", folder: "/home/me/.claude/skills", description: "Ships a release.", roles: [], last_used: null }],
  tools: [
    { name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker", roles: ["triage"], last_used: AT },
    { name: "pack:tool:docs-reader", description: "Reads the docs.", read_only: true, origin: "pack", roles: [], last_used: null },
    { name: "git.store_branch", description: "Store a branch.", read_only: false, origin: "broker", roles: [], last_used: null },
  ],
};

beforeEach(() => {
  view = FULL;
  posts = [];
  history.replaceState(null, "", "/app/plugins");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return new Response(JSON.stringify({ line: "approved MCP server docs-search (description_hash abc)" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/v1/plugins") return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
}

const rowsOf = (table: HTMLElement) => [...table.querySelectorAll("tbody > tr")] as HTMLElement[];
const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!.textContent;

describe("Plugins page", () => {
  it("has MCP, Skills and Tools tabs; MCP is selected by default and lists each server's source, status and action", async () => {
    show();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["MCP", "Skills", "Tools"]);
    const table = await screen.findByRole("table", { name: "MCP" });
    expect(selected()).toBe("MCP");
    const rows = rowsOf(table);
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual(["docs-searchSearches the team docs.", "trackerReads the issue tracker.", LONG]);
    expect(rows[0]!.textContent).toContain("Pack");
    expect(rows[0]!.textContent).toContain("Waiting");
    expect(within(rows[0]!).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(rows[1]!.textContent).toContain("Approved");
    expect(within(rows[1]!).getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(rows[2]!.textContent).toContain("Off");
    expect(within(rows[2]!).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("Approve and Revoke post to /api/v1/packs/approvals with the token, and the list is read again", async () => {
    show();
    const table = await screen.findByRole("table", { name: "MCP" });
    fireEvent.click(within(rowsOf(table)[0]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/packs/approvals");
    expect((posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe("pack-token");
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: "approve", kind: "mcp_server", name: "docs-search" });
    expect(await screen.findByText("approved MCP server docs-search (description_hash abc)")).toBeTruthy();
    fireEvent.click(within(rowsOf(await screen.findByRole("table", { name: "MCP" }))[1]!).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(String(posts[1]!.init.body))).toEqual({ action: "revoke", kind: "mcp_server", name: "tracker" });
  });

  it("without the approvals route the buttons are off and the page names no CLI command", async () => {
    view = { ...FULL, csrf_token: null };
    show();
    const table = await screen.findByRole("table", { name: "MCP" });
    expect((within(rowsOf(table)[0]!).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("factory pack");
    expect(document.body.textContent).not.toContain("Approve from the CLI");
  });

  it("opening /app/plugins?tab=skills selects Skills, and choosing a tab writes it to the URL", async () => {
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    const table = await screen.findByRole("table", { name: "Skills" });
    expect(selected()).toBe("Skills");
    expect(rowsOf(table)[0]!.textContent).toContain("Ships a release.");
    expect(rowsOf(table)[0]!.textContent).toContain("/home/me/.claude/skills");
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(location.search).toBe("?tab=tools");
    const tools = await screen.findByRole("table", { name: "Tools" });
    const rows = rowsOf(tools);
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual(["forge.preflightRead-only check.", "pack:tool:docs-readerReads the docs.", "git.store_branchStore a branch."]);
    expect(rows[0]!.textContent).toContain("Broker");
    expect(rows[0]!.textContent).toContain("triage");
    expect(rows[0]!.textContent).toContain("ago");
    expect(rows[1]!.textContent).toContain("Pack");
    expect(rows[2]!.textContent).toContain("Writes; never granted");
  });

  it("the search box filters rows by name and description, and says when nothing matches", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    const search = screen.getByRole("searchbox", { name: "Search by name or description" });
    fireEvent.change(search, { target: { value: "tracker" } });
    expect(rowsOf(screen.getByRole("table", { name: "MCP" })).map((r) => r.querySelector("td")!.textContent)).toEqual(["trackerReads the issue tracker."]);
    fireEvent.change(search, { target: { value: "team docs" } });
    expect(rowsOf(screen.getByRole("table", { name: "MCP" })).map((r) => r.querySelector("td")!.textContent)).toEqual(["docs-searchSearches the team docs."]);
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(screen.queryByRole("table", { name: "MCP" })).toBeNull();
    expect(document.body.textContent).toContain('Nothing matches "nothing-like-this".');
  });

  it("each tab's empty state says how to add one, with Import and Add, and names no command or config file", async () => {
    view = { ...FULL, mcp: [], skills: [], tools: [] };
    show();
    await waitFor(() => expect(document.body.textContent).toContain("No MCP server yet."));
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
      for (const gone of ["factory pack", "factory.config.json", "by hand"]) expect(document.body.textContent, `${tab}: ${gone}`).not.toContain(gone);
    }
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(document.body.textContent).toContain("No skill yet.");
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(document.body.textContent).toContain("No tool yet.");
  });
});
