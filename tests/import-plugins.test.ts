import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginsCommand from "../src/cli/handlers/plugins/plugins.command.js";
import { Plugins, loadConfig } from "../src/compose.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { scanUserConfigs } from "../src/import/scan.js";
import { SkillRefsStore } from "../src/import/import-plugins.js";
import { readSkillRefs } from "../src/runtime/capabilities/capabilities.js";
import { capabilityRows } from "../src/ui/capabilities-api.js";
import { serverDescriptor } from "../src/import/mcp-servers.js";
import { parseToml } from "../src/import/toml.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { startPackMcpServer } from "../src/impl/runner/pack-mcp-client.js";
import { MCP_LIST_STALE_MS, type StartMcpServer, importedMcpRefusals, listRequestedMcpTools, requestMcpToolLists } from "../src/import/mcp-tool-lists.js";
import type { PackMcpServer } from "../src/interfaces/agent-runner.js";
import { PackApprovalsStore } from "../src/packs/pack-approvals.store.js";
import { PackEntriesStore, canonicalJson, descriptionHash, readPointer } from "../src/packs/pack-entries.store.js";
import { WorkerPool } from "../src/worker/index.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config as fakeConfig, prompts as fakePrompts, silent, waitFor } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// `factory plugins import` (design 11-plugin-import): scans the user-level Claude Code and Codex configs in a
// temporary HOME, stores MCP servers as pending pack entries with env key names only, and skill references.

const SENTINEL = "SENTINEL-env-value-7f3a9c";
const SKILL_TEXT = "# Review helper\n\nReview the diff carefully.\n";
const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const CLAUDE_JSON = {
  numStartups: 3,
  mcpServers: {
    docs: { type: "stdio", command: "npx", args: ["-y", "docs-server"], env: { DOCS_TOKEN: SENTINEL, DOCS_URL: SENTINEL } },
    remote: { type: "http", url: `https://mcp.example.com/mcp?key=${SENTINEL}`, headers: { Authorization: `Bearer ${SENTINEL}` } },
  },
  // Project scope is out of scope: never read.
  projects: { "/some/repo": { mcpServers: { local: { command: "local", env: { LOCAL_KEY: SENTINEL } } } } },
};

const CODEX_TOML = `# Codex user config
model = "o3"

[mcp_servers.search]
command = "uvx"
args = [
  "search-mcp", # the server
  "--stdio",
]
env = { SEARCH_API_KEY = "${SENTINEL}" }

[mcp_servers.notes]
command = 'notes'

[mcp_servers.notes.env]
NOTES_TOKEN = "${SENTINEL}"
`;

/** A HOME with a Claude Code and a Codex user config, each with one skill and env values set to the sentinel. */
function home(o: { claude?: string | null; codex?: string | null } = {}): string {
  const h = temp("sf-import-home-");
  if (o.claude !== null) write(join(h, ".claude.json"), o.claude ?? JSON.stringify(CLAUDE_JSON, null, 2));
  if (o.codex !== null) write(join(h, ".codex", "config.toml"), o.codex ?? CODEX_TOML);
  write(join(h, ".claude", "skills", "review-helper", "SKILL.md"), SKILL_TEXT);
  write(join(h, ".codex", "skills", "deploy", "SKILL.md"), "# Deploy\n");
  return h;
}

