// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { capabilitiesConfig } from "../src/core/config.js";
import { type ConfigWriterDeps, FILE_ONLY_KEYS, editConfigFile } from "../src/core/config-writer.js";
import type { SettingsBase } from "../src/core/settings.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PackEntriesStore } from "../src/packs/pack-entries.store.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { writePackApproval } from "../src/ui/packs-api.js";
import { readPlugins } from "../src/ui/plugins-api.js";
import type { ApiDeps } from "../src/ui/server.js";
import type { UiSettings } from "../src/ui/settings-api.js";
import type { PluginsView } from "../web/src/api.js";
import { en } from "../web/src/i18n/en.js";
import { cleanScanner, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// The Plugins page's actions (design 09-dashboard-app and 11-packs, 2026-11-16): Import (scan, pick, import) and Add
// (a file or folder) on each tab and empty state, Approve and Revoke on every MCP server and pack tool row, and the
// skill folder list edited through the config file writer onto a local branch with its Merge button. No Plugins text
// names a CLI command or the config file.

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage, skillFolderOf } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent; skillFolderOf(path: string): string };

const ME = "local:me@example.com" as UserId;
const AT = "2026-11-16T00:00:00.000Z";

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// The server: POST /api/v1/packs/approvals scan, import and add; GET /api/v1/plugins skill folders.

const BASE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

async function server(fileKeys: { key: string; value: string | null }[] = []) {
  const clock = new FakeClock(AT);
  const { store } = await newStore(clock);
  const editFile = Object.assign(async () => ({ ok: false as const, refusal: "not wired" }), {
    capabilities: async () => ({ skill_folders: [], tools: [], providers: [] }),
    fileKeys: () => ({ editable: fileKeys, read_only: [], plugins: [] }),
  });
  const settings: UiSettings = { base: BASE, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: async () => null, csrfToken: "settings-token", editFile };
  const pauses: UiPauses = { principal: async () => ME, authorize: async () => ({ allow: true }), csrfToken: "pack-token", log: silent, auth: new OwnerAuth(store) };
  const d: ApiDeps = { store, scanner: cleanScanner, clock, lease_ms: 300_000, health: {} as ApiDeps["health"], settings, pauses };
  const entries = new PackEntriesStore(store.db, () => clock.now().toISOString());
  return { d, pauses, store, entries };
}

