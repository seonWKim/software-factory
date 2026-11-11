// CLI component (RFC 0015 §6.1): every `cli/handlers/<command>/<command>.command.ts`, found by pattern.

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { SENTENCE_FORM } from "../core/command-table.js";
import { findDescriptorFiles } from "../state/index.js";
import { COMMAND_FILE, type CommandDescriptor } from "./command.js";

export { defineCommand, type CommandContext, type CommandDescriptor } from "./command.js";

/** Every command under this folder, by name; throws when two commands claim one word. */
export async function loadCommands(root: string = import.meta.dirname): Promise<Map<string, CommandDescriptor>> {
  const out = new Map<string, CommandDescriptor>();
  for (const file of findDescriptorFiles(root, COMMAND_FILE)) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: CommandDescriptor };
    if (mod.default?.kind !== "command") throw new Error(`${relative(root, file)}: default export must be defineCommand(...)`);
    for (const name of mod.default.names) {
      if (out.has(name)) throw new Error(`command "${name}" is defined twice (${relative(root, file)})`);
      out.set(name, mod.default);
    }
  }
  return out;
}

/**
 * The command `factory <cmd> <args...>` runs, the name it is called by and its arguments; null for none (print the
 * usage). A first word no command claims, unless it is a flag, is the sentence form (`factory "<words>"`, design
 * 04-gate-commands), which gets every word, the first included.
 */
export function resolveCommand(
  commands: ReadonlyMap<string, CommandDescriptor>, cmd: string | undefined, args: readonly string[],
): { command: CommandDescriptor; name: string; args: readonly string[] } | null {
  if (cmd === undefined) return null;
  const known = commands.get(cmd);
  if (known) return { command: known, name: cmd, args };
  const sentence = cmd.startsWith("-") ? undefined : commands.get(SENTENCE_FORM);
  return sentence ? { command: sentence, name: SENTENCE_FORM, args: [cmd, ...args] } : null;
}
