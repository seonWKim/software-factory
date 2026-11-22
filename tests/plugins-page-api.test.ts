// The Plugins page's read (design 09-dashboard-app and 11-packs, 2026-11-15): GET /api/v1/plugins lists the stored
// pack MCP servers with their status, the skills with their front matter description and the tools; it never carries
// an MCP server's env value, its descriptor body, or a skill file's body. `factory plugins list` prints the same rows
// from the same builder, and the page's approve and `factory pack approve` write the same row.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import packCommand from "../src/cli/handlers/pack/pack.command.js";
import pluginsCommand from "../src/cli/handlers/plugins/plugins.command.js";
import { Plugins } from "../src/plugin-set.js";
import { loadConfig } from "../src/load-config.js";
import { settingsBase } from "../src/core/settings-base.js";
import { OwnerAuth } from "../src/core/authorize.js";
import type { SettingsBase } from "../src/core/settings.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PackApprovalsStore, changeApproval } from "../src/packs/pack-approvals.store.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../src/packs/pack-entries.store.js";
import { frontMatterDescription } from "../src/runtime/capabilities/capabilities.js";
import { type UiCapabilitySources, capabilitySources } from "../src/ui/capabilities-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { writePackApproval } from "../src/ui/packs-api.js";
import { type PluginRows, pluginLines, pluginRows } from "../src/ui/plugins-api.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";
import { silent } from "./helpers/fakes/config.js";

const ME = "local:me@example.com" as UserId;
// Built here so no secret-shaped literal sits in the repository.
const ENV_VALUE = `env-${"Qx9".repeat(8)}`;
const MCP = { name: "docs-search", description: "Searches the team docs.", command: "node-docs-bin", args: ["docs-server.js"], env: { DOCS_TOKEN: ENV_VALUE } };

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const BASE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

/** A store, the page's API deps with the Settings wiring over `sources`, and the pack entry and approval stores. */
async function setup(sources: UiCapabilitySources, base: SettingsBase = BASE) {
  const clock = new FakeClock("2026-11-15T09:00:00.000Z");
  const { store } = await newStore(clock);
  const now = () => clock.now().toISOString();
  const entries = new PackEntriesStore(store.db, now);
  const approvals = new PackApprovalsStore(store.db, now);
  const editFile = Object.assign(async () => ({ ok: false as const, reason: "not wired" }), { capabilities: async () => sources });
  const settings: UiSettings = {
    base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: storeProjectResolver(store, { owner: "o", name: "r" }), csrfToken: newCsrfToken(),
    editFile: editFile as unknown as NonNullable<UiSettings["editFile"]>,
  };
  const pauses: UiPauses = { principal: async () => ME, authorize: async () => ({ allow: true }), csrfToken: "pack-token", log: silent, auth: new OwnerAuth(store) };
  const d: ApiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings, pauses };
  /** Stores `descriptor` as a pending MCP server, as `pack add` would. */
  const add = async (descriptor: Record<string, unknown>) => {
    const canonical = canonicalJson(descriptor as never);
    await entries.insert({ kind: "mcp_server", name: String(descriptor.name), description_hash: descriptionHash(descriptor as never), module_hash: null, descriptor: canonical, credential_name: null, added_by: ME });
    clock.advance(1000);
  };
  const change = (action: "approve" | "revoke", name: string) => changeApproval({ auth: new OwnerAuth(store), entries, approvals, user_id: ME }, { action, kind: "mcp_server", name });
  const get = async () => respond(d, { method: "GET", url: "/api/v1/plugins", host: "127.0.0.1:4310" });
  return { clock, store, d, add, change, get };
}

const NONE: UiCapabilitySources = { skill_folders: [], tools: [], providers: [] };