/** A home with a Claude Code config holding one MCP server (with an env value) and one skill. */
function home(): string {
  const h = temp("plugins-home-");
  write(join(h, ".claude.json"), JSON.stringify({ mcpServers: { "docs-search": { command: "docs-bin", env: { DOCS_TOKEN: "value-never-sent" } }, tracker: { command: "tracker-bin" } } }));
  write(join(h, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ships.\n---\nbody\n");
  return h;
}

describe("POST /api/v1/packs/approvals: scan, import and add", () => {
  it("scan lists each found item's kind, source and name, and writes nothing", async () => {
    const s = await server();
    const r = await writePackApproval(s.d, s.pauses, { action: "scan" }, home());
    expect(r.status).toBe(200);
    const found = (r.value as { found: unknown[] }).found;
    expect(found).toContainEqual({ kind: "mcp_server", source: "claude", name: "docs-search" });
    expect(found).toContainEqual({ kind: "skill", source: "claude", name: "deploy" });
    expect(JSON.stringify(r.value)).not.toContain("value-never-sent");
    expect(await s.entries.refs("mcp_server", "docs-search")).toEqual([]);
  });

  it("import stores only the picked items of a fresh scan, as pending", async () => {
    const s = await server();
    const h = home();
    const r = await writePackApproval(s.d, s.pauses, { action: "import", items: [{ kind: "mcp_server", source: "claude", name: "docs-search" }] }, h);
    expect(r.status).toBe(200);
    expect((r.value as { lines: string[] }).lines).toEqual(["stored mcp_server docs-search from claude as pending"]);
    expect(await s.entries.refs("mcp_server", "docs-search")).toHaveLength(1);
    expect(await s.entries.refs("mcp_server", "tracker")).toEqual([]);
    expect((await writePackApproval(s.d, s.pauses, { action: "import", items: [] }, h)).status).toBe(400);
  });

  it("add stores a pack folder's descriptors, or one descriptor file alone", async () => {
    const s = await server();
    const pack = temp("plugins-pack-");
    write(join(pack, "mcp_servers", "one.json"), JSON.stringify({ name: "one", command: "one-bin" }));
    write(join(pack, "mcp_servers", "two.json"), JSON.stringify({ name: "two", command: "two-bin" }));
    const file = await writePackApproval(s.d, s.pauses, { action: "add", path: join(pack, "mcp_servers", "one.json") });
    expect(file.status).toBe(200);
    expect(await s.entries.refs("mcp_server", "one")).toHaveLength(1);
    expect(await s.entries.refs("mcp_server", "two")).toEqual([]);
    const folder = await writePackApproval(s.d, s.pauses, { action: "add", path: pack });
    expect((folder.value as { lines: string[] }).lines).toEqual([expect.stringMatching(/^already added MCP server one/), expect.stringMatching(/^stored MCP server two/)]);
    expect((await writePackApproval(s.d, s.pauses, { action: "add", path: join(pack, "missing") })).status).toBe(404);
    expect((await writePackApproval(s.d, s.pauses, { action: "add", path: "relative/path" })).status).toBe(400);
  });

  it("refuses import and add with no factory user, before any write", async () => {
    const s = await server();
    const pack = temp("plugins-pack-");
    write(join(pack, "mcp_servers", "one.json"), JSON.stringify({ name: "one", command: "one-bin" }));
    const nobody = { ...s.pauses, principal: async () => null };
    expect((await writePackApproval(s.d, nobody, { action: "add", path: pack })).status).toBe(403);
    expect(await s.entries.refs("mcp_server", "one")).toEqual([]);
  });
});

describe("GET /api/v1/plugins: skill folders", () => {
  it("with no skill folder configured the list is empty, with no error", async () => {
    const s = await server([{ key: "capabilities.skill_folders", value: null }]);
    const r = await readPlugins(s.d);
    expect(r.status).toBe(200);
    expect(r.value).toMatchObject({ skill_folders: [], settings_token: "settings-token" });
  });

  it("lists the configured folders as the file holds them", async () => {
    const s = await server([{ key: "capabilities.skill_folders", value: '["skills","/home/me/.claude/skills"]' }]);
    expect((await readPlugins(s.d)).value).toMatchObject({ skill_folders: ["skills", "/home/me/.claude/skills"] });
  });
});

describe("the config file writer: capabilities.skill_folders", () => {
  it("writes the list on a new local branch, and the written file reads it back", async () => {
    const FILE = "factory.config.json";
    const base = '{\n  "repo": { "owner": "o", "name": "r" }\n}\n';
    const commits: { branch: string; content: string }[] = [];
    let edited = base;
    const deps: ConfigWriterDeps = {
      store: { fileConfigEdit: async () => ({ item: {} as never, change: {} as never, created: true }) },
      sandbox: {
        readLocalFile: async () => ({ commit: "c0", text: base }),
        commitNewBranch: async (c) => {
          commits.push({ branch: c.branch, content: c.content });
          edited = c.content;
          return { created: true, sha: "c1" };
        },
      },
      repo: { path: "/repo", base_branch: "main" }, file: FILE, branch_prefix: "factory/",
      identity: { name: "factory", email: "factory@example.com" }, actor: ME, project: async () => "local:o/r",
      newId: () => "wi_1" as WorkItemId, check: async () => null,
    };
    expect(FILE_ONLY_KEYS).toContain("capabilities.skill_folders");
    const r = await editConfigFile(deps, { key: "capabilities.skill_folders", value: JSON.stringify(["skills", "/tmp/more-skills"]), confirm: false });
    expect(r).toMatchObject({ ok: true, branch: "factory/wi_1", old_value: null, new_value: '["skills","/tmp/more-skills"]' });
    expect(commits.map((c) => c.branch)).toEqual(["factory/wi_1"]);
    // Read back: the loader's reader sees the list, and the repo block is as it was.
    expect(capabilitiesConfig(JSON.parse(edited)).skill_folders).toEqual(["skills", "/tmp/more-skills"]);
    expect(JSON.parse(edited).repo).toEqual({ owner: "o", name: "r" });
    // A removal writes the shorter list the same way.
    const again: ConfigWriterDeps = { ...deps, sandbox: { ...deps.sandbox, readLocalFile: async () => ({ commit: "c1", text: edited }) }, newId: () => "wi_2" as WorkItemId };
    expect(await editConfigFile(again, { key: "capabilities.skill_folders", value: '["skills"]', confirm: false })).toMatchObject({ ok: true, old_value: '["skills","/tmp/more-skills"]' });
    expect(capabilitiesConfig(JSON.parse(edited)).skill_folders).toEqual(["skills"]);
  });
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

const FOUND = [
  { kind: "mcp_server", source: "claude", name: "docs-search" },
  { kind: "skill", source: "codex", name: "deploy" },
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
      if (body.action === "scan") return reply({ found: FOUND, errors: [] });
      if (body.action === "import") return reply({ lines: ["stored mcp_server docs-search from claude as pending"], refused: false });
      if (body.action === "add") return reply({ lines: ["stored MCP server one as pending"], refused: false });
      return reply({ line: `${String(body.action)}d ${String(body.name)}` });
    }
    if (url === "/api/v1/plugins") return reply(view);
    return new Response("{}", { status: 404 });
  }));
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
}

const rowsOf = (table: HTMLElement) => [...table.querySelectorAll("tbody > tr")] as HTMLElement[];
const dialog = () => screen.getByRole("dialog");

/** Opens Import, unpicks the skill, and imports: the post names only the picked item. */
async function importOne() {
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await within(dialog()).findByRole("switch", { name: "Import Skill deploy from codex" });
  expect(posts.at(-1)!.body).toEqual({ action: "scan" });
  fireEvent.click(within(dialog()).getByRole("switch", { name: "Import Skill deploy from codex" }));
  fireEvent.click(within(dialog()).getByRole("button", { name: "Import" }));
  await waitFor(() => expect(posts.at(-1)!.body).toEqual({ action: "import", items: [FOUND[0]] }));
  expect(await screen.findByText("stored mcp_server docs-search from claude as pending")).toBeTruthy();
}

describe("Plugins page actions", () => {
  it("each tab has Import, which scans, lets the owner pick and imports the picked items", async () => {
    show();
    await screen.findByRole("table", { name: "MCP" });
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await importOne();
    }
  });

  it("each empty state has Import too", async () => {
    view = { ...FULL, mcp: [], skills: [], tools: [], skill_folders: [] };
    show();
    await screen.findByText(/No MCP server yet\./);
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      await importOne();
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
