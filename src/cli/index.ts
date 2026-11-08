// CLI component (RFC 0015 §6.1): every `cli/handlers/<command>/<command>.command.ts`, found by pattern.

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
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
