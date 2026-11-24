import type { UserId } from "./types.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";
import { topWords } from "./command-table.js";

// The CLI's identity and names (split from src/core/local-cli.ts, issue #834): who a command acts as, the hints' command name, the CLI key prefix.

/** Where the CLI identity came from. */
export type CliIdentitySource = "cli_user" | "git user.email" | "OS user" | "anonymous" | "linked chat account";

export interface CliIdentity {
  /** The factory user ID every CLI command acts as: `cli_user`, or `local:<value>`. */
  user: UserId;
  from: CliIdentitySource;
}

/** What the environment says about the operator; each null when unavailable. Read by main.ts, never here. */
export interface CliEnvironment {
  gitEmail: string | null;
  osUser: string | null;
}

/** The identity used when nothing in the environment names the operator. */
export const ANONYMOUS = "anonymous";

/**
 * The CLI identity (issue #318): `cli_user` from factory.config.json when set; else `local:<git user.email>`;
 * else `local:<OS user name>`; else `local:anonymous`. Keys only (an email or a login name), never a display
 * name such as git's `user.name`. A value with whitespace is skipped.
 */
export function cliIdentity(cliUser: UserId | null, env: CliEnvironment): CliIdentity {
  if (cliUser !== null) return { user: cliUser, from: "cli_user" };
  const ok = (v: string | null): v is string => v !== null && /^\S+$/.test(v.trim());
  if (ok(env.gitEmail)) return { user: `local:${env.gitEmail.trim().toLowerCase()}` as UserId, from: "git user.email" };
  if (ok(env.osUser)) return { user: `local:${env.osUser.trim()}` as UserId, from: "OS user" };
  return { user: `local:${ANONYMOUS}` as UserId, from: "anonymous" };
}

/** The identity a CLI command's actor has at intake: provider `local`, subject the actor after `local:`. */
export function localIdentity(actor: string): ExternalIdentity {
  return { provider: "local", subject: actor.startsWith("local:") ? actor.slice("local:".length) : actor };
}

export const ANONYMOUS_USER = `local:${ANONYMOUS}` as UserId;
export const CLI_KEY_PREFIX = "cli:";

/** Whether a command inbox key (or the comment id of its event) is a CLI command's: `cli:<random id>`. */
export function isCliCommandKey(key: string): boolean {
  return key.startsWith(CLI_KEY_PREFIX);
}

/** Set by a project's wrapper (`gb`, say) to its own command name; the CLI's hints start with it (design 05-sources). */ export const CLI_NAME_ENV = "FACTORY_CLI_NAME";
/** The hints' command name when no wrapper names itself: chat replies and `/help` always use it. */ export const DEFAULT_CLI_NAME = "factory";
/** The command name the CLI's hints start with: CLI_NAME_ENV when it is one word, else DEFAULT_CLI_NAME. */
export function cliName(env: Readonly<Record<string, string | undefined>>): string {
  const v = env[CLI_NAME_ENV]?.trim();
  return v !== undefined && /^\S+$/.test(v) ? v : DEFAULT_CLI_NAME;
}

/** The top-level words `factory` hands to this module: the table's task, project, item (with `confirm`) and schedule commands. */
export const CLI_TOP_WORDS = topWords(["task", "item", "schedule"]);
/** `factory help [<id>]`: the `/help` reply, which lists every command, so it is no entry of the command table. */ export const HELP_WORD = "help";
/** `factory confirm <proposal-id>`: confirms every pending command of a stored proposal. */ export const CONFIRM_WORD = "confirm";

/**
 * The dashboard's app commands beside the item commands (design 09-dashboard-app): the command box's sentence, read by
 * the controller's plain-words reader, and a stored proposal's Cancel. Its Confirm all is `proposal_confirm`, the
 * confirm row's own name (CONFIRM_COMMAND), as `factory confirm` stores it.
 */
export const SENTENCE_APP_COMMAND = "sentence";
export const CANCEL_APP_COMMAND = "proposal_cancel";

