#!/usr/bin/env node
// The CLI entry: reads --config, finds the command among the discovered cli/handlers/*/*.command.ts
// (RFC 0015 §6.1), and runs it. Commands are never listed here; the one exception is the sentence form, which is no
// command word but what any other first word means (design 04-gate-commands).

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHILD_ERROR_MESSAGE } from "./interfaces/updater.js";
import { CODE_ROOT_ENV, Plugins, buildStatsStore, cliConfig, loadConfig, localAuth, localProject } from "./compose.js";
import { defineCommand, loadCommands, resolveCommand } from "./cli/index.js";
import { cliEnvironment } from "./cli/support.js";
import { SENTENCE_FORM } from "./core/command-table.js";
import { cliUserConfig } from "./core/config.js";
import { cliIdentity, parseSentence, runSentence } from "./core/local-cli.js";
import { SUPERVISED_ENV } from "./supervisor.js";
import { storeProjectResolver } from "./ui/settings-api.js";

const HEADER = `factory [--config <path>] <command>

  --config <path>  load this factory.config.json instead of the checked-in one (also FACTORY_CONFIG; the flag
               wins); state_dir and worktrees_dir then resolve from its folder
`;

/**
 * `factory "<words>"`: the plain-words reader over the open items (runSentence), as the CLI identity, after the same
 * approve_spec check a plain reply gets, through the local auth plugin on the project (no forge call).
 */
const SENTENCE = defineCommand({
  names: [SENTENCE_FORM],
  usage: `  ${SENTENCE_FORM.padEnd(40)} A command in your own words: printed as typed lines under a proposal ID and stored
               pending; nothing changes until \`factory confirm <proposal-id>\` (one model call, plugins.llm)`,
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
      const refusal = async () => {
        const project = (await storeProjectResolver(store, repo)()) ?? (loaded.config.local_only ? localProject(repo) : null);
        if (!project) return "no project key is stored yet; start the factory once first";
        const d = await auth.authorize({ user_id: identity.user, attributes: {} }, "approve_spec", { kind: "project", id: project.key });
        return d.allow ? null : d.reason;
      };
      const r = await runSentence({ store, llm: await p.llm(secrets), scanner: await p.scanner(secrets), identity, refusal, newId: () => randomUUID() }, parsed.text);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    } finally {
      await store.close();
    }
  },
});

async function main(argv: readonly string[]): Promise<number> {
  // The config path is made absolute once, here; the supervisor passes that value to its children.
  const { args: [cmd, ...args], configFile } = cliConfig(argv, process.env, process.cwd());
  const commands = await loadCommands();
  const usage = `${HEADER}\n${[...new Set(commands.values()), SENTENCE].map((c) => c.usage).join("\n")}`;
  // Any other first word is the sentence form, `factory "<words>"` (resolveCommand).
  const found = resolveCommand(commands, SENTENCE, cmd, args);
  if (!found) {
    console.log(usage);
    return cmd ? 1 : 0;
  }
  // The supervisor sets the code root (its runtime copy) for its child; the cwd stays the main checkout.
  const load = () => loadConfig(process.cwd(), { codeRoot: process.env[CODE_ROOT_ENV], configFile });
  return found.command.run(found.args, { name: found.name, load, usage });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    // A supervised child tells the supervisor why, so the status page can show it; then exits.
    if (process.env[SUPERVISED_ENV] === "1" && process.send && process.connected) {
      const raw = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const code = typeof raw === "string" ? raw : undefined;
      process.send({ type: CHILD_ERROR_MESSAGE, error: message, ...(code ? { code } : {}) }, undefined, {}, () => process.exit(1));
    } else process.exit(1);
  },
);
