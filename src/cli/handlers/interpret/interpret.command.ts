import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Plugins, buildStatsStore, localAuth, localProject } from "../../../compose.js";
import { SENTENCE_FORM } from "../../../core/command-table.js";
import { cliUserConfig } from "../../../core/config.js";
import { cliIdentity } from "../../../core/local-cli.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";
import { parseSentence, runSentence } from "./sentence.js";

/**
 * `factory "<words>"` (design 04-gate-commands): the CLI sentence form. src/main.ts runs it for any first word no
 * command claims; its name is the form itself, so no word of its own is taken.
 */
export default defineCommand({
  names: [SENTENCE_FORM],
  usage: `  ${`${SENTENCE_FORM}`.padEnd(40)} A command in your own words: printed as typed lines with a proposal ID and stored
               pending; nothing changes until \`factory confirm <proposal-id>\` (one model call, as plugins.llm)`,
  async run(args, ctx) {
    const parsed = parseSentence(args);
    if ("error" in parsed) {
      console.error(`${parsed.error}\n${ctx.usage}`);
      return 1;
    }
    const loaded = await ctx.load();
    const identity = cliIdentity(cliUserConfig(loaded.file), await cliEnvironment(loaded.root));
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const store = await buildStatsStore(loaded);
    try {
      await store.migrate();
      const p = new Plugins(loaded);
      const secrets = await p.secrets();
      const auth = await localAuth(loaded, store);
      const repo = { owner: loaded.config.repo.owner, name: loaded.config.repo.name };
      // The same approve_spec check a plain reply gets, through the local auth plugin on the project (no forge call).
      const refusal = async () => {
        const project = (await storeProjectResolver(store, repo)()) ?? (loaded.config.local_only ? localProject(repo) : null);
        if (!project) return "no project key is stored yet; start the factory once first";
        const d = await auth.authorize({ user_id: identity.user, attributes: {} }, "approve_spec", { kind: "project", id: project.key });
        return d.allow ? null : d.reason;
      };
      const r = await runSentence(
        { store, llm: await p.llm(secrets), scanner: await p.scanner(secrets), identity, refusal, newId: () => randomUUID() },
        parsed.text,
      );
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    } finally {
      await store.close();
    }
  },
});
