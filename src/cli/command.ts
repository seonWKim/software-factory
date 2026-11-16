// A CLI command (RFC 0015 §6.1): one folder under cli/handlers/<command>/ holding a `<command>.command.ts`
// whose default export is defineCommand(...). main.ts finds them by pattern; nothing lists them centrally.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type CliEnvironment, type CliIdentity, type FactoryStore, type Loaded, buildStatsStore } from "../compose.js";
import { loadedIdentity } from "./support.js";

/** What a command is called with: by main.ts, by another command (setup runs settings) or by a test. */
export interface CommandCall {
  /** The name the command was called by (one of its `names`). */
  readonly name: string;
  /** Loads factory.config.json (the --config flag or FACTORY_CONFIG wins); throws on a broken config. */
  load(): Promise<Loaded>;
  /** The full help text, for a command that prints it on a bad argument. */
  readonly usage: string;
  /** What the environment says about the operator; absent: git's user.email in the repo, then the OS user (cliEnvironment). */
  readonly environment?: (root: string) => Promise<CliEnvironment>;
  /** Opens the configured store; absent: buildStatsStore. */
  readonly openStore?: (loaded: Loaded) => Promise<FactoryStore>;
}

/** What a command runs with: its call, plus the CLI identity and the store, built once here for every command. */
export interface CommandContext extends CommandCall {  /**
   * The CLI identity the command acts as (issue #318): `cli_user`, else local:<git user.email>, else local:<OS user>,
   * else local:anonymous. Throws on a `cli_user` that is no user ID.
   */
  identity(): Promise<CliIdentity>;
  /** Runs `fn` with the configured store open and migrated (its db folder made first); closes the store after. */
  withStore<T>(fn: (store: FactoryStore, loaded: Loaded) => Promise<T>): Promise<T>;
}

export interface CommandDescriptor {
  readonly kind: "command";
  /** The words that call it; the first is its name. */
  readonly names: readonly string[];
  /** Its block of the help text, every line indented by two spaces. */
  readonly usage: string;
  run(args: readonly string[], call: CommandCall): Promise<number>;
}

export const COMMAND_FILE = /\.command\.(?:ts|js)$/;

export function defineCommand(d: Omit<CommandDescriptor, "kind" | "run"> & { run(args: readonly string[], ctx: CommandContext): Promise<number> }): CommandDescriptor {
  if (d.names.length === 0) throw new Error("a command needs at least one name");
  return { kind: "command", names: d.names, usage: d.usage, run: (args, call) => d.run(args, commandContext(call)) };
}

/** The context of `call`: identity() and withStore(fn) over its config, which each loads afresh (setup rewrites it). */
function commandContext(call: CommandCall): CommandContext {
  return {
    ...call,
    identity: async () => loadedIdentity(await call.load(), call.environment),
    async withStore(fn) {
      const loaded = await call.load();
      await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
      const store = await (call.openStore ?? buildStatsStore)(loaded);
      try {
        await store.migrate();
        return await fn(store, loaded);
      } finally {
        await store.close();
      }
    },
  };
}
