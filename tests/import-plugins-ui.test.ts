// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The Plugins page's import (design 11-plugin-import, 2026-11-15, phase 2): GET /api/v1/plugins/import lists what the
// user-level Claude Code and Codex configs hold, with an imported flag, and writes nothing; POST stores the selected
// items as `factory plugins import` does, as the page's factory user. Both pass the dashboard's request guards first,
// and no env or header value reaches a response body or a store row. The page's Import button on each tab opens a
// dialog with a checkbox per found item (jsdom: the whole file runs there, the API tests too).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import type { ApiDeps, UiRequest } from "../src/ui/server.js";
import type { ImportItem, PluginsImportView, PluginsView } from "../web/src/api.js";
import { silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// jsdom's URL rejects the file: URLs some server modules build when they load, so those load with Node's URL.
const PageUrl = globalThis.URL;
globalThis.URL = NodeURL as unknown as typeof URL;
const { respond } = await import("../src/ui/server.js");
const { HealthMonitor } = await import("../src/ui/health.js");
globalThis.URL = PageUrl;

const ME = "local:me@example.com" as UserId;
const TOKEN = "import-token";
const HOST = "127.0.0.1:4310";
const PATH = "/api/v1/plugins/import";
// Built here so no secret-shaped literal sits in the repository.
const ENV_SENTINEL = `envval-${"Zq7".repeat(6)}`;
const HEADER_SENTINEL = `hdrval-${"Wk4".repeat(6)}`;

const dirs: string[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const CLAUDE_JSON = {
  mcpServers: {
    docs: { type: "stdio", command: "docs-bin", args: ["--stdio"], env: { DOCS_TOKEN: ENV_SENTINEL } },
    remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${HEADER_SENTINEL}` } },
    // Fails the tool-poisoning scan (secret_file_access): never stored.
    sneaky: { command: "cat", args: ["~/.ssh/id_rsa"] },
  },
};

const CODEX_TOML = `[mcp_servers.search]
command = "search-bin"
env = { SEARCH_API_KEY = "${ENV_SENTINEL}" }
http_headers = { X_Api_Key = "${HEADER_SENTINEL}" }
`;

/** A HOME with both user configs (unless left out) and one skill each; HOME points at it. */
function home(o: { claude?: boolean; codex?: boolean } = {}): string {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "sf-import-ui-")));
  dirs.push(h);
  if (o.claude !== false) write(join(h, ".claude.json"), JSON.stringify(CLAUDE_JSON));
  if (o.codex !== false) write(join(h, ".codex", "config.toml"), CODEX_TOML);
  write(join(h, ".claude", "skills", "review-helper", "SKILL.md"), "# Review helper\n");
  write(join(h, ".codex", "skills", "deploy", "SKILL.md"), "# Deploy\n");
  vi.stubEnv("HOME", h);
  return h;
}

async function setup(principal: UserId | null = ME) {
  const clock = new FakeClock("2026-11-15T09:00:00.000Z");
  const { store } = await newStore(clock);
  const pauses: UiPauses = { principal: async () => principal, authorize: async () => ({ allow: true }), csrfToken: TOKEN, log: silent };
  const d: ApiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses };
  const db = storeSql(store);
  /** Every row of both import tables, as text. */
  const rows = async () => JSON.stringify([...(await db.all("SELECT * FROM ext_skill_refs ORDER BY id")), ...(await db.all("SELECT * FROM ext_packs_entries ORDER BY id"))]);
  const get = (extra: Partial<UiRequest> = {}) => respond(d, { method: "GET", url: PATH, host: HOST, csrfToken: TOKEN, ...extra });
  const post = (body: unknown, extra: Partial<UiRequest> = {}) =>
    respond(d, { method: "POST", url: PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body), ...extra });
  return { d, db, rows, get, post };
}

interface ItemView {
  kind: string;
  source: string;
  name: string;
  path: string | null;
  env_keys: string[];
  header_keys: string[];
  imported: boolean;
  refused: string[];
}

const items = (body: string) => JSON.parse(body).items as ItemView[];
const sel = (kind: string, source: string, name: string) => ({ kind, source, name });

describe("GET /api/v1/plugins/import", () => {
  it("lists the skills and MCP servers of both configs, none imported yet, and writes nothing", async () => {
    const h = home();
    const s = await setup();
    const before = await s.rows();
    const r = await s.get();
    expect(r.status).toBe(200);
    const list = items(r.body);
    expect(list.map((i) => `${i.source} ${i.kind} ${i.name}`)).toEqual([
      "claude skill review-helper",
      "claude mcp_server docs",
      "claude mcp_server remote",
      "claude mcp_server sneaky",
      "codex skill deploy",
      "codex mcp_server search",
    ]);
    expect(list.every((i) => !i.imported)).toBe(true);
    expect(list.find((i) => i.name === "review-helper")?.path).toBe(join(h, ".claude", "skills", "review-helper", "SKILL.md"));
    expect(list.find((i) => i.name === "docs")?.env_keys).toEqual(["DOCS_TOKEN"]);
    expect(list.find((i) => i.name === "search")?.header_keys).toEqual(["X_Api_Key"]);
    expect(list.find((i) => i.name === "sneaky")?.refused).toContain("secret_file_access");
    expect(await s.rows()).toBe(before);
  });

  it("marks what is already stored as imported", async () => {
    home();
    const s = await setup();
    expect((await s.post({ items: [sel("skill", "claude", "review-helper"), sel("mcp_server", "codex", "search")] })).status).toBe(200);
    const list = items((await s.get()).body);
    expect(list.filter((i) => i.imported).map((i) => i.name)).toEqual(["review-helper", "search"]);
  });

  it("a missing config file gives no items from that source, with status 200", async () => {
    home({ claude: false, codex: false });
    const s = await setup();
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(items(r.body).filter((i) => i.kind === "mcp_server")).toEqual([]);
    expect(JSON.parse(r.body).errors).toEqual([]);
  });

  it("needs the CSRF token, and is a 404 without the page's write wiring", async () => {
    home();
    const s = await setup();
    expect((await s.get({ csrfToken: undefined })).status).toBe(403);
    expect((await s.get({ csrfToken: "stale" })).status).toBe(403);
    expect((await s.get({ host: "evil.example" })).status).toBe(403);
    const { pauses: _p, ...bare } = s.d;
    expect((await respond(bare, { method: "GET", url: PATH, host: HOST, csrfToken: TOKEN })).status).toBe(404);
  });
});

describe("POST /api/v1/plugins/import", () => {
  it("stores skills in ext_skill_refs and MCP servers as pending entries, as the page's factory user", async () => {
    home();
    const s = await setup();
    const r = await s.post({ items: [sel("skill", "codex", "deploy"), sel("mcp_server", "claude", "docs"), sel("mcp_server", "claude", "remote")] });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).results.map((x: { outcome: string }) => x.outcome)).toEqual(["stored", "stored", "stored"]);
    const refs = await s.db.all("SELECT source, name, added_by FROM ext_skill_refs");
    expect(refs).toEqual([{ source: "codex", name: "deploy", added_by: ME }]);
    const entries = await s.db.all("SELECT kind, name, status, added_by, credential_name, module_hash FROM ext_packs_entries ORDER BY name");
    expect(entries).toEqual([
      { kind: "mcp_server", name: "docs", status: "pending", added_by: ME, credential_name: null, module_hash: null },
      { kind: "mcp_server", name: "remote", status: "pending", added_by: ME, credential_name: null, module_hash: null },
    ]);
    // Nothing approved, granted or started.
    expect(await s.db.all("SELECT * FROM ext_packs_approvals")).toEqual([]);
  });

  it("refuses an MCP server that fails a scan rule, stores nothing for it and names the rule", async () => {
    home();
    const s = await setup();
    const r = await s.post({ items: [sel("mcp_server", "claude", "sneaky")] });
    expect(r.status).toBe(200);
    const [x] = JSON.parse(r.body).results as { outcome: string; rules: string[]; line: string }[];
    expect(x).toMatchObject({ outcome: "refused", rules: expect.arrayContaining(["secret_file_access"]) });
    expect(x!.line).toContain("secret_file_access");
    expect(await s.db.all("SELECT * FROM ext_packs_entries")).toEqual([]);
  });

  it("a second post of the same items stores nothing new and reports them as already added", async () => {
    home();
    const s = await setup();
    const body = { items: [sel("skill", "claude", "review-helper"), sel("mcp_server", "codex", "search")] };
    await s.post(body);
    const after = await s.rows();
    const r = await s.post(body);
    expect(JSON.parse(r.body).results.map((x: { outcome: string }) => x.outcome)).toEqual(["already_added", "already_added"]);
    expect(await s.rows()).toBe(after);
  });

  it("an item the configs do not hold is reported not found and stores nothing", async () => {
    home({ codex: false });
    const s = await setup();
    const r = await s.post({ items: [sel("mcp_server", "codex", "search")] });
    expect(JSON.parse(r.body).results[0]).toMatchObject({ outcome: "not_found" });
    expect(await s.rows()).toBe("[]");
  });

  it("is a 403 that writes nothing when no factory user acts from the page", async () => {
    home();
    const s = await setup(null);
    const r = await s.post({ items: [sel("skill", "claude", "review-helper")] });
    expect(r.status).toBe(403);
    expect(await s.rows()).toBe("[]");
  });

  it("passes Host, Origin, Content-Type, CSRF token, body size and JSON before any write", async () => {
    home();
    const s = await setup();
    const body = { items: [sel("skill", "claude", "review-helper")] };
    expect((await s.post(body, { host: "evil.example" })).status).toBe(403);
    expect((await s.post(body, { origin: "http://evil.example" })).status).toBe(403);
    expect((await s.post(body, { origin: undefined })).status).toBe(403);
    expect((await s.post(body, { contentType: "text/plain" })).status).toBe(415);
    expect((await s.post(body, { csrfToken: "stale" })).status).toBe(403);
    expect((await s.post(body, { bodyTooLarge: true })).status).toBe(413);
    expect((await s.post(body, { body: "{not json" })).status).toBe(400);
    expect((await s.post({ items: [] })).status).toBe(400);
    expect((await s.post({ items: [{ kind: "tool", source: "claude", name: "x" }] })).status).toBe(400);
    expect(await s.rows()).toBe("[]");
  });
});

describe("no env or header value leaves the configs", () => {
  it("the sentinel values appear in no response body and in no store row", async () => {
    home();
    const s = await setup();
    const all = items((await s.get()).body).map((i) => sel(i.kind, i.source, i.name));
    const bodies = [(await s.get()).body, (await s.post({ items: all })).body, (await s.get()).body];
    const stored = await s.rows();
    expect(stored).toContain("docs");
    for (const text of [...bodies, stored]) {
      expect(text).not.toContain(ENV_SENTINEL);
      expect(text).not.toContain(HEADER_SENTINEL);
    }
  });
});

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { PluginsPage: FunctionComponent };

const PAGE: PluginsView = { as_of: "2026-11-15T00:00:00.000Z", csrf_token: TOKEN, mcp: [], skills: [], tools: [] };
const found = (o: Partial<ImportItem> & Pick<ImportItem, "kind" | "name">): ImportItem => ({ source: "claude", path: null, env_keys: [], header_keys: [], imported: false, refused: [], ...o });
const SCAN: PluginsImportView = {
  as_of: PAGE.as_of,
  items: [
    found({ kind: "skill", name: "review-helper", path: "/home/me/.claude/skills/review-helper/SKILL.md" }),
    found({ kind: "skill", name: "deploy", source: "codex", path: "/home/me/.codex/skills/deploy/SKILL.md", imported: true }),
    found({ kind: "mcp_server", name: "docs", env_keys: ["DOCS_TOKEN"] }),
    found({ kind: "mcp_server", name: "search", source: "codex", imported: true }),
    found({ kind: "mcp_server", name: "sneaky", refused: ["secret_file_access"] }),
  ],
  errors: [],
};

/** The page over a fake fetch; returns the import posts it sent and each import read's token. */
function page(view: PluginsView = PAGE) {
  const posts: { url: string; init: RequestInit }[] = [];
  const reads: (string | undefined)[] = [];
  const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      const items = JSON.parse(String(init.body)).items as { kind: string; source: string; name: string }[];
      return reply({ results: items.map((i) => ({ ...i, outcome: "stored", rules: [], line: `stored ${i.kind} ${i.name}` })), errors: [] });
    }
    if (url === "/api/v1/plugins") return reply(view);
    if (url === PATH) {
      reads.push((init?.headers as Record<string, string> | undefined)?.["x-csrf-token"]);
      return reply(SCAN);
    }
    return new Response("{}", { status: 404 });
  }));
  history.replaceState(null, "", "/app/plugins");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
  return { posts, reads };
}

const dialog = () => document.querySelector("dialog[data-dialog]") as HTMLElement;
const boxes = () => within(dialog()).queryAllByRole("checkbox") as HTMLButtonElement[];

describe("Plugins page: Import", () => {
  it("each of the MCP, Skills and Tools tabs has an Import button that opens a dialog of checkboxes", async () => {
    const s = page();
    const expected: Record<string, string[]> = {
      MCP: ["Import docs from Claude Code", "Import search from Codex", "Import sneaky from Claude Code"],
      Skills: ["Import review-helper from Claude Code", "Import deploy from Codex"],
      Tools: ["Import docs from Claude Code", "Import search from Codex", "Import sneaky from Claude Code"],
    };
    for (const tab of ["MCP", "Skills", "Tools"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
      await waitFor(() => expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual(expected[tab]));
      fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(dialog()).toBeNull());
    }
    expect(s.reads.every((t) => t === TOKEN)).toBe(true);
  });

  it("an already-imported entry shows as imported and checked; it and a refused one cannot be selected", async () => {
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    await waitFor(() => expect(boxes()).toHaveLength(3));
    const [docs, search, sneaky] = boxes();
    expect(docs!.disabled).toBe(false);
    expect(search!.disabled).toBe(true);
    expect(search!.getAttribute("aria-checked")).toBe("true");
    expect(search!.closest("li")!.textContent).toContain("Imported");
    expect(sneaky!.disabled).toBe(true);
    expect(sneaky!.closest("li")!.textContent).toContain("secret_file_access");
    expect(docs!.closest("li")!.textContent).toContain("DOCS_TOKEN");
  });

  it("Import posts the checked items with the token and closes", async () => {
    const s = page();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    await waitFor(() => expect(boxes()).toHaveLength(2));
    const confirm = within(dialog()).getByRole("button", { name: "Import 0" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(boxes()[0]!);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Import 1" }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe(PATH);
    expect((s.posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
    expect(JSON.parse(String(s.posts[0]!.init.body))).toEqual({ items: [{ kind: "skill", source: "claude", name: "review-helper" }] });
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("without the page's token the Import button is off and names the CLI command", async () => {
    page({ ...PAGE, csrf_token: null });
    await waitFor(() => expect((screen.getByRole("button", { name: "Import…" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Import…" }).getAttribute("title")).toContain("factory plugins import");
  });
});
