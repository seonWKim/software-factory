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
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { startPackMcpServer } from "../src/impl/runner/pack-mcp-client.js";
import { MCP_LIST_STALE_MS, type StartMcpServer, importedMcpRefusals, listRequestedMcpTools, requestMcpToolLists } from "../src/import/mcp-tool-lists.js";
import type { PackMcpServer } from "../src/interfaces/agent-runner.js";
import { PackApprovalsStore } from "../src/packs/pack-approvals.store.js";
import { PackEntriesStore, canonicalJson, descriptionHash } from "../src/packs/pack-entries.store.js";
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

/** An imported server's descriptor, as the scanner builds it (env key names only). */
const importedServer = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "Imported from the Claude Code user config", source: "claude", env_keys: ["DOCS_TOKEN"], ...extra });

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
  const add = async (descriptor: Record<string, unknown>) => {
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
  return { clock, store, db, add, decide, lists, others, request, list };
}

describe("plugins import: tools of an approved imported MCP server", () => {
  it("lists the tool names through startPackMcpServer with an empty env and no credential, calling only initialize and tools/list", async () => {
    const s = await listSetup();
    const f = fakeServer();
    const ref = await s.add(importedServer("docs", { command: f.command, args: f.args }));
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
    await s.add(importedServer("waiting", { command: "w" }));
    await s.decide(await s.add(importedServer("off", { command: "o" })), "approve");
    await s.decide({ kind: "mcp_server", name: "off", description_hash: descriptionHash(importedServer("off", { command: "o" }) as never) }, "revoke");
    await s.decide(await s.add(importedServer("changed", { command: "c" })));
    await s.add(importedServer("changed", { command: "c", args: ["--new"] }));
    const { calls, start } = fakeStart();
    await s.request();
    await s.list(start);
    expect(await s.lists()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a pack MCP server (not imported) is not listed here", async () => {
    const s = await listSetup();
    await s.decide(await s.add({ name: "pack-docs", description: "A pack's server.", command: "d" }));
    await s.request();
    expect(await s.lists()).toEqual([]);
  });

  it("writes one request per description: a second read adds nothing, and a listed result stays", async () => {
    const s = await listSetup();
    await s.decide(await s.add(importedServer("docs", { command: "d" })));
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
    await s.decide(await s.add(importedServer("docs", { command: "d" })));
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
    await s.decide(await s.add(importedServer("docs", { command: "d" })));
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
    const ref = await s.add(importedServer("docs", { command: "d" }));
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
    await s.decide(await s.add(importedServer("remote", { type: "http", url: "https://mcp.example.com/mcp" })));
    await s.request();
    const { calls, start } = fakeStart();
    await s.list(start);
    expect(calls).toEqual([]);
    expect(await s.lists()).toMatchObject([{ status: "not_stdio", tools: null }]);
  });

  it("a server that does not start ends did_not_start with no error text stored", async () => {
    const s = await listSetup();
    await s.decide(await s.add(importedServer("broken", { command: join(temp("sf-mcp-none-"), "no-such-server") })));
    await s.request();
    await s.list(startPackMcpServer);
    const rows = await s.lists();
    expect(rows).toMatchObject([{ status: "did_not_start", tools: null }]);
    const thrown = fakeStart(null);
    await s.decide(await s.add(importedServer("crashes", { command: "c" })));
    await s.request();
    await s.list(thrown.start);
    const all = JSON.stringify(await s.lists());
    expect(all).not.toContain("ENOENT");
    expect(all).not.toContain(SENTINEL);
    expect((await s.lists()).map((r) => r.status)).toEqual(["did_not_start", "did_not_start"]);
  });

  it("owner answer 1: an imported server granted to a run is refused as not_started; a pack server is not", async () => {
    const s = await listSetup();
    await s.decide(await s.add(importedServer("docs", { command: "d" })));
    await s.decide(await s.add({ name: "pack-docs", description: "A pack's server.", command: "p" }));
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
