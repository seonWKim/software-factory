import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStatsStore } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { CLI_TOP_WORDS, HELP_WORD, cliIdentity, cliUsageLines, parseLocalCliArgs, runLocalCli } from "../../../core/local-cli.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";
import { lastRefusedLines, refusalHint } from "./refused.js";
import { cliEnvironment } from "../../support.js";

/**
 * `factory task …`, `factory approve|retry|revise|reject|resolve <id> [text]` (issue #200), `factory verdict <id> <verdict>`
 * (issue #523), `factory merge <id>` and `factory help [<id>]` (issue #528): the store only, no GitHub call. Item commands are appended to the CLI command log;
 * the controller applies them.
 */
export default defineCommand({
  names: [...CLI_TOP_WORDS, HELP_WORD],
  usage: `${cliUsageLines()}
               local work items, read by the controller from the store whatever plugins.source lists, acting
               as the CLI identity (cli_user, else local:<git user.email>, else local:<OS user>, else
               local:anonymous), authorized by the owner check; no GitHub call`,
  async run(args, ctx) {
    const action = parseLocalCliArgs(ctx.name, [...args]);
    if ("error" in action) {
      console.error(action.error);
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
    const identity = cliIdentity(cliUser, await cliEnvironment(loaded.root));
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const store = await buildStatsStore(loaded);
    try {
      await store.migrate();
      const { owner, name } = loaded.config.repo;
      const resolveProject = storeProjectResolver(store, { owner, name });
      const r = await runLocalCli(
        {
          store,
          identity,
          project: async () => (await resolveProject())?.key ?? null,
          read: (path) => readFile(path, "utf8"),
          newId: () => randomUUID(),
        },
        action,
      );
      // A refused command's answer for the CLI sender (design 04-gate-commands, 2026-11-13).
      if (r.code === 0 && action.action === "show") r.lines.push(...lastRefusedLines(await store.listItemMessages(action.id)));
      if (r.code === 0 && action.action === "command") r.lines.push(refusalHint(action.id));
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    } finally {
      await store.close();
    }
  },
});
