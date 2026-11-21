import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CLI_TOP_WORDS, HELP_WORD, cliName, cliUsageLines, parseLocalCliArgs, resolveItem, runLocalCli } from "../../../core/local-cli.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";
import { lastRefusedLines, refusalHint } from "./refused.js";

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
    const identity = await ctx.identity();
    // The wrapper's command name (FACTORY_CLI_NAME, else `factory`), read as src/main.ts reads it for the sentence form.
    const cli = cliName(process.env);
    return ctx.withStore(async (store, loaded) => {
      const { owner, name } = loaded.config.repo;
      const resolveProject = storeProjectResolver(store, { owner, name });
      const r = await runLocalCli(
        {
          store,
          identity,
          project: async () => (await resolveProject())?.key ?? null,
          read: (path) => readFile(path, "utf8"),
          newId: () => randomUUID(),
          cli,
          ui: loaded.file.ui ?? {},
        },
        action,
      );
      // A refused command's answer for the CLI sender (design 04-gate-commands, 2026-11-13), under the item's full ID.
      if (r.code === 0 && (action.action === "show" || action.action === "command")) {
        const item = await resolveItem(store, action.id);
        const id = "lines" in item ? action.id : item.id;
        r.lines.push(...(action.action === "show" ? lastRefusedLines(await store.listItemMessages(id)) : [refusalHint(id, cli)]));
      }
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
