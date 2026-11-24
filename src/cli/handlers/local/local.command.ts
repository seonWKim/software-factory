import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { CLI_TOP_WORDS, HELP_WORD, cliName, cliUsageLines, parseLocalCliArgs, resolveItem, runLocalCli, storedProjectCaps } from "../../../core/local-cli.js";
import { answersDetail, splitAnswers } from "../../../shared/command-notes.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { Plugins, defineCommand } from "../../command.js";
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
      // `schedule draft` and `improve` only: the configured model (null when it cannot be built: the feature is off), the
      // scanner, and a y/N ask while stdin is a terminal.
      const drafting = action.action === "schedule" && ["draft", "improve"].includes(action.command.verb) ? await draftParts(loaded) : {};
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
          answers: { split: splitAnswers, detail: answersDetail },
          ...drafting,
          caps: async (project) => storedProjectCaps(store, { file: {}, layers: loaded.config.settings }, `${owner}/${name}`, (await resolveProject())?.key ?? null, project),
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

/** The model, the egress scanner and the terminal ask `schedule draft` and `improve` take (src/core/schedule-draft.ts). */
async function draftParts(loaded: ConstructorParameters<typeof Plugins>[0]) {
  const p = new Plugins(loaded), secrets = await p.secrets();
  const llm = await p.llm(secrets).catch(() => null);
  return { llm, scanner: await p.scanner(secrets), ...(process.stdin.isTTY ? { ask: terminalAsk } : {}) };
}

/** A y/N question read from the terminal: only y or yes is a yes. */
async function terminalAsk(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
