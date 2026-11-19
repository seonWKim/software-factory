// The `restart` item command (design 04-gate-commands, restart): the item page's Restart app button and
// `factory restart <id>` store the same app request; the controller refuses it or queues one restart run, the worker
// runs `repo.restart_command` in the repo's base checkout, and the controller posts the result in the item's thread.
// No item field changes. Without the command, the local merge reply says how to run the result (runHint).

import { commandText, exitText } from "./checks.js";
import { refusalText } from "./commands.js";
import { fence } from "./resolve.js";
import type { Run, UserId, WorkItem, WorkItemId } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/** The app request's command, the run kind and the CLI word. */
export const RESTART_COMMAND = "restart";
/** The state change that queued a restart run (no field changes; it records who asked). */
export const RESTART_REQUESTED = "restart_requested";
/** The state change that acknowledged a finished restart run. */
export const RESTART_DONE = "restart_done";
/** The top-level entries of the repo the run hint names when they exist: the README and the scripts folder. */
export const RUN_HINT_ENTRIES = ["README.md", "bin"] as const;
/** Why a restart is refused when the key is absent. */
export const NO_RESTART_COMMAND = "no run command is set (`repo.restart_command` in factory.config.json)";

/** The restart run's key: one run per request. */
export const restartRunKey = (requestKey: string): string => `restart:${requestKey}`;

/** Whether `it` is merged into the base: closed with its merge sha. */
export function mergedIntoBase(it: Pick<WorkItem, "stage" | "merge_sha">): boolean {
  return it.stage === "CLOSED" && it.merge_sha !== null;
}

/** Why `it` cannot be restarted now, or null: the command must be set and the item merged into the base. */
export function restartRefusal(it: Pick<WorkItem, "stage" | "merge_sha">, command: readonly string[] | undefined): string | null {
  if (command === undefined) return NO_RESTART_COMMAND;
  if (!mergedIntoBase(it)) return "the item is not merged into the base; Restart app runs the merged code, so it applies only after the merge";
  return null;
}

/**
 * How the restart run's command ended, from its result (the run's data): `not_set` (the key was removed after the
 * request), `not_started` with `start_error`, else its exit (exitText: exited N, timed out).
 */
export function restartHow(d: Record<string, unknown>): string {
  if (d.result === "not_set") return `did not run: ${NO_RESTART_COMMAND}`;
  if (d.result === "not_started") return `could not start: ${String(d.start_error)}`;
  return exitText({ exit_code: typeof d.exit_code === "number" ? d.exit_code : null, signal: typeof d.signal === "string" ? d.signal : null, timed_out: d.timed_out === true });
}

/**
 * The thread reply of a finished restart run: its command with how it ended (exit status, timed out, could not
 * start) and its output tail, already scanned by the worker (a flagged tail is withheld whole). A run that failed
 * before the command (no host exec, a lost lease) says so. Every failure says the item is unchanged.
 */
export function restartReply(run: Pick<Run, "outcome" | "work_item_id">): string {
  const again = `Press Restart app, or run \`factory restart ${run.work_item_id}\`, to try again.`;
  const o = run.outcome;
  if (o?.status !== "succeeded") {
    const why = o?.status === "failed" ? `\`${o.error_code}\`: ${o.detail}` : "it was cancelled";
    return [`The restart did not run (${why}). The item is unchanged.`, "", again].join("\n");
  }
  const d = o.data;
  const argv = Array.isArray(d.command) && d.command.every((a) => typeof a === "string") ? (d.command as string[]) : null;
  const cmd = argv ? `\`${commandText(argv)}\`` : "the restart command";
  const ok = d.result === "ok";
  const head = ok ? `Restarted the app: ${cmd} exited 0 in the base checkout.` : `The restart failed: ${cmd} ${restartHow(d)}. The item is unchanged.`;
  const output = typeof d.output_tail === "string" && d.output_tail !== ""
    ? ["", "Output (its last lines):", fence(d.output_tail)]
    : d.output_withheld === true ? ["", "Its output is withheld: the egress scan flagged it."] : [];
  return [head, ...output, ...(ok ? [] : ["", again])].join("\n");
}

/**
 * The merge reply's run hint when no `repo.restart_command` is set: it names the entries of RUN_HINT_ENTRIES that
 * exist in the repo (`found`), else says only that no run command is set.
 */
export function runHint(found: readonly string[]): string {
  const named = RUN_HINT_ENTRIES.filter((e) => found.includes(e)).map((e) => (e === "bin" ? "the scripts in `bin/`" : `\`${e}\``));
  const set = "No run command is set, so the running app still serves the old code: set `repo.restart_command` (argv, e.g. `[\"bin/restart\"]`) in factory.config.json for a Restart app button on merged items.";
  return named.length === 0 ? set : `To run the merged code, see ${named.join(" and ")} in the repository. ${set}`;
}

/** What `factory restart <id>` needs: the store, the CLI identity, the configured command and a new request key. */
export interface RestartRequestDeps {
  store: Pick<FactoryStore, "getWorkItem" | "recordAppCommandRequest">;
  user: UserId;
  command: readonly string[] | undefined;
  newKey: () => string;
}

/**
 * `factory restart <id>`: the same app request the item page's Restart app button stores (command `restart`, the
 * item ID), as the CLI identity, after the controller's refusal check so a refusal writes nothing. The controller
 * checks the owner and the item again when it applies it.
 */
export async function requestRestart(d: RestartRequestDeps, id: string): Promise<{ code: number; lines: string[] }> {
  const item = await d.store.getWorkItem(id as WorkItemId);
  if (!item) return { code: 1, lines: [`no work item ${id}`] };
  const refused = restartRefusal(item, d.command);
  if (refused !== null) return { code: 1, lines: [refusalText("factory restart", refused)] };
  const { request } = await d.store.recordAppCommandRequest({ key: d.newKey(), actor: d.user, command: RESTART_COMMAND, args: { work_item_id: item.id } });
  return {
    code: 0,
    lines: [`stored \`factory restart\` for ${item.id} as ${d.user} (request ${request.seq}); the controller queues the restart and posts its result in the item's thread`],
  };
}
