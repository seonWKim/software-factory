import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Plugins, settingsBase } from "../../../compose.js";
import { createPlugin } from "../../../plugins.js";
import { capabilitySources } from "../../../ui/capabilities-api.js";
import { PLUGIN_KINDS, type PluginKind, pluginLines, pluginRows } from "../../../ui/plugins-api.js";
import { defineCommand } from "../../command.js";

// `factory plugins list [--kind mcp|skill|tool]` (design 09-dashboard-app, 2026-11-15): the Plugins page's rows,
// built by the same builder as GET /api/v1/plugins (pluginRows). "Plugins" are what the agents can use, not the
// factory's implementation plugins. Approve and revoke stay `factory pack approve|revoke` (decision 3).

const USAGE = `usage: factory plugins list [--kind ${PLUGIN_KINDS.join("|")}]`;

/** The kinds to list, or null when the arguments are not a plugins command. */
function parse(args: readonly string[]): readonly PluginKind[] | null {
  const [sub, ...rest] = args;
  if (sub !== "list") return null;
  if (rest.length === 0) return PLUGIN_KINDS;
  if (rest.length === 2 && rest[0] === "--kind" && (PLUGIN_KINDS as readonly string[]).includes(rest[1]!)) return [rest[1] as PluginKind];
  return null;
}

const HEADINGS: Record<PluginKind, string> = { mcp: "MCP servers", skill: "Skills", tool: "Tools" };

export default defineCommand({
  names: ["plugins"],
  usage: `  plugins list [--kind mcp|skill|tool]
               lists what the agents can use, the rows of the dashboard's Plugins page: MCP servers (name, status
               approved|waiting|off, source, description), skills (name, folder, description, roles, last used)
               and tools (name, origin, read-only, roles, last used, description). Never an env value or a
               descriptor body. Approve or revoke an MCP server with factory pack approve|revoke mcp_server <name>`,
  async run(args, ctx) {
    const kinds = parse(args);
    if (kinds === null) {
      console.error(`${USAGE}\n\n${ctx.usage}`);
      return 1;
    }
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
  },
});