/** A code root with the checked-in config on SQLite and its state dir under it (not created until a write). */
function codeRoot(): string {
  const root = temp("sf-import-code-");
  for (const p of ["triage", "implement", "review"]) write(join(root, "prompts", `${p}.md`), `${p} base\n`);
  const file = { ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none" }, repo: { ...(REAL.repo as object), path: root }, state_dir: "state", worktrees_dir: "wt" };
  write(join(root, "factory.config.json"), JSON.stringify(file));
  write(join(root, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(root, "secrets", ".env"));
  return root;
}

/** Runs the command with HOME set to `h`; returns its exit code and every stdout and stderr line. */
async function run(root: string, h: string, args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  vi.stubEnv("HOME", h);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  try {
    const code = await pluginsCommand.run(args, { name: "plugins", usage: "", load: () => loadConfig(root) });
    return { code, out, err };
  } finally {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    vi.mocked(console.warn).mockRestore();
  }
}

async function rows(root: string): Promise<{ entries: Record<string, unknown>[]; skills: Record<string, unknown>[] }> {
  const p = new Plugins(await loadConfig(root));
  const store = await p.store(await p.secrets(), new FakeClock());
  try {
    const db = storeSql(store);
    return {
      entries: await db.all("SELECT * FROM ext_packs_entries ORDER BY kind, name"),
      skills: await db.all("SELECT * FROM ext_skill_refs ORDER BY source, name"),
    };
  } finally {
    await store.close();
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("plugins import: dry run", () => {
  it("lists each skill and MCP server with its kind, name and source, and writes nothing", async () => {
    const root = codeRoot();
    const before = filesUnder(root);
    const r = await run(root, home(), ["import", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "found skill review-helper from claude",
      "found mcp_server docs from claude",
      "found mcp_server remote from claude",
      "found skill deploy from codex",
      "found mcp_server notes from codex",
      "found mcp_server search from codex",
      expect.stringMatching(/^dry run: 6 found, nothing stored/),
    ]);
    expect(existsSync(join(root, "state"))).toBe(false);
    expect(filesUnder(root)).toEqual(before);
  });
});

describe("plugins import: storing", () => {
  it("stores each item once: the second run reports them as already added and stores nothing new", async () => {
    const root = codeRoot();
    const h = home();
    const first = await run(root, h, ["import"]);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("stored mcp_server docs from claude as pending");
    expect(first.out).toContain("stored mcp_server search from codex as pending");
    expect(first.out.find((l) => l.startsWith("stored skill review-helper from claude"))).toBeDefined();
    const once = await rows(root);
    const second = await run(root, h, ["import"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already added skill review-helper from claude");
    expect(second.out).toContain("already added mcp_server docs from claude");
    expect(second.out.filter((l) => l.startsWith("stored "))).toEqual([]);
    expect(await rows(root)).toEqual(once);
  });

  it("stores an MCP server as a pending pointer: its source file, key and the SHA-256 of its allow-listed descriptor, no copy", async () => {
    const root = codeRoot();
    const h = home();
    expect((await run(root, h, ["import", "--kind", "mcp_server"])).code).toBe(0);
    const { entries } = await rows(root);
    const claude = join(h, ".claude.json");
    const codex = join(h, ".codex", "config.toml");
    expect(entries.map((e) => [e.kind, e.name, e.status, e.source, e.source_file, e.source_key, e.descriptor])).toEqual([
      ["mcp_server", "docs", "pending", "claude", claude, "docs", null],
      ["mcp_server", "notes", "pending", "codex", codex, "notes", null],
      ["mcp_server", "remote", "pending", "claude", claude, "remote", null],
      ["mcp_server", "search", "pending", "codex", codex, "search", null],
    ]);
    const docs = serverDescriptor("claude", "docs", CLAUDE_JSON.mcpServers.docs);
    expect(docs).toMatchObject({ name: "docs", source: "claude", command: "npx", env_keys: ["DOCS_TOKEN", "DOCS_URL"] });
    expect(docs).not.toHaveProperty("env");
    expect(entries[0]!.description_hash).toBe(descriptionHash(docs));
    // No copy of the command, args, env key names or URL is stored.
    const text = JSON.stringify(entries);
    for (const copy of ["npx", "docs-server", "DOCS_TOKEN", "uvx", "mcp.example.com", "Authorization"]) expect(text).not.toContain(copy);
    expect(entries.every((e) => e.credential_name === null && e.module_hash === null)).toBe(true);
  });

  it("the sentinel env value of each format appears in no stdout, stderr, store row or written file", async () => {
    const root = codeRoot();
    const h = home();
    const lines: string[] = [];
    for (const args of [["import", "--dry-run"], ["import"], ["import"], ["import", "--source", "codex"]]) {
      const r = await run(root, h, args);
      lines.push(...r.out, ...r.err);
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(SENTINEL);
    const { entries, skills } = await rows(root);
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(["docs", "notes", "remote", "search"]));
    expect(JSON.stringify([entries, skills])).not.toContain(SENTINEL);
    const written = filesUnder(join(root, "state"));
    expect(written.length).toBeGreaterThan(0);
    for (const f of written) expect(readFileSync(f).includes(SENTINEL), f).toBe(false);
  });

  it("stores one skill reference: source, name, path and SHA-256, never the file's text", async () => {
    const root = codeRoot();
    const h = home();
    expect((await run(root, h, ["import", "--kind", "skill", "--source", "claude"])).code).toBe(0);
    const { entries, skills } = await rows(root);
    expect(entries).toEqual([]);
    const path = join(h, ".claude", "skills", "review-helper", "SKILL.md");
    expect(skills).toEqual([
      expect.objectContaining({ source: "claude", kind: "skill", name: "review-helper", path, sha256: createHash("sha256").update(SKILL_TEXT).digest("hex") }),
    ]);
    expect(JSON.stringify(skills)).not.toContain("Review the diff");
  });
});

describe("plugins import: filters", () => {
  it("--kind limits the scan to its kind and --source to its source", async () => {
    const h = home();
    const names = async (args: string[]) => (await run(codeRoot(), h, ["import", "--dry-run", ...args])).out.filter((l) => l.startsWith("found "));
    expect(await names(["--kind", "skill"])).toEqual(["found skill review-helper from claude", "found skill deploy from codex"]);
    expect(await names(["--kind=mcp_server", "--source=codex"])).toEqual(["found mcp_server notes from codex", "found mcp_server search from codex"]);
    expect(await names(["--source", "claude", "--kind", "all"])).toEqual([
      "found skill review-helper from claude", "found mcp_server docs from claude", "found mcp_server remote from claude",
    ]);
  });

  it("refuses an unknown kind, source or flag with the usage and exit 1", async () => {
    const h = home();
    for (const args of [["import", "--kind", "tool"], ["import", "--source", "cursor"], ["import", "--from"], ["import", "--force"], ["export"]]) {
      const r = await run(codeRoot(), h, args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err.join("\n")).toMatch(/usage: npm run factory -- plugins import/);
    }
  });
});

describe("plugins import: missing and malformed configs", () => {
  it("a missing config finds nothing from it and exits 0", async () => {
    const h = temp("sf-import-empty-");
    const r = await run(codeRoot(), h, ["import", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out.filter((l) => l.startsWith("found "))).toEqual([]);
    const s = await scanUserConfigs({ home: h, sources: ["claude", "codex"], kinds: ["skill", "mcp_server"] });
    expect(s).toEqual({ found: [], errors: [] });
  });

  it("a config that does not parse stops that source with an error naming the file, and nothing is stored from it", async () => {
    for (const [bad, source, file] of [
      [{ codex: `[mcp_servers.search\ncommand = "${SENTINEL}"\n` }, "codex", join(".codex", "config.toml")],
      [{ claude: `{"mcpServers": {"docs": {"env": {"K": "${SENTINEL}"}}` }, "claude", ".claude.json"],
    ] as const) {
      const root = codeRoot();
      const h = home(bad);
      const r = await run(root, h, ["import"]);
      expect(r.code).toBe(1);
      expect(r.err).toEqual([expect.stringContaining(join(h, file))]);
      for (const line of [...r.out, ...r.err]) expect(line).not.toContain(SENTINEL);
      expect(r.out.some((l) => l.includes(`from ${source}`))).toBe(false);
      const { entries, skills } = await rows(root);
      expect([...entries, ...skills].some((e) => e.source === source || String(e.descriptor ?? "").includes(`"source":"${source}"`))).toBe(false);
      expect(entries.length + skills.length).toBeGreaterThan(0);
    }
  });
});

// Every source Claude Code uses (design 11-plugin-import, pointers only): enabled plugins, user commands, the managed
// repo's project files, Claude Desktop and `--from <path>`, each under its own source label.

const REPO_NAME = (REAL.repo as { name: string }).name;

/** `home()` plus an enabled, a disabled and a cache-only Claude Code plugin, two user commands and Claude Desktop. */
function richHome(o: { desktop?: boolean } = {}): string {
  const h = home();
  const cache = join(h, ".claude", "plugins", "cache", "official");
  const plugin = (name: string) => {
    const dir = join(cache, name, "1.0.0");
    write(join(dir, "skills", `${name}-skill`, "SKILL.md"), `# ${name}\n`);
    write(join(dir, ".mcp.json"), JSON.stringify({ [`${name}-mcp`]: { command: "npx", args: [`${name}-tools`], env: { TOKEN: SENTINEL } } }));
    return dir;
  };
  const firebase = plugin("firebase");
  const disabled = plugin("disabled");
  plugin("cached");
  write(join(h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "firebase@official": true, "disabled@official": false, "cached@official": true } }));
  write(join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "firebase@official": [{ scope: "user", installPath: firebase }], "disabled@official": [{ scope: "user", installPath: disabled }] },
  }));
  write(join(h, ".claude", "commands", "ship.md"), "Ship it.\n");
  write(join(h, ".claude", "commands", "review.md"), "Review it.\n");
  if (o.desktop !== false) {
    write(join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { files: { command: "files-mcp", env: { K: SENTINEL } } } }));
  }
  return h;
}

