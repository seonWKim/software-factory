import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugins, settingsBase } from "../../../compose.js";
import { foundLine, importLine, storeFound } from "../../../import/import-plugins.js";
import { type Found, IMPORT_KINDS, IMPORT_SOURCES, type ImportKind, type ImportSource, type ScanResult, scanFolder, scanUserConfigs } from "../../../import/scan.js";
import { createPlugin } from "../../../plugins.js";
import { capabilitySources } from "../../../ui/capabilities-api.js";
import { PLUGIN_KINDS, type PluginKind, pluginLines, pluginRows } from "../../../ui/plugins-api.js";
import { type CommandContext, defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

// `factory plugins list [--kind mcp|skill|tool]` (design 09-dashboard-app, 2026-11-15): the Plugins page's rows,
// built by the same builder as GET /api/v1/plugins (pluginRows). "Plugins" are what the agents can use, not the
// factory's implementation plugins. Approve and revoke stay `factory pack approve|revoke` (decision 3).
// `factory plugins import` stores what Claude Code and Codex use (skills, commands and MCP servers) as pointers.

const USAGE = `usage: factory plugins list [--kind ${PLUGIN_KINDS.join("|")}]
usage: factory plugins import [--dry-run] [--kind ${IMPORT_KINDS.join("|")}|all] [--source ${IMPORT_SOURCES.join("|")}] [--from <path>]`;

/** The kinds to list, or null when the arguments are not a plugins list command. */
function parseListArgs(args: readonly string[]): readonly PluginKind[] | null {
  const [sub, ...rest] = args;
  if (sub !== "list") return null;
  if (rest.length === 0) return PLUGIN_KINDS;
  if (rest.length === 2 && rest[0] === "--kind" && (PLUGIN_KINDS as readonly string[]).includes(rest[1]!)) return [rest[1] as PluginKind];
  return null;
}

const HEADINGS: Record<PluginKind, string> = { mcp: "MCP servers", skill: "Skills", tool: "Tools" };

interface ImportArgs {
  dryRun: boolean;
  kinds: readonly ImportKind[];
  sources: readonly ImportSource[];
  /** `--from <path>`: scan only this folder. */
  from: string | null;
}

/** The parsed arguments; null when they are not `import` with known flags and values. */
function parseImportArgs(args: readonly string[]): ImportArgs | null {
  const [sub, ...rest] = args;
  if (sub !== "import") return null;
  const out: ImportArgs = { dryRun: false, kinds: IMPORT_KINDS, sources: IMPORT_SOURCES, from: null };
  for (let n = 0; n < rest.length; n++) {
    const [flag, inline] = rest[n]!.split(/=(.*)/s, 2) as [string, string?];
    if (flag === "--dry-run" && inline === undefined) {
      out.dryRun = true;
      continue;
    }
    const value = inline ?? rest[++n];
    if (flag === "--kind" && value === "all") out.kinds = IMPORT_KINDS;
    else if (flag === "--kind" && (IMPORT_KINDS as readonly string[]).includes(value ?? "")) out.kinds = [value as ImportKind];
    else if (flag === "--source" && (IMPORT_SOURCES as readonly string[]).includes(value ?? "")) out.sources = [value as ImportSource];
    else if (flag === "--from" && value !== undefined && value !== "") out.from = value;
    else return null;
  }
  return out;
}

export default defineCommand({
  names: ["plugins"],
  usage: `  plugins list [--kind mcp|skill|tool]
               lists what the agents can use, the rows of the dashboard's Plugins page: MCP servers (name, status
               approved|waiting|off, source, description), skills (name, folder, description, roles, last used)
               and tools (name, origin, read-only, roles, last used, description). Never an env value or a
               descriptor body. Approve or revoke an MCP server with factory pack approve|revoke mcp_server <name>
  plugins import [--dry-run] [--kind skill|command|mcp_server|all] [--source <source>] [--from <path>]
               finds the skills, commands and MCP servers Claude Code and Codex use: ~/.claude.json,
               ~/.claude/skills/, ~/.claude/commands/*.md, enabled Claude Code plugins, ~/.codex/config.toml,
               ~/.codex/skills/, the managed repo's .mcp.json and .claude/skills/, and Claude Desktop's config.
               --source picks one of ${IMPORT_SOURCES.join(", ")}. --from <path> scans only that folder
               (skills/<name>/SKILL.md, commands/*.md, .mcp.json). Stores every item as a pointer, never a copy:
               a skill or command as its path and SHA-256, an MCP server as its file, key and SHA-256, pending.
               A changed item updates its row; an MCP server is then pending again. Starts, approves and grants
               nothing. --dry-run lists what it finds and writes nothing. Exits 1 when a config does not parse`,
  async run(args, ctx) {
    const kinds = parseListArgs(args);
    if (kinds !== null) return list(ctx, kinds);
    const cmd = parseImportArgs(args);
    if (cmd === null) {
      console.error(`${USAGE}\n\n${ctx.usage}`);
      return 1;
    }
    const { found, errors } = await scan(ctx, cmd);
    for (const e of errors) console.error(e.message);
    const code = errors.length > 0 ? 1 : 0;
    if (cmd.dryRun) {
      for (const item of found) console.log(foundLine(item));
      console.log(`dry run: ${found.length} found, nothing stored`);
      return code;
    }
    if (found.length === 0) {
      console.log("nothing found to import");
      return code;
    }
    return Math.max(code, await store(ctx, found));
  },
});

/** The folder `--from` names, or every user-level source and the configured repo. Reads only. */
async function scan(ctx: CommandContext, cmd: ImportArgs): Promise<ScanResult> {
  if (cmd.from !== null) return scanFolder(cmd.from, cmd.kinds);
  const { repo } = (await ctx.load()).config;
  return scanUserConfigs({ home: homedir(), sources: cmd.sources, kinds: cmd.kinds, repos: [{ name: repo.name, path: repo.path }] });
}

/** Prints the Plugins page's rows of the given kinds. */
async function list(ctx: CommandContext, kinds: readonly PluginKind[]): Promise<number> {
  const loaded = await ctx.load();
  // The configured clock, egress scanner (the Withholder), store and shared storage (last used), as `factory ui` builds them.
  const p = new Plugins(loaded);
  const clock = await p.clock();
  const secrets = await p.secrets();
  const scanner = await p.scanner(secrets);
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const store = await p.store(secrets, clock);
  try {
    await store.migrate();
    const storage = await createPlugin(loaded.registry, "storage", loaded.plugins.storage, p.base);
    const rows = await pluginRows({ store, scanner, storage }, settingsBase(loaded), await capabilitySources(loaded, store));
    for (const kind of kinds) {
      if (kinds.length > 1) console.log(`${HEADINGS[kind]}:`);
      const lines = pluginLines(rows, kind);
      for (const line of lines) console.log(line);
      if (lines.length === 0) console.log(`no ${HEADINGS[kind].toLowerCase()}`);
    }
    return 0;
  } finally {
    await store.close();
  }
}

/** Stores what the scan found, as the CLI identity, in the configured store. */
async function store(ctx: CommandContext, found: readonly Found[]): Promise<number> {
  const loaded = await ctx.load();
  let results;
  try {
    results = await storeFound(loaded, await cliEnvironment(loaded.root), found);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  for (const r of results) (r.outcome === "refused" ? console.error : console.log)(importLine(r));
  return results.some((r) => r.outcome === "refused") ? 1 : 0;
}
