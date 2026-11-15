import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginsCommand from "../src/cli/handlers/plugins/plugins.command.js";
import { Plugins, loadConfig } from "../src/compose.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { scanUserConfigs } from "../src/import/scan.js";
import { parseToml } from "../src/import/toml.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";

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

  it("stores an MCP server as a pending mcp_server entry whose descriptor holds env key names only", async () => {
    const root = codeRoot();
    expect((await run(root, home(), ["import", "--kind", "mcp_server"])).code).toBe(0);
    const { entries } = await rows(root);
    expect(entries.map((e) => [e.kind, e.name, e.status])).toEqual([
      ["mcp_server", "docs", "pending"],
      ["mcp_server", "notes", "pending"],
      ["mcp_server", "remote", "pending"],
      ["mcp_server", "search", "pending"],
    ]);
    const docs = JSON.parse(String(entries[0]!.descriptor)) as Record<string, unknown>;
    expect(docs).toMatchObject({ name: "docs", source: "claude", command: "npx", args: ["-y", "docs-server"], env_keys: ["DOCS_TOKEN", "DOCS_URL"] });
    expect(docs).not.toHaveProperty("env");
    const notes = JSON.parse(String(entries[1]!.descriptor)) as Record<string, unknown>;
    expect(notes).toMatchObject({ name: "notes", source: "codex", command: "notes", env_keys: ["NOTES_TOKEN"] });
    const remote = JSON.parse(String(entries[2]!.descriptor)) as Record<string, unknown>;
    expect(remote).toMatchObject({ type: "http", url: "https://mcp.example.com/mcp", header_keys: ["Authorization"] });
    expect(entries.every((e) => e.credential_name === null)).toBe(true);
  });

  it("the sentinel env value of each format appears in no stdout, stderr, store row or written file", async () => {
    const root = codeRoot();
    const h = home();
    const lines: string[] = [];
    for (const args of [["import", "--dry-run"], ["import"], ["import"], ["import", "--from", "codex"]]) {
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
    expect((await run(root, h, ["import", "--kind", "skill", "--from", "claude"])).code).toBe(0);
    const { entries, skills } = await rows(root);
    expect(entries).toEqual([]);
    const path = join(h, ".claude", "skills", "review-helper", "SKILL.md");
    expect(skills).toEqual([
      expect.objectContaining({ source: "claude", name: "review-helper", path, sha256: createHash("sha256").update(SKILL_TEXT).digest("hex") }),
    ]);
    expect(JSON.stringify(skills)).not.toContain("Review the diff");
  });
});

describe("plugins import: filters", () => {
  it("--kind limits the scan to its kind and --from to its source", async () => {
    const h = home();
    const names = async (args: string[]) => (await run(codeRoot(), h, ["import", "--dry-run", ...args])).out.filter((l) => l.startsWith("found "));
    expect(await names(["--kind", "skill"])).toEqual(["found skill review-helper from claude", "found skill deploy from codex"]);
    expect(await names(["--kind=mcp_server", "--from=codex"])).toEqual(["found mcp_server notes from codex", "found mcp_server search from codex"]);
    expect(await names(["--from", "claude", "--kind", "all"])).toEqual([
      "found skill review-helper from claude", "found mcp_server docs from claude", "found mcp_server remote from claude",
    ]);
  });

  it("refuses an unknown kind, source or flag with the usage and exit 1", async () => {
    const h = home();
    for (const args of [["import", "--kind", "tool"], ["import", "--from", "cursor"], ["import", "--force"], ["export"]]) {
      const r = await run(codeRoot(), h, args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err.join("\n")).toMatch(/usage: factory plugins import/);
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
