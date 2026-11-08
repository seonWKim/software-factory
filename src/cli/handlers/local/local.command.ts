import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStatsStore } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { ProfileStore, startIdentity, type IdentityRuntime } from "../../../identity/index.js";
import { storeSql } from "../../../impl/store/sql/store-sql.js";
import { CLI_COMMANDS, CLI_TOP_WORDS, cliIdentity, parseLocalCliArgs, runLocalCli } from "../../../core/local-cli.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

/**
 * `factory task …`, `factory approve|retry|revise|reject|resolve <id> [text]` (issue #200) and `factory merge <id>`: the store only, no
 * GitHub call. Item commands are appended to the CLI command log; the controller applies them.
 */
export default defineCommand({
  names: CLI_TOP_WORDS,
  usage: `${CLI_COMMANDS.map((c) => `  ${c.usage.padEnd(40)} ${c.description}`).join("\n")}
               local work items, read by the controller from the store whatever plugins.source lists, acting
               as the CLI identity (cli_user, else local:<git user.email>, else local:<OS user>, else
               local:anonymous), authorized by the local auth plugin (auth.local, default "local"); no GitHub call`,
  async run(args, ctx) {
    const action = parseLocalCliArgs(ctx.name as (typeof CLI_TOP_WORDS)[number], [...args]);
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
    let identityRt: IdentityRuntime | null = null;
    try {
      await store.migrate();
      // The edge (RFC 0015 §8): a command row carries the CLI identity's passport. Started only for a command.
      const passport = async () => {
        identityRt ??= await startIdentity({ db: storeSql(store), stateDir: loaded.stateDir });
        return identityRt.edge({ provider: "local", subject: identity.user }, "cli");
      };
      const { owner, name } = loaded.config.repo;
      const resolveProject = storeProjectResolver(store, { owner, name });
      const r = await runLocalCli(
        {
          store,
          identity,
          project: async () => (await resolveProject())?.key ?? null,
          read: (path) => readFile(path, "utf8"),
          newId: () => randomUUID(),
          displayNames: (ids) => new ProfileStore(storeSql(store)).displayNames(ids),
          passport,
        },
        action,
      );
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    } finally {
      await (identityRt as IdentityRuntime | null)?.stop();
      await store.close();
    }
  },
});
