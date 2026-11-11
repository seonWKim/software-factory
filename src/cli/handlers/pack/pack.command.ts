import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Plugins } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { cliIdentity } from "../../../core/local-cli.js";
import { storeSql } from "../../../impl/store/sql/store-sql.js";
import { PackEntriesStore, addLine, addPack } from "../../../packs/pack-entries.store.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

export default defineCommand({
  names: ["pack"],
  usage: `  pack add <path>
               scans the pack's tools/*.json and mcp_servers/*.json (egress, credential leak, tool poisoning) and
               stores each passing entry as pending; a failing one is refused, naming the rule. Starts nothing.
               Exits 1 when any entry is refused`,
  async run(args, ctx) {
    const [sub, path, ...rest] = args;
    if (sub !== "add" || path === undefined || rest.length > 0) {
      console.error(`usage: factory pack add <path>\n\n${ctx.usage}`);
      return 1;
    }
    const loaded = await ctx.load();
    let cliUser;
    try {
      cliUser = cliUserConfig(loaded.file);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    const added_by = cliIdentity(cliUser, await cliEnvironment(loaded.root)).user;
    // The configured clock, egress scanner and store, through the same registry as build() (design 11-packs).
    const p = new Plugins(loaded);
    const clock = await p.clock();
    const secrets = await p.secrets();
    const scanner = await p.scanner(secrets);
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const store = await p.store(secrets, clock);
    try {
      await store.migrate();
      const entries = new PackEntriesStore(storeSql(store), () => clock.now().toISOString());
      const results = await addPack({ path: resolve(path), store: entries, scanner, added_by });
      if (results.length === 0) console.log(`no tools/*.json or mcp_servers/*.json under ${resolve(path)}`);
      for (const r of results) (r.outcome === "refused" ? console.error : console.log)(addLine(r));
      return results.some((r) => r.outcome === "refused") ? 1 : 0;
    } finally {
      await store.close();
    }
  },
});
