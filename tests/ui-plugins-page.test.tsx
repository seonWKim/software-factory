// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesView, PluginsView } from "../web/src/api.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent };

// The Plugins page (design 09-dashboard-app, 2026-11-16): MCP, Skills and Tools tabs over GET /api/v1/plugins and a
// Models tab (the provider entries, moved from Settings) over GET /api/v1/settings/capabilities, the selected tab in the
// URL, a search box and an empty state per list tab, and Approve or Revoke as POST /api/v1/packs/approvals.

const AT = "2026-11-15T00:00:00.000Z";
const LONG = `very-long-mcp-server-name-${"x".repeat(80)}`;

// The capability list's read: a skill, a tool and a provider entry; the Models tab shows only the provider entries.
const capabilities: CapabilitiesView = {
  as_of: AT,
  roles: ["triage", "implement", "review", "update", "resolve", "manual"],
  capabilities: [
    { kind: "skill", id: "skill:deploy", name: "deploy", detail: "/home/me/.claude/skills", enabled: true, roles: [], last_used: null },
    { kind: "tool", id: "tool:forge.preflight", name: "forge.preflight", detail: "Read-only check.", enabled: true, roles: ["review", "triage"], last_used: AT, read_only: true },
    {
      kind: "provider", id: "runner:claude-code", name: "runner:claude-code", detail: null, enabled: true, roles: ["triage", "implement", "review", "resolve"], last_used: AT,
      models: [{ class: "cheap", model: "haiku" }, { class: "standard", model: "sonnet" }, { class: "strong", model: "opus" }],
    },
  ],
};
let capabilityReads = 0;

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
  capabilityReads = 0;
  history.replaceState(null, "", "/app/plugins");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return new Response(JSON.stringify({ line: "approved MCP server docs-search" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/v1/settings/capabilities") return (capabilityReads++, new Response(JSON.stringify(capabilities), { status: 200, headers: { "content-type": "application/json" } }));
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
  it("pending: keeps the Plugin list placeholder and reads again until the stored list arrives, then shows its as-of line", async () => {
    view = { as_of: null, pending: true, failed: false, csrf_token: null } as unknown as PluginsView;
    show();
    await waitFor(() => expect(screen.getByLabelText("Plugin list").getAttribute("aria-busy")).toBe("true"));
    view = { ...FULL, as_of: new Date().toISOString() };
    await waitFor(() => expect(screen.getByText("docs-search")).toBeTruthy(), { timeout: 3_000 });
    expect(screen.getByText(/^Listed /)).toBeTruthy();
  });

  it("failed with no good list: the error with Retry, which reads again", async () => {
    view = { as_of: null, pending: false, failed: true, csrf_token: null } as unknown as PluginsView;
    show();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert").textContent).toContain("Plugin list: the last refresh failed");
    view = FULL;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("docs-search")).toBeTruthy());
  });

  it("has MCP, Skills, Tools and Models tabs; MCP is selected by default and lists each server's source, status and action", async () => {
    show();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["MCP", "Skills", "Tools", "Models"]);
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

  it("the Models tab lists each provider entry with its state, roles and last use, read once, with no search box and no link to the Plugins page", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    expect(capabilityReads).toBe(0);
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(location.search).toBe("?tab=models");
    expect(selected()).toBe("Models");
    const table = await screen.findByRole("table", { name: "Models" });
    expect(rowsOf(table).map((r) => r.querySelector("td")!.textContent)).toEqual(["runner:claude-codecheap: haiku · standard: sonnet · strong: opus"]);
    expect(rowsOf(table)[0]!.textContent).toContain("Enabled");
    expect(rowsOf(table)[0]!.textContent).toContain("triage, implement, review, resolve");
    expect(rowsOf(table)[0]!.textContent).toContain("ago");
    const section = screen.getByRole("region", { name: "Models" });
    expect(section.textContent).not.toContain("forge.preflight");
    expect(section.textContent).not.toContain("deploy");
    expect(within(section).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(capabilityReads).toBe(1);
  });

  it("opening /app/plugins?tab=models selects Models", async () => {
    history.replaceState(null, "", "/app/plugins?tab=models");
    show();
    await screen.findByRole("table", { name: "Models" });
    expect(selected()).toBe("Models");
  });

  it("Approve and Revoke post to /api/v1/packs/approvals with the token, and the list is read again", async () => {
    show();
    const table = await screen.findByRole("table", { name: "MCP" });
    fireEvent.click(within(rowsOf(table)[0]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/packs/approvals");
    expect((posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe("pack-token");
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: "approve", kind: "mcp_server", name: "docs-search" });
    expect(await screen.findByText("approved MCP server docs-search")).toBeTruthy();
    fireEvent.click(within(rowsOf(await screen.findByRole("table", { name: "MCP" }))[1]!).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(String(posts[1]!.init.body))).toEqual({ action: "revoke", kind: "mcp_server", name: "tracker" });
  });

  it("without the approvals route the buttons are off and the page names no CLI command", async () => {
    view = { ...FULL, csrf_token: null };
    show();
    const table = await screen.findByRole("table", { name: "MCP" });
    expect((within(rowsOf(table)[0]!).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Import…" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(rows[1]!.textContent).toContain("Not used by any agent");
    expect(rows[2]!.textContent).toContain("Can change things · not given to any agent");
  });

  it("the header says what the page lists and what a pack is", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    expect(document.body.textContent).toContain("Extra abilities the agents can use: connected apps (MCP), skills and tools. A pack is a folder of them that you add.");
  });

  it("a broker tool's row shows its description as one plain sentence", async () => {
    const [local] = new LocalToolBroker({} as never).allTools();
    const github = new GitHubToolBroker({} as never).allTools().find((d) => d.name === local!.name)!;
    for (const d of [local!, github]) {
      expect(d.description).toMatch(/^[^.]+\.$/);
      expect(d.description).not.toMatch(/\b(HEAD|outbound)\b/);
    }
    view = { ...FULL, tools: [{ name: local!.name, description: local!.description, read_only: false, origin: "broker", roles: [], last_used: null }] };
    history.replaceState(null, "", "/app/plugins?tab=tools");
    show();
    const [row] = rowsOf(await screen.findByRole("table", { name: "Tools" }));
    expect(row!.textContent).toContain("Saves the run's latest commit as its branch in this repository, without sending it anywhere.");
    expect(row!.textContent).toContain("Can change things");
  });

  it("the Skills tab shows each row's source (Folder, Claude Code or Codex), an imported row's path, and a missing or changed file", async () => {
    const imported = (name: string, source: "claude" | "codex", state: "ok" | "missing" | "changed") =>
      ({ name, folder: `/home/me/.${source}/skills`, description: null, roles: [], last_used: null, source, path: `/home/me/.${source}/skills/${name}/SKILL.md`, state });
    view = { ...FULL, skills: [...FULL.skills, imported("review", "claude", "ok"), imported("ship", "codex", "missing"), imported("old", "claude", "changed"), imported("long-skill-name", "claude", "ok")] };
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    const rows = rowsOf(await screen.findByRole("table", { name: "Skills" }));
    const cells = (r: HTMLElement) => [...r.querySelectorAll("td")].map((td) => td.textContent);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining(["Source", "Path"]));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Folder");
    // A row with no SKILL.md path shows its folder in the Path cell; a long path is cut in the middle, in full in its Copy button.
    expect(rows[0]!.textContent).toContain("/home/me/.claude/skills");
    expect(cells(rows[4]!).join(" ")).toMatch(/…s\/long-skill-name\/SKILL\.md/);
    expect(within(rows[4]!).getByRole("button", { name: "Copy Path" })).toBeTruthy();
    // Empty Roles and Last used are a muted dash with their reason as its name.
    expect(within(rows[1]!).getByLabelText("Not used by any agent").textContent).toBe("—");
    expect(within(rows[1]!).getByLabelText("Not in recent runs").textContent).toBe("—");
    expect(rows[1]!.textContent).toContain("Claude Code");
    expect(rows[1]!.textContent).toContain("/home/me/.claude/skills/review/SKILL.md");
    expect(rows[2]!.textContent).toContain("Codex");
    expect(rows[2]!.textContent).toContain("File missing");
    expect(rows[3]!.textContent).toContain("Changed since import");
    expect(rows[1]!.textContent).not.toMatch(/missing|Changed/);
  });

  it("at phone width a Skills card's path wraps with Copy beside it; the full path is in its tooltip and its Copy value", async () => {
    vi.stubGlobal("innerWidth", 390);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const path = "/Users/someone/projects/example/.claude/skills/humanize/SKILL.md";
    view = { ...FULL, skills: [{ name: "humanize", folder: "/Users/someone/projects/example/.claude/skills", description: null, roles: [], last_used: null, source: "claude", path, state: "ok" }] };
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    const cards = await screen.findByRole("list", { name: "Skills" });
    const copy = within(cards).getByRole("button", { name: "Copy Path" });
    const text = cards.querySelector<HTMLElement>(".font-mono")!;
    // Copy sits in the same row as the path, and the row may wrap below `sm` (nowrap only from `sm` up).
    const row = copy.parentElement!;
    expect(row.contains(text)).toBe(true);
    expect(row.className.split(/\s+/)).not.toContain("whitespace-nowrap");
    expect(row.className.split(/\s+/)).toContain("sm:whitespace-nowrap");
    expect(text.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "break-all"]));
    expect(text.parentElement!.className.split(/\s+/)).toContain("min-w-0");
    fireEvent.focus(text);
    expect(within(cards).getByRole("tooltip").textContent).toBe(path);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  });

  it("an action's notice shows only on the tab it came from, and a tab change clears it", async () => {
    show();
    const table = await screen.findByRole("table", { name: "MCP" });
    fireEvent.click(within(rowsOf(table)[0]!).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("approved MCP server docs-search")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await screen.findByRole("table", { name: "Skills" });
    expect(screen.queryByText("approved MCP server docs-search")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    await screen.findByRole("table", { name: "MCP" });
    expect(screen.queryByText("approved MCP server docs-search")).toBeNull();
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
      expect(screen.getByRole("button", { name: "Import…" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
      for (const gone of ["factory pack", "factory.config.json", "by hand"]) expect(document.body.textContent, `${tab}: ${gone}`).not.toContain(gone);
    }
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(document.body.textContent).toContain("No skill yet.");
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(document.body.textContent).toContain("No tool yet.");
  });
});
