#!/usr/bin/env node
// The CLI entry: reads --config, finds the command among the discovered cli/handlers/*/*.command.ts
// (RFC 0015 §6.1), and runs it. Commands are never listed here.

import { CHILD_ERROR_MESSAGE } from "./interfaces/updater.js";
import { CODE_ROOT_ENV, cliConfig, loadConfig } from "./compose.js";
import { loadCommands, resolveCommand } from "./cli/index.js";
import { SUPERVISED_ENV } from "./supervisor.js";

const HEADER = `factory [--config <path>] <command>

  --config <path>  load this factory.config.json instead of the checked-in one (also FACTORY_CONFIG; the flag
               wins); state_dir and worktrees_dir then resolve from its folder
`;

async function main(argv: readonly string[]): Promise<number> {
  // The config path is made absolute once, here; the supervisor passes that value to its children.
  const { args: [cmd, ...args], configFile } = cliConfig(argv, process.env, process.cwd());
  const commands = await loadCommands();
  const usage = `${HEADER}\n${[...new Set(commands.values())].map((c) => c.usage).join("\n")}`;
  // An unknown first word is the sentence form, `factory "<words>"` (resolveCommand).
  const found = resolveCommand(commands, cmd, args);
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
