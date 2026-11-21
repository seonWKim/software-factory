import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { cleanScanner, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// The server side of the Plugins page's actions (design 09-dashboard-app and 11-packs, 2026-11-16): pack approval add,
// the skill folder list, and the config file writer. They need the SQL store, so they run in the node environment;
// the page tests are in ui-plugins-actions.test.ts (jsdom, which cannot bundle node:sqlite).

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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// The server: POST /api/v1/packs/approvals add; GET /api/v1/plugins skill folders.

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

describe("POST /api/v1/packs/approvals: add", () => {
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

  it("the approve, revoke and add notices are plain words: no description_hash, module_hash or hex hash", async () => {
    const s = await server();
    const pack = temp("plugins-pack-");
    write(join(pack, "mcp_servers", "docs.json"), JSON.stringify({ name: "docs", command: "docs-bin" }));
    write(join(pack, "tools", "reader.json"), JSON.stringify({ name: "reader", description: "Reads.", read_only: true }));
    const added = await writePackApproval(s.d, s.pauses, { action: "add", path: pack });
    expect((added.value as { lines: string[] }).lines).toEqual(["stored tool reader as pending", "stored MCP server docs as pending"]);
    const approved = await writePackApproval(s.d, s.pauses, { action: "approve", kind: "mcp_server", name: "docs" });
    expect(approved.status).toBe(200);
    expect((approved.value as { line: string }).line).toBe("approved MCP server docs");
    const revoked = await writePackApproval(s.d, s.pauses, { action: "revoke", kind: "mcp_server", name: "docs" });
    expect((revoked.value as { line: string }).line).toBe("revoked MCP server docs");
    for (const text of [...(added.value as { lines: string[] }).lines, (approved.value as { line: string }).line, (revoked.value as { line: string }).line]) {
      expect(text).not.toMatch(/description_hash|module_hash|sha256|[0-9a-f]{12}/);
    }
  });

  it("refuses add with no factory user, before any write", async () => {
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

