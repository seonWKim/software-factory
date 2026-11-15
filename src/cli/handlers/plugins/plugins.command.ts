import { homedir } from "node:os";
import { foundLine, importLine, storeFound } from "../../../import/import-plugins.js";
import { type Found, IMPORT_KINDS, IMPORT_SOURCES, type ImportKind, type ImportSource, scanUserConfigs } from "../../../import/scan.js";
import { type CommandContext, defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

const USAGE = "usage: factory plugins import [--dry-run] [--kind skill|mcp_server|all] [--from claude|codex]";

interface ImportArgs {
  dryRun: boolean;
  kinds: readonly ImportKind[];
  sources: readonly ImportSource[];
}

/** The parsed arguments; null when they are not `import` with known flags and values. */
function parseImportArgs(args: readonly string[]): ImportArgs | null {
  const [sub, ...rest] = args;
  if (sub !== "import") return null;
  const out: ImportArgs = { dryRun: false, kinds: IMPORT_KINDS, sources: IMPORT_SOURCES };
  for (let n = 0; n < rest.length; n++) {
    const [flag, inline] = rest[n]!.split(/=(.*)/s, 2) as [string, string?];
    if (flag === "--dry-run" && inline === undefined) {
      out.dryRun = true;
      continue;
    }
    const value = inline ?? rest[++n];
    if (flag === "--kind" && value === "all") out.kinds = IMPORT_KINDS;
    else if (flag === "--kind" && (IMPORT_KINDS as readonly string[]).includes(value ?? "")) out.kinds = [value as ImportKind];
    else if (flag === "--from" && (IMPORT_SOURCES as readonly string[]).includes(value ?? "")) out.sources = [value as ImportSource];
    else return null;
  }
  return out;
}

export default defineCommand({
  names: ["plugins"],
  usage: `  plugins import [--dry-run] [--kind skill|mcp_server|all] [--from claude|codex]
               finds the skills and MCP servers in the user-level Claude Code (~/.claude.json, ~/.claude/skills/)
               and Codex (~/.codex/config.toml, ~/.codex/skills/) configs. Stores each MCP server as a pending
               pack entry with its env key names only (never a value), and each skill as a reference (path and
               SHA-256, never its text). Starts, approves and grants nothing. A second run adds nothing new.
               --dry-run lists what it finds and writes nothing. Exits 1 when a config does not parse`,
  async run(args, ctx) {
    const cmd = parseImportArgs(args);
    if (cmd === null) {
      console.error(`${USAGE}\n\n${ctx.usage}`);
      return 1;
    }
    const { found, errors } = await scanUserConfigs({ home: homedir(), sources: cmd.sources, kinds: cmd.kinds });
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