/** A code root whose managed repo (the code root itself) has a project .mcp.json and a project skill. */
function projectRoot(): string {
  const root = codeRoot();
  write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { lint: { command: "lint-mcp" } } }));
  write(join(root, ".claude", "skills", "house-style", "SKILL.md"), "# House style\n");
  return root;
}

/** Every file and folder under `dirs` with its mtime and, for a file, its SHA-256. */
function fingerprint(...dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string) => {
    const st = statSync(p);
    out[p] = `${st.mtimeMs}:${st.isDirectory() ? "dir" : createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  for (const d of dirs) walk(d);
  return out;
}

describe("plugins import: every source Claude Code uses", () => {
  it("finds enabled plugins' skills and .mcp.json, user commands, the project's files and Claude Desktop, each with its source label", async () => {
    const root = projectRoot();
    const r = await run(root, richHome(), ["import", "--dry-run"]);
    expect(r.err).toEqual([]);
    expect(r.out.filter((l) => l.startsWith("found "))).toEqual([
      "found skill review-helper from claude",
      "found mcp_server docs from claude",
      "found mcp_server remote from claude",
      "found command review from claude-command",
      "found command ship from claude-command",
      "found skill firebase-skill from claude-plugin:firebase",
      "found mcp_server firebase-mcp from claude-plugin:firebase",
      "found skill deploy from codex",
      "found mcp_server notes from codex",
      "found mcp_server search from codex",
      `found skill house-style from project:${REPO_NAME}`,
      `found mcp_server lint from project:${REPO_NAME}`,
      "found mcp_server files from claude-desktop",
    ]);
    // A disabled plugin, and one only in the cache, are not read.
    expect(r.out.join("\n")).not.toMatch(/disabled|cached/);
    expect(existsSync(join(root, "state"))).toBe(false);
  });

  it("stores commands as kind command under claude-command, and plugin, project and desktop items under their labels", async () => {
    const root = projectRoot();
    const h = richHome();
    const r = await run(root, h, ["import"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const { entries, skills } = await rows(root);
    expect(skills.map((x) => [x.source, x.kind, x.name])).toEqual([
      ["claude", "skill", "review-helper"],
      ["claude-command", "command", "review"],
      ["claude-command", "command", "ship"],
      ["claude-plugin:firebase", "skill", "firebase-skill"],
      ["codex", "skill", "deploy"],
      [`project:${REPO_NAME}`, "skill", "house-style"],
    ]);
    expect(skills.find((x) => x.name === "ship")).toMatchObject({ path: join(h, ".claude", "commands", "ship.md"), sha256: createHash("sha256").update("Ship it.\n").digest("hex") });
    expect(entries.map((e) => [e.name, e.source, e.source_key])).toEqual(expect.arrayContaining([
      ["firebase-mcp", "claude-plugin:firebase", "firebase-mcp"],
      ["lint", `project:${REPO_NAME}`, "lint"],
      ["files", "claude-desktop", "files"],
    ]));
    expect(entries.find((e) => e.name === "lint")!.source_file).toBe(join(root, ".mcp.json"));
    expect(JSON.stringify([entries, skills])).not.toContain(SENTINEL);
    expect(JSON.stringify([entries, skills])).not.toMatch(/disabled|cached/);
  });

  it("a missing Claude Desktop config means the source is off, not an error", async () => {
    const r = await run(codeRoot(), richHome({ desktop: false }), ["import", "--dry-run", "--source", "claude-desktop"]);
    expect(r).toMatchObject({ code: 0, err: [] });
    expect(r.out.filter((l) => l.startsWith("found "))).toEqual([]);
  });

  it("--from <path> scans the folder laid out like a plugin and stores its items under folder:<folder name>", async () => {
    const dir = join(temp("sf-import-from-"), "my-kit");
    write(join(dir, "skills", "triage-notes", "SKILL.md"), "# Triage notes\n");
    write(join(dir, "commands", "release.md"), "Release.\n");
    write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { kit: { command: "kit-mcp" } } }));
    const root = codeRoot();
    const h = home();
    const dry = await run(root, h, ["import", "--dry-run", "--from", dir]);
    expect(dry.out.filter((l) => l.startsWith("found "))).toEqual([
      "found skill triage-notes from folder:my-kit",
      "found command release from folder:my-kit",
      "found mcp_server kit from folder:my-kit",
    ]);
    expect((await run(root, h, ["import", "--from", dir])).code).toBe(0);
    const { entries, skills } = await rows(root);
    expect(skills.map((x) => [x.source, x.kind, x.name])).toEqual([["folder:my-kit", "skill", "triage-notes"], ["folder:my-kit", "command", "release"]].sort());
    expect(entries.map((e) => [e.name, e.source, e.source_file])).toEqual([["kit", "folder:my-kit", join(dir, ".mcp.json")]]);
    const missing = await run(root, h, ["import", "--from", join(dir, "nope")]);
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toMatch(/is not a folder/);
  });

  it("a server key two sources share gets its source label added", async () => {
    const root = projectRoot();
    write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "project-docs" } } }));
    expect((await run(root, home(), ["import", "--kind", "mcp_server"])).code).toBe(0);
    const { entries } = await rows(root);
    expect(entries.filter((e) => e.source_key === "docs").map((e) => [e.name, e.source])).toEqual([
      ["docs@claude", "claude"],
      [`docs@project:${REPO_NAME}`, `project:${REPO_NAME}`],
    ]);
  });

  it("changes no scanned file or folder: every mtime and SHA-256 is the same after a dry run and an import", async () => {
    const root = projectRoot();
    const h = richHome();
    const scanned = [h, join(root, ".mcp.json"), join(root, ".claude")];
    const before = fingerprint(...scanned);
    expect(Object.keys(before).length).toBeGreaterThan(20);
    await run(root, h, ["import", "--dry-run"]);
    await run(root, h, ["import"]);
    await run(root, h, ["import"]);
    expect(fingerprint(...scanned)).toEqual(before);
  });

  it("the dry run writes nothing: no store row, no file and no state folder", async () => {
    const root = projectRoot();
    const h = richHome();
    const before = fingerprint(root);
    const r = await run(root, h, ["import", "--dry-run"]);
    expect(r.out.at(-1)).toMatch(/^dry run: \d+ found, nothing stored/);
    expect(existsSync(join(root, "state"))).toBe(false);
    expect(fingerprint(root)).toEqual(before);
  });
});

describe("plugins import: pointers are updated, never added again", () => {
  it("editing a SKILL.md and importing again leaves one row for its source and path, with the new SHA-256, and prints updated skill", async () => {
    const root = codeRoot();
    const h = home();
    await run(root, h, ["import", "--kind", "skill"]);
    const path = join(h, ".claude", "skills", "review-helper", "SKILL.md");
    const first = (await rows(root)).skills.find((x) => x.path === path)!;
    write(path, `${SKILL_TEXT}\nOne more line.\n`);
    const r = await run(root, h, ["import", "--kind", "skill"]);
    expect(r.out.find((l) => l.startsWith("updated skill review-helper"))).toBeDefined();
    expect(r.out).toContain("already added skill deploy from codex");
    const same = (await rows(root)).skills.filter((x) => x.source === "claude" && x.path === path);
    expect(same).toEqual([expect.objectContaining({ id: first.id, created_at: first.created_at, sha256: createHash("sha256").update(`${SKILL_TEXT}\nOne more line.\n`).digest("hex") })]);
  });

  it("an MCP entry whose hash changed in its file is pending again on the next import, under the same row", async () => {
    const root = codeRoot();
    const h = home();
    await run(root, h, ["import", "--kind", "mcp_server", "--source", "claude"]);
    const before = (await rows(root)).entries.find((e) => e.name === "docs")!;
    const changed = { ...CLAUDE_JSON, mcpServers: { ...CLAUDE_JSON.mcpServers, docs: { ...CLAUDE_JSON.mcpServers.docs, args: ["-y", "docs-server@2"] } } };
    write(join(h, ".claude.json"), JSON.stringify(changed));
    const r = await run(root, h, ["import", "--kind", "mcp_server", "--source", "claude"]);
    expect(r.out).toContain("updated mcp_server docs from claude: changed, pending again");
    const after = (await rows(root)).entries.filter((e) => e.source_key === "docs");
    expect(after).toEqual([expect.objectContaining({ id: before.id, status: "pending", description_hash: descriptionHash(serverDescriptor("claude", "docs", changed.mcpServers.docs)) })]);
    expect(after[0]!.description_hash).not.toBe(before.description_hash);
  });
});

describe("plugins import: commands are never listed as skills", () => {
  it("the capability list (capabilities-api.ts) and readSkillRefs (capabilities.ts) list only kind skill rows", async () => {
    const dir = temp("sf-import-kinds-");
    write(join(dir, "skills", "real", "SKILL.md"), "---\ndescription: A real skill.\n---\n");
    write(join(dir, "commands", "ship.md"), "---\ndescription: A command.\n---\n");
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const { store } = await newStore(new FakeClock());
    const refs = new SkillRefsStore(storeSql(store), () => "2026-11-16T09:00:00.000Z");
    const skill = { kind: "skill" as const, source: "claude", name: "real", path: join(dir, "skills", "real", "SKILL.md") };
    const command = { kind: "command" as const, source: "claude-command", name: "ship", path: join(dir, "commands", "ship.md") };
    expect(await refs.insert({ ...skill, sha256: sha(skill.path) }, ME)).toBe("stored");
    expect(await refs.insert({ ...command, sha256: sha(command.path) }, ME)).toBe("stored");
    const caps = await capabilityRows({ store, scanner: cleanScanner }, { file: {}, layers: { defaults: {}, projects: {} } }, { skill_folders: [], tools: [], providers: [] });
    expect(caps.filter((c) => c.kind === "skill").map((c) => [c.name, c.imported?.source])).toEqual([["real", "claude"]]);
    const read = await readSkillRefs([{ ...skill, sha256: sha(skill.path) }, { ...command, sha256: sha(command.path) }]);
    expect(read.map((r) => r.name)).toEqual(["real"]);
  });
});

describe("plugins import: the TOML reader", () => {
  it("reads tables, dotted keys, inline tables, arrays, strings and numbers", () => {
    expect(parseToml(`a = 1\nb.c = "x\\ty"\n[t."q k"]\nlist = [1, 2,\n 3]\ninline = { k = 'v', n = true }\n[[arr]]\nx = 1\n[[arr]]\nx = 2\ns = """multi\nline"""\n`)).toEqual({
      a: 1, b: { c: "x\ty" }, t: { "q k": { list: [1, 2, 3], inline: { k: "v", n: true } } }, arr: [{ x: 1 }, { x: 2, s: "multi\nline" }],
    });
  });

  it("throws naming the line only, never the text", () => {
    expect(() => parseToml(`ok = 1\nbad = "${SENTINEL}\n`)).toThrow(/line 2/);
    try {
      parseToml(`ok = 1\nbad ${SENTINEL}\n`);
    } catch (err) {
      expect(String(err)).not.toContain(SENTINEL);
    }
    expect(() => parseToml(`a = 1\na = 2\n`)).toThrow(/line 2/);
  });
});

