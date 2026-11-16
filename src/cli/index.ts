// CLI component (RFC 0015 §6.1): every `cli/handlers/<command>/<command>.command.ts`, found by pattern.

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { findDescriptorFiles } from "../state/index.js";
import { COMMAND_FILE, type CommandDescriptor, defineCommand } from "./command.js";

export { defineCommand, type CommandCall, type CommandContext, type CommandDescriptor } from "./command.js";

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

/** The fewest letters a first word needs before it may be read as a mistyped command name (design 04-gate-commands). */
export const TYPO_MIN_LENGTH = 4;
/** The most edits between a first word and a command name for it to be read as that name mistyped. */
export const TYPO_MAX_EDITS = 2;

/**
 * The edit distance between `a` and `b` (optimal string alignment): insertions, deletions and substitutions of one
 * letter, and swaps of two neighbouring letters, one edit each.
 */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!, up = d[i - 1]!;
      row[j] = Math.min(up[j]! + 1, row[j - 1]! + 1, up[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The command name `word` most likely mistypes, for a word of TYPO_MIN_LENGTH or more: the nearest within
 * TYPO_MAX_EDITS, on a tie the one closest to its length (`stauts` is `status`, not `stats`); else null.
 */
export function mistypedName(names: Iterable<string>, word: string): string | null {
  if (word.length < TYPO_MIN_LENGTH) return null;
  let best: { name: string; d: number; len: number } | null = null;
  for (const name of names) {
    const d = editDistance(word, name), len = Math.abs(word.length - name.length);
    if (d <= TYPO_MAX_EDITS && (best === null || d < best.d || (d === best.d && len < best.len))) best = { name, d, len };
  }
  return best?.name ?? null;
}

/** What a mistyped first word runs: one line naming the command it is near, exit 1; no model call, no store. */
function typoReply(word: string, name: string): CommandDescriptor {
  return defineCommand({
    names: [word],
    usage: "",
    run: async () => {
      console.error(`unknown command ${word}, did you mean ${name}?`);
      return 1;
    },
  });
}

/**
 * The command `factory <cmd> <args...>` runs, the name it is called by and its arguments; null for none (print the
 * usage). A first word no command claims, unless it is a flag, runs `fallback` (main.ts: the sentence form,
 * `factory "<words>"`, design 04-gate-commands), which gets every word, the first included; but a first word within
 * TYPO_MAX_EDITS of a command name (mistypedName) runs the typo reply instead, so a typo never reaches the model.
 */
export function resolveCommand(
  commands: ReadonlyMap<string, CommandDescriptor>, fallback: CommandDescriptor, cmd: string | undefined, args: readonly string[],
): { command: CommandDescriptor; name: string; args: readonly string[] } | null {
  if (cmd === undefined) return null;
  const known = commands.get(cmd);
  if (known) return { command: known, name: cmd, args };
  if (cmd.startsWith("-")) return null;
  const near = mistypedName(commands.keys(), cmd);
  if (near !== null) return { command: typoReply(cmd, near), name: cmd, args };
  return { command: fallback, name: fallback.names[0]!, args: [cmd, ...args] };
}
