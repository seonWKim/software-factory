// The Plugins page's read (design 09-dashboard-app and 11-packs, 2026-11-15): GET /api/v1/plugins lists what the
// agents can use in three lists, one per tab: the MCP servers that packs carry (`ext_packs_entries`, kind
// `mcp_server`), the skills of the configured skill folders and the tools (the broker's and the packs'). "Plugins"
// here means agent capabilities, never the factory's implementation plugins (docs/plugins.md).
//
// One builder (pluginRows) serves the page and `factory plugins list`, so both show the same rows. Names and
// descriptions only: an MCP server's row is its name, its descriptor's `description`, its source and its approval
// status; its descriptor body (command, args, env) never leaves the read. An imported MCP server is a pointer row
// (design 11-plugin-import): its descriptor is read from its source file now, and it is `missing` when the file no
// longer holds it. The Skills tab lists the imported skills of the sources the page has labels for (claude, codex);
// the CLI lists the others. A skill's description is its file's
// front matter `description`, never its body. An imported skill (design 11-plugin-import, an `ext_skill_refs` pointer
// read from its SKILL.md now) adds its source, path and state (`ok`, `missing`, `changed`) to its row; a folder skill's
// row has none of them. Every string leaves through the Withholder. Reading writes nothing.
// Approve and Revoke go through POST /api/v1/packs/approvals (packs-api.ts), the same path as `factory pack approve|revoke`,
// for an MCP server and for a pack tool: the page's read adds each pack tool's status (`tool_status`), the configured
// skill folders as the file holds them (`skill_folders`, [] when none) and the Settings route's token the skill folder
// edits are sent with (`settings_token`, null without the config file's writer). `factory plugins list` prints none of these.
// The tools of an approved imported MCP server (design 11-plugin-import, phase 3) are read from `ext_mcp_tool_lists`:
// GET /api/v1/plugins asks for a listing when the server's current description has none (a store row, as the page's
// factory user); a worker starts the server and stores the names. This process never starts a server.
// Skill versions under the evals path (design 06-measurement, 2026-11-25): GET /api/v1/evals/<skill>/versions and
// /diff read the imported skill's `ext_skill_versions` rows, linked to the skill's eval runs by folder hash
// (skillVersionsOf); src/skill-evals.ts re-runs a version through the same lookup.

import type { SettingsBase } from "../core/settings.js";
import type * as Compare from "../core/skill-eval-compare.js";
import type * as Stats from "../core/skill-eval-stats.js";
import type { SkillEvalStore, SkillVersion } from "../interfaces/skill-eval-store.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { storeSql, storeSqlOrNull } from "../impl/store/sql/store-sql.js";
import { McpToolListsStore, approvedImportedServers, requestMcpToolLists } from "../import/mcp-tool-lists.js";
import { PackEntriesStore } from "../packs/pack-entries.store.js";
import type { SkillRefSource, SkillState } from "../runtime/capabilities/capabilities.js";
import { BackgroundSnapshot } from "./background-refresh.js";
import { HEALTH_MIN_INTERVAL_MS } from "./health.js";
import { type CapabilityDeps, type UiCapabilitySources, capabilityRows, settingsSources } from "./capabilities-api.js";
import { type ApiDeps, type ApiResult, apiError } from "./api.js";
import type { skillOf } from "./evals-api.js";
import type { UiSettings } from "./settings-api.js";
import { Withholder } from "./withhold.js";

export const PLUGINS_PATH = "/api/v1/plugins";
/** The config file key the Plugins page's skill folder edits write (core/config-writer.ts FILE_ONLY_KEYS). */
export const SKILL_FOLDERS_KEY = "capabilities.skill_folders";

/** The page's tabs and the CLI's `--kind` values, in tab order. */
export const PLUGIN_KINDS = ["mcp", "skill", "tool"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * An MCP server's status: `approved` (its current description's latest approval row is an approve), `off` (that
 * row is a revoke: the owner turned it off), `waiting` (no row for this description: never approved, or changed
 * since its approval, so the pin asks again; an imported server whose file entry changed since import too),
 * `missing` (an imported server whose source file no longer holds it: nothing runs it).
 */