// Phase 3 (design 11-plugin-import): the tools of an approved imported MCP server, listed by a worker from a request
// row the Plugins read writes. A fake stdio MCP server records its env and every method it was sent.

const ME = "local:me@example.com";
const DESCRIPTION_TEXT = "TOOL-DESCRIPTION-TEXT";

const FAKE_SERVER = `import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const record = process.argv[2];
writeFileSync(record, JSON.stringify({ env: process.env }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  appendFileSync(record, JSON.stringify({ method: msg.method }) + "\\n");
  if (msg.id === undefined) return;
  const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    : msg.method === "tools/list" ? (msg.params && msg.params.cursor ? { tools: [{ name: "fetch", description: "${DESCRIPTION_TEXT}" }] } : { tools: [{ name: "search", description: "${DESCRIPTION_TEXT}" }], nextCursor: "p2" })
    : { content: [{ type: "text", text: "called" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

/** The fake server's script and record file; `recorded` reads the env it started with and the methods it got. */
function fakeServer() {
  const dir = temp("sf-mcp-list-");
  const script = join(dir, "server.mjs");
  writeFileSync(script, FAKE_SERVER);
  const record = join(dir, "record.jsonl");
  const recorded = () => {
    const [first, ...rest] = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { env: first!.env as Record<string, string>, methods: rest.map((r) => r.method), text: readFileSync(record, "utf8") };
  };
  return { command: process.execPath, args: [script, record], record, recorded };
}


/** A start that records each server it is asked for and lists `tools`, or throws when `tools` is null. */
function fakeStart(tools: string[] | null = ["search"], wait: Promise<void> = Promise.resolve()) {
  const calls: PackMcpServer[] = [];
  const start: StartMcpServer = async (server) => {
    calls.push(server);
    await wait;
    if (tools === null) throw new Error(`spawn ${server.command} ENOENT ${SENTINEL}`);
    return { tools: tools.map((name) => ({ name })), close: async () => {} };
  };
  return { calls, start };
}

async function listSetup() {
  const clock = new FakeClock("2026-11-16T09:00:00.000Z");
  const { store } = await newStore(clock);
  const db = storeSql(store);
  const now = () => clock.now().toISOString();
  const entries = new PackEntriesStore(db, now);
  const approvals = new PackApprovalsStore(db, now);
  const file = join(temp("sf-mcp-home-"), ".claude.json");
  const servers: Record<string, Record<string, unknown>> = {};
  /** Writes the imported server `name` into a Claude Code config (with an env value) and stores its pointer, as the import does. */
  const add = async (name: string, raw: Record<string, unknown>) => {
    servers[name] = { env: { DOCS_TOKEN: SENTINEL }, ...raw };
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    const { description_hash } = (await readPointer({ source: "claude", file, key: name }))!;
    await entries.storePointer({ source: "claude", file, key: name, description_hash, added_by: ME }, false);
    clock.advance(1000);
    return { kind: "mcp_server" as const, name, description_hash };
  };
  /** Stores `descriptor` as a pack's MCP server, as `pack add` does. */
  const addPack = async (descriptor: Record<string, unknown>) => {
    const description_hash = descriptionHash(descriptor as never);
    await entries.insert({ kind: "mcp_server", name: String(descriptor.name), description_hash, module_hash: null, descriptor: canonicalJson(descriptor as never), credential_name: null, added_by: ME });
    clock.advance(1000);
    return { kind: "mcp_server" as const, name: String(descriptor.name), description_hash };
  };
  const decide = (ref: Awaited<ReturnType<typeof add>>, action: "approve" | "revoke" = "approve") => approvals.record(ref, action, ME as never);
  const lists = () => db.all("SELECT * FROM ext_mcp_tool_lists ORDER BY name");
  /** Every row of the approval and entry tables, as text. */
  const others = async () => JSON.stringify([await db.all("SELECT * FROM ext_packs_entries ORDER BY id"), await db.all("SELECT * FROM ext_packs_approvals ORDER BY seq")]);
  const request = () => requestMcpToolLists(db, now, ME);
  const list = (start: StartMcpServer, by = "host:1:0") => listRequestedMcpTools({ db, now, by, start });
  return { clock, store, db, add, addPack, decide, lists, others, request, list };
}

describe("plugins import: tools of an approved imported MCP server", () => {
  it("lists the tool names through startPackMcpServer with an empty env and no credential, calling only initialize and tools/list", async () => {
    const s = await listSetup();
    const f = fakeServer();
    const ref = await s.add("docs", { command: f.command, args: f.args });
    await s.decide(ref);
    vi.stubEnv("DOCS_TOKEN", SENTINEL);
    await s.request();
    expect(await s.lists()).toMatchObject([{ name: "docs", description_hash: ref.description_hash, status: "requested", requested_by: ME, tools: null }]);
    const before = await s.others();
    await s.list(startPackMcpServer);
    const [row] = await s.lists();
    expect(row).toMatchObject({ status: "listed", claimed_by: "host:1:0" });
    expect(JSON.parse(String(row!.tools))).toEqual(["search", "fetch"]);
    const rec = f.recorded();
    // macOS adds its own __CF_USER_TEXT_ENCODING to every process; nothing else is there.
    expect(Object.keys(rec.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
    expect(rec.text).not.toContain(SENTINEL);
    expect(rec.methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(rec.methods).not.toContain("tools/call");
    // Tool names only; the approval and entry tables are as they were.
    expect(JSON.stringify(await s.lists())).not.toContain(DESCRIPTION_TEXT);
    expect(await s.others()).toBe(before);
  });

  it("a waiting, off or changed server starts nothing, writes no request and lists no tools", async () => {
    const s = await listSetup();
    await s.add("waiting", { command: "w" });
    const off = await s.add("off", { command: "o" });
    await s.decide(off, "approve");
    await s.decide(off, "revoke");
    await s.decide(await s.add("changed", { command: "c" }));
    await s.add("changed", { command: "c", args: ["--new"] });
    const { calls, start } = fakeStart();
    await s.request();
    await s.list(start);
    expect(await s.lists()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a pack MCP server (not imported) is not listed here", async () => {
    const s = await listSetup();
    await s.decide(await s.addPack({ name: "pack-docs", description: "A pack's server.", command: "d" }));
    await s.request();
    expect(await s.lists()).toEqual([]);
  });

  it("writes one request per description: a second read adds nothing, and a listed result stays", async () => {
    const s = await listSetup();
    await s.decide(await s.add("docs", { command: "d" }));
    await s.request();
    await s.request();
    expect(await s.lists()).toHaveLength(1);
    const { calls, start } = fakeStart();
    await s.list(start);
    await s.request();
    await s.list(start);
    expect(calls).toHaveLength(1);
    expect(await s.lists()).toMatchObject([{ status: "listed" }]);
  });

  it("two workers claim one request by a conditional update: the server starts once", async () => {
    const s = await listSetup();
    await s.decide(await s.add("docs", { command: "d" }));
    await s.request();
    let open!: () => void;
    const { calls, start } = fakeStart(["search"], new Promise<void>((r) => (open = r)));
    const both = Promise.all([s.list(start, "a:1:0"), s.list(start, "b:2:0")]);
    await waitFor(() => calls.length === 1);
    open();
    await both;
    expect(calls).toHaveLength(1);
    const [row] = await s.lists();
    expect(row).toMatchObject({ status: "listed" });
    expect(["a:1:0", "b:2:0"]).toContain(row!.claimed_by);
  });

  it("a running row left by a stopped worker is claimed again once stale", async () => {
    const s = await listSetup();
    await s.decide(await s.add("docs", { command: "d" }));
    await s.request();
    await s.db.run("UPDATE ext_mcp_tool_lists SET status = 'running', claimed_by = 'gone:1:0', updated_at = ?", [s.clock.now().toISOString()]);
    const { calls, start } = fakeStart();
    await s.list(start);
    expect(calls).toEqual([]);
    s.clock.advance(MCP_LIST_STALE_MS + 1000);
    await s.list(start);
    expect(await s.lists()).toMatchObject([{ status: "listed", claimed_by: "host:1:0" }]);
  });

  it("re-reads the approval before it starts the server: a revoked one ends not_approved and starts no process", async () => {
    const s = await listSetup();
    const ref = await s.add("docs", { command: "d" });
    await s.decide(ref);
    await s.request();
    await s.decide(ref, "revoke");
    const { calls, start } = fakeStart();
    await s.list(start);
    expect(calls).toEqual([]);
    expect(await s.lists()).toMatchObject([{ status: "not_approved", tools: null }]);
    // Approved again: the next read asks again.
    await s.decide(ref);
    await s.request();
    await s.list(start);
    expect(await s.lists()).toMatchObject([{ status: "listed" }]);
  });

  it("a URL-based server ends not_stdio and starts no process", async () => {
    const s = await listSetup();
    await s.decide(await s.add("remote", { type: "http", url: "https://mcp.example.com/mcp" }));
    await s.request();
    const { calls, start } = fakeStart();
    await s.list(start);
    expect(calls).toEqual([]);
    expect(await s.lists()).toMatchObject([{ status: "not_stdio", tools: null }]);
  });

  it("a server that does not start ends did_not_start with no error text stored", async () => {
    const s = await listSetup();
    await s.decide(await s.add("broken", { command: join(temp("sf-mcp-none-"), "no-such-server") }));
    await s.request();
    await s.list(startPackMcpServer);
    const rows = await s.lists();
    expect(rows).toMatchObject([{ status: "did_not_start", tools: null }]);
    const thrown = fakeStart(null);
    await s.decide(await s.add("crashes", { command: "c" }));
    await s.request();
    await s.list(thrown.start);
    const all = JSON.stringify(await s.lists());
    expect(all).not.toContain("ENOENT");
    expect(all).not.toContain(SENTINEL);
    expect((await s.lists()).map((r) => r.status)).toEqual(["did_not_start", "did_not_start"]);
  });

  it("owner answer 1: an imported server granted to a run is refused as not_started; a pack server is not", async () => {
    const s = await listSetup();
    await s.decide(await s.add("docs", { command: "d" }));
    await s.decide(await s.addPack({ name: "pack-docs", description: "A pack's server.", command: "p" }));
    const servers = [{ name: "docs", command: "d", args: [] }, { name: "pack-docs", command: "p", args: [] }];
    expect(await importedMcpRefusals(s.db, servers)).toEqual([{ grant: "pack:mcp_server:docs", reason: "not_started" }]);
  });

  it("the worker pool runs the injected listing on its tick and passes the run refusal to its workers", async () => {
    const s = await listSetup();
    const list = vi.fn(async () => {});
    const refusals = vi.fn(async () => []);
    const pool = new WorkerPool({
      id_prefix: "host:42", store: s.store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
      clock: s.clock, config: fakeConfig, prompts: fakePrompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
      list_mcp_tools: list, imported_mcp_refusals: refusals,
    });
    expect(pool.workers.every((w) => w.plugins.imported_mcp_refusals === refusals)).toBe(true);
    const stop = new AbortController();
    const running = pool.run(stop.signal);
    await waitFor(() => list.mock.calls.length > 0);
    stop.abort();
    await running;
    expect(list).toHaveBeenCalled();
  });
});