describe("GET /api/v1/plugins: MCP servers", () => {
  it("never contains an MCP server's env value, its command, its args or its descriptor body", async () => {
    const s = await setup(NONE);
    await s.add(MCP);
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).mcp).toEqual([{ name: "docs-search", description: "Searches the team docs.", source: "pack", status: "waiting" }]);
    expect(r.body).not.toContain(ENV_VALUE);
    expect(r.body).not.toContain("DOCS_TOKEN");
    expect(r.body).not.toContain("node-docs-bin");
    expect(r.body).not.toContain("docs-server.js");
    expect(r.body).not.toContain("descriptor");
  });

  it("status: waiting until approved, approved, off once revoked, and waiting again for a changed description", async () => {
    const s = await setup(NONE);
    const status = async () => (JSON.parse((await s.get()).body).mcp as { status: string }[]).map((m) => m.status);
    await s.add(MCP);
    expect(await status()).toEqual(["waiting"]);
    expect(await s.change("approve", "docs-search")).toMatchObject({ ok: true });
    expect(await status()).toEqual(["approved"]);
    expect(await s.change("revoke", "docs-search")).toMatchObject({ ok: true });
    expect(await status()).toEqual(["off"]);
    // A new description of the same name is the current one; its approval is its own (the pin).
    await s.add({ ...MCP, description: "Searches the team docs, faster." });
    expect(JSON.parse((await s.get()).body).mcp).toEqual([expect.objectContaining({ description: "Searches the team docs, faster.", status: "waiting" })]);
  });

  it("carries the approvals route's token only when the page can approve, and is a 404 without the Settings wiring", async () => {
    const s = await setup(NONE);
    expect(JSON.parse((await s.get()).body).csrf_token).toBe("pack-token");
    const { pauses: _p, ...noPauses } = s.d;
    expect(JSON.parse((await respond(noPauses, { method: "GET", url: "/api/v1/plugins", host: "127.0.0.1:4310" })).body).csrf_token).toBeNull();
    const { settings: _s, ...bare } = s.d;
    expect((await respond(bare, { method: "GET", url: "/api/v1/plugins", host: "127.0.0.1:4310" })).status).toBe(404);
  });

  it("a secret the SecretStore holds is withheld from an MCP server's description", async () => {
    const s = await setup(NONE);
    const d: ApiDeps = { ...s.d, scanner: new PatternEgressScanner(async () => [ENV_VALUE]) };
    await s.add({ ...MCP, description: `Uses ${ENV_VALUE}.` });
    const r = await respond(d, { method: "GET", url: "/api/v1/plugins", host: "127.0.0.1:4310" });
    expect(r.body).toContain("[withheld");
    expect(r.body).not.toContain(ENV_VALUE);
  });
});