export type McpStatus = "approved" | "waiting" | "off" | "missing";

export interface McpRow {
  name: string;
  /** The descriptor's `description`; null when it has none. */
  description: string | null;
  /** Where it comes from: a pack, added or imported. */
  source: "pack";
  status: McpStatus;
}

export interface SkillRow {
  name: string;
  folder: string;
  /** The skill file's front matter `description`; null when it has none. */
  description: string | null;
  roles: string[];
  last_used: string | null;
  /** An imported skill: where it was found (absent: a skill folder's). */
  source?: SkillRefSource;
  /** An imported skill: its SKILL.md path. */
  path?: string;
  /** An imported skill: `ok`, or `missing` or `changed` (not offered to agents). */
  state?: SkillState;
}

export interface ToolRow {
  /** The name `tool_grants` gives it (`pack:tool:<name>` for a pack's); `mcp:<server>:<tool>` or `mcp:<server>` for an imported MCP server's. */
  name: string;
  description: string;
  read_only: boolean;
  origin: "broker" | "pack" | "mcp";
  roles: string[];
  last_used: string | null;
}

export interface PluginRows {
  mcp: McpRow[];
  skills: SkillRow[];
  tools: ToolRow[];
}

/** Each stored entry of `kind`: its current description (the one added last, an imported server's read from its file) and its status, by name. */
async function entryRows(d: Pick<CapabilityDeps, "store">, kind: "mcp_server" | "tool"): Promise<McpRow[]> {
  const db = storeSql(d.store);
  const entries = new PackEntriesStore(db, () => "");
  const approvals = await db.all("SELECT name, description_hash, action FROM ext_packs_approvals WHERE kind = ? ORDER BY seq", [kind]);
  const latest = new Map(approvals.map((a) => [`${String(a.name)}\n${String(a.description_hash)}`, String(a.action)]));
  const out: McpRow[] = [];
  for (const name of await entries.names(kind)) {
    const e = (await entries.current(kind, name))!;
    const action = e.imported?.state === "ok" || e.imported === null ? latest.get(`${name}\n${e.description_hash}`) : undefined;
    const status: McpStatus = e.imported?.state === "missing" ? "missing" : action === "approve" ? "approved" : action === "revoke" ? "off" : "waiting";
    out.push({ name, description: typeof e.descriptor.description === "string" ? e.descriptor.description : null, source: "pack", status });
  }
  return out;
}

/** What an imported server's row says while it has no tool names: listing or not stdio. */
const MCP_LIST_NOTE = {
  requested: "listing its tools",
  running: "listing its tools",
  not_approved: "listing its tools",
  not_stdio: "not a stdio server: its tools are not listed",
} as const;

/** An imported server's row with no tool names: "Couldn't start <name>" (no error text), else its list note. */
const mcpServerNote = (name: string, status: keyof typeof MCP_LIST_NOTE | "did_not_start"): string =>
  status === "did_not_start" ? `Couldn't start ${name}` : `MCP server ${name}: ${MCP_LIST_NOTE[status]}`;

/**
 * The Tools tab's rows of each approved imported MCP server, from its current description's stored listing: one per
 * tool name, or one for the server saying why there is none. Reads only. Not read-only: never granted to a run.
 */
async function mcpToolRows(d: Pick<CapabilityDeps, "store">): Promise<ToolRow[]> {
  const db = storeSql(d.store);
  const lists = new Map((await new McpToolListsStore(db, () => "").all()).map((l) => [`${l.name}\n${l.description_hash}`, l]));
  const out: ToolRow[] = [];
  const row = (name: string, description: string): ToolRow => ({ name, description, read_only: false, origin: "mcp", roles: [], last_used: null });
  for (const server of await approvedImportedServers(db)) {
    const list = lists.get(`${server.name}\n${server.description_hash}`);
    if (list?.status === "listed") out.push(...list.tools.map((tool) => row(`mcp:${server.name}:${tool}`, `From MCP server ${server.name}`)));
    else out.push(row(`mcp:${server.name}`, mcpServerNote(server.name, list?.status ?? "requested")));
  }
  return out;
}

