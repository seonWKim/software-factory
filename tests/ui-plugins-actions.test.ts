// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../web/src/api.js";
import { en } from "../web/src/i18n/en.js";

// The Plugins page's actions (design 09-dashboard-app and 11-packs, 2026-11-16): Import (scan, pick, import) and Add
// (a file or folder) on each tab and empty state, Approve and Revoke on every MCP server and pack tool row, and the
// skill folder list edited through the config file writer onto a local branch with its Merge button. No Plugins text
// names a CLI command or the config file. This file runs in jsdom, which cannot bundle node:sqlite, so it imports no
// store; the server side is in plugins-server-actions.test.ts.

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage, skillFolderOf } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent; skillFolderOf(path: string): string };

const AT = "2026-11-16T00:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------------
// The page.

let view: PluginsView;
let posts: { url: string; body: Record<string, unknown> }[] = [];

const FULL: PluginsView = {
  as_of: AT,
  csrf_token: "pack-token",
  mcp: [
    { name: "docs-search", description: "Searches the team docs.", source: "pack", status: "waiting" },
    { name: "tracker", description: "Reads the issue tracker.", source: "pack", status: "approved" },
    { name: "old", description: null, source: "pack", status: "off" },
  ],
  skills: [{ name: "deploy", folder: "/home/me/skills", description: "Ships a release.", roles: [], last_used: null }],
  tools: [
    { name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker", roles: [], last_used: null },
    { name: "pack:tool:docs-reader", description: "Reads the docs.", read_only: true, origin: "pack", roles: [], last_used: null },
    { name: "pack:tool:writer", description: "Writes the docs.", read_only: false, origin: "pack", roles: [], last_used: null },
  ],
  tool_status: { "pack:tool:docs-reader": "waiting", "pack:tool:writer": "approved" },
  skill_folders: ["/home/me/skills"],
  settings_token: "settings-token",
};

/** GET /api/v1/plugins/import: one MCP server and one skill the user configs hold. */
const FOUND = [
  { kind: "mcp_server", source: "claude", name: "docs-search", path: null, env_keys: [], header_keys: [], imported: false, refused: [] },
  { kind: "skill", source: "codex", name: "deploy", path: "/home/me/.codex/skills/deploy/SKILL.md", env_keys: [], header_keys: [], imported: false, refused: [] },
];

const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  view = FULL;
  posts = [];
  history.replaceState(null, "", "/app/plugins");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (url === "/api/v1/settings") return reply({ ok: true, lines: ["filed"], item: "wi_1", branch: "factory/wi_1" });
      if (url === "/api/v1/plugins/import") {
        const items = body.items as { kind: string; source: string; name: string }[];
        return reply({ results: items.map((i) => ({ ...i, outcome: "stored", rules: [], line: `stored ${i.kind} ${i.name}` })) });
      }
      if (body.action === "add") return reply({ lines: ["stored MCP server one as pending"], refused: false });
      return reply({ line: `${String(body.action)}d ${String(body.name)}` });
    }
    if (url === "/api/v1/plugins") return reply(view);
    if (url === "/api/v1/plugins/import") return reply({ as_of: AT, items: FOUND, errors: [] });
    return new Response("{}", { status: 404 });
  }));
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
}

const rowsOf = (table: HTMLElement) => [...table.querySelectorAll("tbody > tr")] as HTMLElement[];
const dialog = () => screen.getByRole("dialog");

/**
 * Opens Import, which lists what the scan found of the tab's kind, picks the one item, and imports it; the dialog
 * stays open with the item's result until Close.
 */
