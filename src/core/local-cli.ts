/**
 * The writer side of local intake (issue #200; design 05-sources.md, "CLI intake"). `factory task create`
 * creates a local work item with its triage run queued, and with `--project <slug>` also a task in that project linked
 * to it, as `task build` links one (design 02-tasks); `task add` stores a plain task from quick-add words and `task
 * done` completes one and `task reopen` undoes that, `task edit`, `task delete` and `task sub` change, remove and nest one (design 02-tasks: no
 * work item, no triage); `project …` keeps the task projects and `task project` links a task to one, unlinks it or moves it (design 02-tasks,
 * task projects); `schedule …` manages schedules (src/core/schedule.ts, design 08-schedules; writes the owner's only); `task list` and `task show`
 * read the store; `task paths` (as `/paths`), `task note` (as `/note`), `approve`,
 * `retry`, `revise`, `reject`, `resolve`, `hold` and `verdict` append one row to the CLI command log (`command_inbox`) and change no item
 * state, for an item of any source; `approve` first runs the controller's phase check (`approveRefusal`) and refuses
 * with its text before any write (issue #528), and `verdict` its parser and closed-item check (`verdictRefusal`,
 * issue #523). `confirm <proposal-id>` appends one `proposal_confirm` row for a stored proposal with a pending command
 * (design 04-gate-commands, the CLI sentence form). `help [<id>]` prints the `/help` reply. The controller reads that log and applies each command with the same
 * authorize check and the same replies as the source comment, through the auth plugin for local commands (`local`
 * by default, issue #318); a command on a sync source's item is also mirrored to it, best effort, once the source
 * answers (design 05-sources, CLI intake); a verdict or merge is not mirrored. Every command acts as the CLI identity (`cliIdentity`). The first identity to run a
 * writing command becomes the owner. No sync source call.
 */

export {
  ANONYMOUS, CANCEL_APP_COMMAND, CLI_NAME_ENV, CLI_TOP_WORDS, CONFIRM_WORD, DEFAULT_CLI_NAME, HELP_WORD, SENTENCE_APP_COMMAND,
  type CliEnvironment, type CliIdentity, type CliIdentitySource, cliIdentity, cliName, isCliCommandKey, localIdentity,
} from "./local-cli-identity.js";
export { type ItemCommand, cliCommandListMarkdown, cliUsage, cliUsageLines } from "./local-cli-parse.js";
export {
  CREATE_NEXT_STEP, type CliAction, type CliResult, type LocalCliDeps, TASK_LIST_LIMIT, resolveItem, runLocalCli, shortItemId, storedProjectCaps,
} from "./local-cli-run.js";
export { type SentenceDeps, parseSentence, runSentence } from "./local-cli-sentence.js";

import { parseLocalCliArgs as parseArgs } from "./local-cli-parse.js";
import type { CliAction } from "./local-cli-run.js";
import { COORDINATOR_USD } from "./spend.js";

/**
 * The action, or an error line (parseArgs in local-cli-parse.ts). A bare `approve` or `reject`, with no work item ID,
 * settles the newest held skill version (design 07-self-improvement), except that `reject` answers today's open
 * coordinator limit question first; with neither it fails as the parser does. `approve <usd>` (a dollar amount, such
 * as 10) answers today's open coordinator limit question (design 06-spend); with none open it is the item command it
 * reads as.
 */
export function parseLocalCliArgs(word: string, args: readonly string[]): CliAction | { error: string } {
  if ((word === "approve" || word === "reject") && args.length === 0) return { action: "settle", command: word };
  if (word === "approve" && args.length === 1 && COORDINATOR_USD.test(args[0]!)) return { action: "settle", command: word, value: args[0]! };
  return parseArgs(word, args);
}