/** The three lists: MCP servers, skills and tools, every string through the Withholder. */
export async function pluginRows(d: CapabilityDeps, base: SettingsBase, sources: UiCapabilitySources): Promise<PluginRows> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const caps = await capabilityRows(d, base, sources);
  const mcp: McpRow[] = [];
  for (const m of await entryRows(d, "mcp_server")) mcp.push({ ...m, name: await text(m.name), description: m.description === null ? null : await text(m.description) });
  const mcpTools: ToolRow[] = [];
  for (const r of await mcpToolRows(d)) mcpTools.push({ ...r, name: await text(r.name), description: await text(r.description) });
  return {
    mcp,
    skills: caps.filter((c) => c.kind === "skill").map((c): SkillRow => ({
      name: c.name, folder: c.detail ?? "", description: c.description ?? null, roles: c.roles, last_used: c.last_used,
      ...(c.imported ? { source: c.imported.source, path: c.imported.path, state: c.imported.state } : {}),
    })),
    tools: caps
      .filter((c) => c.kind === "tool")
      .map((c): ToolRow => ({ name: c.name, description: c.detail ?? "", read_only: c.read_only === true, origin: c.origin ?? "broker", roles: c.roles, last_used: c.last_used }))
      .concat(mcpTools),
  };
}

/** The configured skill folders as the file holds them, each through the Withholder; [] when none is configured. */
async function skillFolders(s: UiSettings, w: Withholder): Promise<string[]> {
  const raw = s.editFile?.fileKeys?.().editable.find((k) => k.key === SKILL_FOLDERS_KEY)?.value ?? null;
  const list = raw === null ? [] : (JSON.parse(raw) as unknown);
  const out: string[] = [];
  for (const f of Array.isArray(list) ? list : []) if (typeof f === "string") out.push((await w.plain(f)).text);
  return out;
}

/**
 * GET /api/v1/plugins: the three lists; the token of the pack write route (null when the page cannot approve, import
 * or add); each pack tool's status by its row name; the configured skill folders; and the Settings route's token for
 * the skill folder edits (null when this process has no config file writer). With a factory user it first asks for
 * the tool listing of each approved imported MCP server that has none (a request row only: the worker starts the
 * server); with none, nothing is asked.
 */
export async function readPlugins(d: ApiDeps): Promise<ApiResult> {
  if (!d.settings) return { status: 404, value: { error: "Not found." } };
  const snap = snapshots.get(d);
  const r = snap ? snap.read() : { state: "ready" as const, value: await discover(d, d.settings), as_of: d.clock.now(), refreshing: false };
  const writer = d.settings.editFile?.fileKeys !== undefined;
  // The tokens belong to this request, never to the stored lists.
  const tokens = { csrf_token: d.pauses?.auth !== undefined ? d.pauses.csrfToken : null, settings_token: writer ? d.settings.csrfToken : null };
  // Before the first listing ends (pending) or with no good one (failed): no lists, the page keeps its placeholder or
  // shows the error with Retry (design 09-dashboard-settings, 2026-11-19).
  if (r.state !== "ready") return { status: 200, value: { as_of: null, pending: r.state === "pending", failed: r.state === "failed", refreshing: r.state === "pending", ...tokens } };
  return {
    status: 200,
    value: { as_of: r.as_of.toISOString(), pending: false, failed: false, refreshing: r.refreshing, csrf_token: tokens.csrf_token, ...r.value, settings_token: tokens.settings_token },
  };
}

/** The slow part of the read, everything but the tokens: the three lists, each pack tool's status and the skill folders. */
async function discover(d: ApiDeps, settings: UiSettings) {
  const user = d.pauses ? await d.pauses.principal() : null;
  if (user !== null) await requestMcpToolLists(storeSql(d.store), () => d.clock.now().toISOString(), user);
  const rows = await pluginRows(d, settings.base, await settingsSources(settings));
  const stored = new Map((await entryRows(d, "tool")).map((t) => [`pack:tool:${t.name}`, t.status]));
  const tool_status: Record<string, McpStatus> = {};
  for (const t of rows.tools) if (t.origin === "pack") tool_status[t.name] = stored.get(t.name) ?? "waiting";
  return {
    ...rows,
    skills: rows.skills.filter((r) => r.source === undefined || PAGE_SKILL_SOURCES.includes(r.source)),
    tool_status,
    skill_folders: await skillFolders(settings, new Withholder(d.scanner)),
  };
}

