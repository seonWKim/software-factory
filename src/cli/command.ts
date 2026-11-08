// A CLI command (RFC 0015 §6.1): one folder under cli/handlers/<command>/ holding a `<command>.command.ts`
// whose default export is defineCommand(...). main.ts finds them by pattern; nothing lists them centrally.

import type { Loaded } from "../compose.js";

export interface CommandContext {
  /** The name the command was called by (one of its `names`). */
  readonly name: string;
  /** Loads factory.config.json (the --config flag or FACTORY_CONFIG wins); throws on a broken config. */
  load(): Promise<Loaded>;
  /** The full help text, for a command that prints it on a bad argument. */
  readonly usage: string;
}

export interface CommandDescriptor {
  readonly kind: "command";
  /** The words that call it; the first is its name. */
  readonly names: readonly string[];
  /** Its block of the help text, every line indented by two spaces. */
  readonly usage: string;
  run(args: readonly string[], ctx: CommandContext): Promise<number>;
}

export const COMMAND_FILE = /\.command\.(?:ts|js)$/;

export function defineCommand(d: Omit<CommandDescriptor, "kind">): CommandDescriptor {
  if (d.names.length === 0) throw new Error("a command needs at least one name");
  return { kind: "command", ...d };
}
