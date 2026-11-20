import { type CommandReply, type ItemCommand, type MergeReadiness, mergeInFlight, plainRefusal } from "../api.js";
import { Button } from "../components/ui/button.js";
import { t } from "../i18n/index.js";
import { type Outcome, OutcomeText } from "./command-box.js";
import { type LocalSend, awaitsReply, commandOutcome, notAllowed, useCommandSend } from "./command-send.js";

/**
 * The Merge button (design §9), on the item page and in Needs you: sends `merge` with no note (a local item's local
 * merge, as `factory merge`; any other item's PR merged on the forge at the head the review passed), then re-reads
 * the item and the list, so the controller's reply shows. Disabled with the item API's reason beside it; else the
 * latest merge reply (a refusal: the head moved, a conflict, a failing check, no approve_merge), or `returned`, why
 * the last Merge went back to merge_pending. Once pressed the button reads the merge's progress: "Merging…" while
 * the request waits for the controller or the forge merges, "Checking…" while the merge queue checks a local item's
 * merged result.
 */
export function MergeButton({ id, source, merge, replies = [], returned = null }: {
  id: string; source: string | undefined; merge: MergeReadiness; replies?: readonly CommandReply[]; returned?: string | null;
}) {
  const { on, busy, local, send: post } = useCommandSend(id);
  const send = () => post("merge", "");
  const queued = mergeInFlight(merge);
  const reply = commandOutcome(replies, "merge", local.merge);
  const back: Outcome = returned && reply?.tone !== "error" ? { tone: "error", text: plainRefusal(returned) } : null;
  const outcome: Outcome = queued ? null : merge.enabled ? (back ?? reply) : { tone: "status", text: merge.reason ?? "" };
  // Merging… from the click until the controller's reply (handled or refused) arrives.
  const merging = merge.enabled && (busy || awaitsReply(outcome));
  return (
    <span data-merge={merge.enabled ? "enabled" : "disabled"} className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        data-action="merge"
        disabled={!merge.enabled || !on || merging}
        title={source === "local"
          ? t("commands.mergeLocal")
          : t("commands.mergePr")}
        onClick={() => void send()}
      >
        {queued ? merge.reason : merging ? t("commands.merging") : t("commands.merge")}
      </Button>
      <OutcomeText outcome={outcome} />
    </span>
  );
}

/**
 * The Restart app button (design 09-dashboard-item-commands), on a merged item's page when `repo.restart_command` is
 * set: sends `restart` with no note. "Restarting…" from the click until the controller's reply, then "Restart queued"
 * (the run's result is posted in the thread) or the refusal; disabled with the controller's reason when the viewer
 * may not send it.
 */
export function RestartButton({ command, on, busy, replies, local, send }: {
  command: ItemCommand; on: boolean; busy: boolean; replies: readonly CommandReply[]; local: LocalSend | undefined; send: () => void;
}) {
  const reply = command.allowed ? commandOutcome(replies, "restart", local) : notAllowed(command);
  const waiting = command.allowed && (busy || awaitsReply(reply));
  const outcome: Outcome = waiting ? null : reply?.tone === "status" && reply.text === t("commands.done") ? { tone: "status", text: t("commands.restartQueued") } : reply;
  return (
    <span data-command="restart" className="mt-2 inline-flex flex-wrap items-center gap-2">
      <Button variant="secondary" data-action="restart" disabled={!on || !command.allowed || waiting} title={t("commands.restartTitle")} onClick={send}>
        {waiting ? t("commands.restarting") : t("commands.restart")}
      </Button>
      <OutcomeText outcome={outcome} />
    </span>
  );
}