/** The stored listings the UI server installed, by the deps object its routes read with. None: the read is live. */
const snapshots = new WeakMap<ApiDeps, BackgroundSnapshot<Awaited<ReturnType<typeof discover>>>>();

/**
 * Installs the stored Plugins listing for `d` (design 09-dashboard-settings, 2026-11-19): GET /api/v1/plugins answers
 * from it at once, and a read starts the same builder (`pluginRows`) in the background when the stored listing is
 * HEALTH_MIN_INTERVAL_MS old. Returns the call the server makes after a successful write: mark the listing stale and
 * start the next refresh now. A server without settings has no Plugins route, so nothing is installed.
 */
export function servePluginsStored(d: ApiDeps): { refreshNow(): void } {
  const settings = d.settings;
  if (!settings) return { refreshNow: () => undefined };
  const snap = new BackgroundSnapshot(() => discover(d, settings), d.clock, HEALTH_MIN_INTERVAL_MS);
  snapshots.set(d, snap);
  return {
    refreshNow: () => {
      snap.markStale();
      snap.refreshInBackground();
    },
  };
}

/** The imported skills' sources the page has a label for; `factory plugins list` lists the others too. */
const PAGE_SKILL_SOURCES: readonly string[] = ["claude", "codex"];

const roles = (r: readonly string[]) => (r.length > 0 ? r.join(",") : "-");
const or = (v: string | null) => (v === null || v === "" ? "-" : v);

/** `factory plugins list`'s lines for one kind: one row per line, the page's columns separated by two spaces. */
export function pluginLines(rows: PluginRows, kind: PluginKind): string[] {
  if (kind === "mcp") return rows.mcp.map((m) => [m.name, m.status, m.source, or(m.description)].join("  "));
  if (kind === "skill") return rows.skills.map((s) => [s.name, s.folder, or(s.description), roles(s.roles), or(s.last_used)].join("  "));
  return rows.tools.map((t) => [t.name, t.origin, t.read_only ? "read-only" : "writes", roles(t.roles), or(t.last_used), or(t.description)].join("  "));
}

/** /api/v1/evals/<skill>/versions and /diff, with the URL-encoded skill_ref and the read as its groups. */
export const EVALS_VERSIONS_PATH = /^\/api\/v1\/evals\/([^/]+)\/(versions|diff)$/;

/**
 * The versions (oldest first) of the imported skill that holds one of `hashes` (folder hashes, the first that one
 * holds wins): every `ext_skill_versions` row of that ref. A run is linked to a version only by this hash; [] when
 * none holds one, or the store is not a SQL store.
 */
export async function skillVersionsOf(store: Pick<SkillEvalStore, "listSkillVersions">, hashes: readonly (string | null)[]): Promise<SkillVersion[]> {
  const db = storeSqlOrNull(store as FactoryStore);
  const wanted = [...new Set(hashes.filter((h): h is string => h !== null && h !== ""))];
  if (db === null || wanted.length === 0) return [];
  const hits = await db.all(`SELECT ref_id, folder_hash FROM ext_skill_versions WHERE folder_hash IN (${wanted.map(() => "?").join(", ")}) ORDER BY ref_id`, wanted);
  const ref = wanted.map((h) => hits.find((r) => r.folder_hash === h)).find((r) => r !== undefined);
  return ref ? store.listSkillVersions(String(ref.ref_id)) : [];
}

/** src/core/skill-eval-compare.ts's version reads and evals-api.ts skillOf, passed in by the route table (read-routes.ts). */
export type SkillVersionReads = Pick<typeof Compare, "skillVersionRows" | "unlinkedRuns" | "latestLinkedRun" | "lineDiff" | "caseResults"> & Pick<typeof Stats, "wilsonInterval"> & { skillOf: typeof skillOf };

