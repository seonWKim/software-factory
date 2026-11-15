// The Plugins page's import (design 11-plugin-import, 2026-11-15, phase 2): GET /api/v1/plugins/import lists what the
// user-level Claude Code and Codex configs hold, with an imported flag, and writes nothing; POST stores the selected
// items as `factory plugins import` does, as the page's factory user. Both pass the dashboard's request guards first,
// and no env or header value reaches a response body or a store row.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

const ME = "local:me@example.com" as UserId;
const TOKEN = "import-token";
const HOST = "127.0.0.1:4310";
const PATH = "/api/v1/plugins/import";
// Built here so no secret-shaped literal sits in the repository.
const ENV_SENTINEL = `envval-${"Zq7".repeat(6)}`;
const HEADER_SENTINEL = `hdrval-${"Wk4".repeat(6)}`;

const dirs: string[] = [];
afterEach(() => {
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