describe("GET /api/v1/plugins: skills and tools", () => {
  it("a skill's description comes only from its SKILL.md front matter: the body is never returned", async () => {
    const folder = temp("plugins-skills-");
    write(join(folder, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ships a release to production.\n---\n\nBODY_MARKER: step one, run the deploy script.\n");
    write(join(folder, "notes", "SKILL.md"), "# Notes\n\nBODY_MARKER without front matter.\n");
    const s = await setup({ ...NONE, skill_folders: [folder] });
    const r = await s.get();
    expect(JSON.parse(r.body).skills).toEqual([
      { name: "deploy", folder, description: "Ships a release to production.", roles: [], last_used: null },
      { name: "notes", folder, description: null, roles: [], last_used: null },
    ]);
    expect(r.body).not.toContain("BODY_MARKER");
  });

  it("reads plain, quoted and block descriptions, and nothing outside the front matter", () => {
    expect(frontMatterDescription("---\ndescription: 'Quoted text'\n---\nbody")).toBe("Quoted text");
    expect(frontMatterDescription("---\nname: x\ndescription: >\n  Folded over\n  two lines\nother: y\n---\nbody")).toBe("Folded over two lines");
    expect(frontMatterDescription("---\nname: x\n---\ndescription: in the body\n")).toBeNull();
    expect(frontMatterDescription("description: no front matter\n")).toBeNull();
    expect(frontMatterDescription("---\ndescription: never closed\n")).toBeNull();
  });

  it("a tool row has its description, read-only flag, origin, roles and last used", async () => {
    const tools = [
      { name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker" as const },
      { name: "docs-reader", description: "Reads the docs.", read_only: true, origin: "pack" as const },
      { name: "git.store_branch", description: "Store a branch.", read_only: false, origin: "broker" as const },
    ];
    const s = await setup({ ...NONE, tools }, { ...BASE, file: { tool_grants: { triage: ["forge.preflight", "pack:tool:docs-reader"] } } });
    const body = JSON.parse((await s.get()).body) as PluginRows;
    expect(body.tools).toEqual([
      { name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker", roles: ["triage"], last_used: null },
      { name: "pack:tool:docs-reader", description: "Reads the docs.", read_only: true, origin: "pack", roles: ["triage"], last_used: null },
      { name: "git.store_branch", description: "Store a branch.", read_only: false, origin: "broker", roles: [], last_used: null },
    ]);
  });

  it("reading writes nothing to the store", async () => {
    const s = await setup(NONE);
    await s.add(MCP);
    const writes: string[] = [];
    const store = new Proxy(s.store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (typeof prop === "string" && !/^(get|list|read|count|find|has|is)/.test(prop)) writes.push(prop);
          return (v as (...x: unknown[]) => unknown).apply(target, a);
        };
      },
    }) as FactoryStore;
    await pluginRows({ store, scanner: s.d.scanner }, BASE, NONE);
    expect(writes).toEqual([]);
  });
});

describe("factory plugins list and factory pack approve", () => {
  const REPO_ROOT = join(import.meta.dirname, "..");
  const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

  /** A code root with the checked-in config on SQLite, a repo folder, and a pack holding MCP. */
  function fixture() {
    const codeRoot = temp("plugins-code-");
    const repo = temp("plugins-repo-");
    for (const p of ["triage", "implement", "review"]) write(join(codeRoot, "prompts", `${p}.md`), `${p} base\n`);
    const file = { ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none" }, repo: { ...(REAL.repo as object), path: repo }, state_dir: "state", worktrees_dir: "wt", cli_user: ME };
    write(join(codeRoot, "factory.config.json"), JSON.stringify(file));
    write(join(codeRoot, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(codeRoot, "secrets", ".env"));
    const pack = temp("plugins-pack-");
    write(join(pack, "mcp_servers", "docs.json"), JSON.stringify(MCP));
    return { codeRoot, pack };
  }

  /** Runs one command, its console lines captured. */
  async function run(command: typeof packCommand, args: string[], codeRoot: string): Promise<{ code: number; out: string[] }> {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
    const err = vi.spyOn(console, "error").mockImplementation((line: string) => void out.push(line));
    try {
      return { code: await command.run(args, { name: command.names[0]!, usage: "", load: () => loadConfig(codeRoot) }), out };
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  }

  /** The configured store, opened as the CLI opens it, with the builder's rows over it. */
  async function opened(codeRoot: string) {
    const loaded = await loadConfig(codeRoot);
    const p = new Plugins(loaded);
    const clock = await p.clock();
    const secrets = await p.secrets();
    const store = await p.store(secrets, clock);
    const scanner = await p.scanner(secrets);
    const rows = async () => pluginRows({ store, scanner }, settingsBase(loaded), await capabilitySources(loaded, store));
    return { store, clock, rows };
  }

  it("prints the builder's rows for each kind, the same rows the API returns, never the env value", async () => {
    const f = fixture();
    expect((await run(packCommand, ["add", f.pack], f.codeRoot)).code).toBe(0);
    const mcp = await run(pluginsCommand, ["list", "--kind", "mcp"], f.codeRoot);
    expect(mcp.code).toBe(0);
    expect(mcp.out).toEqual(["docs-search  waiting  pack  Searches the team docs."]);
    expect(mcp.out.join("\n")).not.toContain(ENV_VALUE);
    const tool = await run(pluginsCommand, ["list", "--kind", "tool"], f.codeRoot);
    const o = await opened(f.codeRoot);
    try {
      const rows = await o.rows();
      expect(mcp.out).toEqual(pluginLines(rows, "mcp"));
      expect(tool.out).toEqual(pluginLines(rows, "tool"));
      expect(tool.out.some((l) => l.startsWith("git.store_branch  broker  writes"))).toBe(true);
    } finally {
      await o.store.close();
    }
    expect((await run(pluginsCommand, ["list", "--kind", "nope"], f.codeRoot)).code).toBe(1);
    expect((await run(pluginsCommand, ["show"], f.codeRoot)).code).toBe(1);
  });

  it("the page's approve and factory pack approve mcp_server write the same row through changeApproval", async () => {
    const f = fixture();
    await run(packCommand, ["add", f.pack], f.codeRoot);
    expect((await run(packCommand, ["approve", "mcp_server", "docs-search"], f.codeRoot)).code).toBe(0);
    expect((await run(pluginsCommand, ["list", "--kind", "mcp"], f.codeRoot)).out).toEqual(["docs-search  approved  pack  Searches the team docs."]);
    expect((await run(packCommand, ["revoke", "mcp_server", "docs-search"], f.codeRoot)).code).toBe(0);
    expect((await run(pluginsCommand, ["list", "--kind", "mcp"], f.codeRoot)).out).toEqual(["docs-search  off  pack  Searches the team docs."]);
    const o = await opened(f.codeRoot);
    try {
      const pauses: UiPauses = { principal: async () => ME, authorize: async () => ({ allow: true }), csrfToken: "t", log: silent, auth: new OwnerAuth(o.store) };
      const r = await writePackApproval({ store: o.store, clock: o.clock } as never, pauses, { action: "approve", kind: "mcp_server", name: "docs-search" });
      expect(r.status).toBe(200);
      const db = (o.store as unknown as { db: { all(sql: string): Promise<Record<string, unknown>[]> } }).db;
      const rows = await db.all("SELECT kind, name, description_hash, action, user_id FROM ext_packs_approvals ORDER BY seq");
      // The CLI's approve (first row) and the page's (last row) are the same row.
      expect(rows.map((x) => x.action)).toEqual(["approve", "revoke", "approve"]);
      expect(rows[2]).toEqual(rows[0]);
      expect(rows[0]).toMatchObject({ kind: "mcp_server", name: "docs-search", user_id: ME });
      expect((await o.rows()).mcp).toEqual([expect.objectContaining({ name: "docs-search", status: "approved" })]);
    } finally {
      await o.store.close();
    }
  });
});