type VersionsDeps = { store: Pick<FactoryStore, "listSkillEvalRuns" | "listSkillEvalReplays" | "listSkillVersions" | "getSkillVersionGate">; scanner: ApiDeps["scanner"] };

/**
 * GET /api/v1/evals/<skill>/versions: { versions, unlinked }, one row per version of the skill (skillVersionRows:
 * latest pass rate, change since the previous version, gate state and the gate's current version marked), newest first, and the ids of the skill's runs
 * linked to no version. GET /api/v1/evals/<skill>/diff?a=<hash>&b=<hash>: each version's row, the unified line diff
 * of their SKILL.md texts and the per-case results of each one's latest linked run; 404 when a hash is no version of
 * the skill. Every string leaves through the Withholder; the reads write nothing.
 */
export async function readSkillVersions(d: VersionsDeps, f: SkillVersionReads, url: URL): Promise<ApiResult> {
  const [, encoded, read] = EVALS_VERSIONS_PATH.exec(url.pathname) ?? [];
  const skill = f.skillOf(encoded);
  if (typeof skill !== "string") return skill;
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const runs = await d.store.listSkillEvalRuns(skill);
  const versions = await skillVersionsOf(d.store, runs.map((r) => r.skill_version));
  const gated = await Promise.all(versions.map(async (v) => ({ ...v, gate: (await d.store.getSkillVersionGate(v.ref_id, v.version))?.state ?? null })));
  const rows = await Promise.all(f.skillVersionRows(gated, runs).map(async (r) => ({ ...r, folder_hash: await text(r.folder_hash), run_id: r.run_id === null ? null : await text(r.run_id) })));
  if (read === "versions") {
    // Per version, from its newest linked run's replays: the 95% interval of the pass rate, the cost, and each case's verdict.
    const detail = async (hash: string) => {
      const run = f.latestLinkedRun(runs, hash);
      const replays = run ? await d.store.listSkillEvalReplays(run.id) : [];
      const passes = replays.filter((r) => r.verdict === "pass").length;
      const interval = f.wilsonInterval(passes, replays.length);
      const costs = replays.map((r) => r.cost_usd).filter((c): c is number => typeof c === "number");
      const cases = new Map<string, string>();
      for (const r of replays) if (!cases.has(r.case_id)) cases.set(r.case_id, r.verdict);
      return { interval, cost_usd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null, cases: [...cases].sort(([x], [y]) => x.localeCompare(y)) };
    };
    const full = await Promise.all(rows.map(async (r) => {
      const x = await detail(versions.find((v) => v.version === r.version)!.folder_hash);
      return { ...r, band: x.interval === null ? null : { low: x.interval.low, high: x.interval.high }, cost_usd: x.cost_usd, cases: await Promise.all(x.cases.map(async ([case_id, verdict]) => ({ case_id: await text(case_id), verdict: await text(verdict) }))) };
    }));
    return { status: 200, value: { versions: full, unlinked: await Promise.all(f.unlinkedRuns(versions, runs).map((r) => text(r.id))) } };
  }
  const a = url.searchParams.get("a"), b = url.searchParams.get("b");
  if (!a || !b) return apiError(400, "Name both versions: ?a=<hash>&b=<hash>.");
  const va = versions.find((v) => v.folder_hash === a), vb = versions.find((v) => v.folder_hash === b);
  if (!va || !vb) return apiError(404, "No such version of this skill.");
  const replays = async (hash: string) => {
    const run = f.latestLinkedRun(runs, hash);
    return run ? d.store.listSkillEvalReplays(run.id) : [];
  };
  const lines = await Promise.all(f.lineDiff(va.text, vb.text).map(async (l) => ({ op: l.op, text: await text(l.text) })));
  const cases = await Promise.all(f.caseResults(await replays(a), await replays(b)).map(async (c) => ({ ...c, case_id: await text(c.case_id) })));
  const row = (v: SkillVersion) => rows.find((r) => r.version === v.version)!;
  return { status: 200, value: { a: row(va), b: row(vb), lines, cases } };
}