async function importOne(tab: string) {
  const [item, label] = tab === "Skills" ? [FOUND[1]!, "Import deploy from Codex"] : [FOUND[0]!, "Import docs-search from Claude Code"];
  fireEvent.click(screen.getByRole("button", { name: "Import…" }));
  fireEvent.click(await within(dialog()).findByRole("checkbox", { name: label }));
  fireEvent.click(within(dialog()).getByRole("button", { name: "Import 1" }));
  await waitFor(() => expect(posts.at(-1)).toEqual({ url: "/api/v1/plugins/import", body: { items: [{ kind: item.kind, source: item.source, name: item.name }] } }));
  const results = await within(dialog()).findByRole("list", { name: "Import results" });
  expect(results.textContent).toContain(`${item.name}`);
  expect(results.textContent).toContain("Stored");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Plugins page actions", () => {
  it("each tab has Import, which scans, lets the owner pick and imports the picked items", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await importOne(tab);
    }
  });

  it("each empty state has Import too", async () => {
    view = { ...FULL, mcp: [], skills: [], tools: [], skill_folders: [] };
    show();
    await screen.findByText(/No MCP server yet\./);
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await importOne(tab);
    }
  });

  it("Add on MCP and Tools sends the picked file or folder as a pack add", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    for (const [tab, path] of [["MCP", "/home/me/packs/docs"], ["Tools", "/home/me/packs/docs/tools/reader.json"]] as const) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.change(within(dialog()).getByLabelText("Path to a file or folder"), { target: { value: path } });
      fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(posts.at(-1)).toEqual({ url: "/api/v1/packs/approvals", body: { action: "add", path } }));
      expect(await screen.findByText("stored MCP server one as pending")).toBeTruthy();
    }
  });

  it("Add on Skills adds the picked folder, or a skill file's folder, through the config file writer, then shows the Merge button", async () => {
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    await screen.findByRole("table", { name: "Skills" });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(within(dialog()).getByLabelText("Path to a file or folder"), { target: { value: "/home/me/more/review/SKILL.md" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({
      url: "/api/v1/settings",
      body: { action: "edit-file", key: "capabilities.skill_folders", value: JSON.stringify(["/home/me/skills", "/home/me/more"]), confirm: false },
    }));
    expect(await screen.findByText("factory/wi_1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(skillFolderOf("/a/b/")).toBe("/a/b");
    expect(skillFolderOf("/a/b/notes.md")).toBe("/a/b");
  });

  it("Remove takes a skill folder out of the list through the config file writer", async () => {
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    const list = await screen.findByRole("list", { name: "Skill folders" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove the skill folder /home/me/skills" }));
    await waitFor(() => expect(posts.at(-1)!.body).toEqual({ action: "edit-file", key: "capabilities.skill_folders", value: "[]", confirm: false }));
    expect(await screen.findByText("factory/wi_1")).toBeTruthy();
  });

  it("with no skill folder configured the folder list is empty and no error shows", async () => {
    view = { ...FULL, skills: [], skill_folders: [] };
    history.replaceState(null, "", "/app/plugins?tab=skills");
    show();
    const list = await screen.findByRole("list", { name: "Skill folders" });
    expect(within(list).queryAllByRole("listitem")).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Approve and Revoke work on every MCP server and pack tool row", async () => {
    show();
    const mcp = await screen.findByRole("table", { name: "MCP" });
    const expected = [["approve", "docs-search"], ["revoke", "tracker"], ["approve", "old"]];
    for (const [i, [action, name]] of expected.entries()) {
      const button = within(rowsOf(await screen.findByRole("table", { name: "MCP" }))[i]!).getByRole("button", { name: action === "approve" ? "Approve" : "Revoke" });
      fireEvent.click(button);
      await waitFor(() => expect(posts.at(-1)!.body).toEqual({ action, kind: "mcp_server", name }));
    }
    expect(mcp).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    const tools = rowsOf(await screen.findByRole("table", { name: "Tools" }));
    expect(within(tools[0]!).queryByRole("button", { name: /Approve|Revoke/ })).toBeNull();
    fireEvent.click(within(tools[1]!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts.at(-1)!.body).toEqual({ action: "approve", kind: "tool", name: "docs-reader" }));
    fireEvent.click(within(rowsOf(await screen.findByRole("table", { name: "Tools" }))[2]!).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(posts.at(-1)!.body).toEqual({ action: "revoke", kind: "tool", name: "writer" }));
  });

  it("\"Approve from the CLI\" is gone from the page and the catalog, and no Plugins string names a CLI command or the config file", async () => {
    view = { ...FULL, csrf_token: null };
    show();
    await screen.findByRole("table", { name: "MCP" });
    expect(document.body.textContent).not.toContain("Approve from the CLI");
    for (const button of screen.getAllByRole("button", { name: /Approve|Revoke/ })) expect(button.getAttribute("title") ?? "").not.toContain("CLI");
    const plugins = Object.entries(en).filter(([k]) => k.startsWith("plugins."));
    expect(plugins.length).toBeGreaterThan(0);
    for (const [k, text] of Object.entries(en)) expect(text, k).not.toContain("Approve from the CLI");
    for (const [k, text] of plugins) {
      for (const gone of ["factory.config.json", "factory pack", "by hand"]) expect(text, k).not.toContain(gone);
    }
  });
});
