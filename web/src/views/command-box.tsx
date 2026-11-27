import type { ProposalView } from "../api.js";
import { Button } from "../components/ui/button.js";
import { t } from "../i18n/index.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { cn } from "../lib/cn.js";

// The item page's pending proposals (design 09-dashboard-app). The note box sends the owner's words as one
// app request (`sentence`); the controller reads them with the plain-words reader and answers in the item's thread,
// where a proposed command is stored as pending. Each pending proposal of the item shows its commands as typed lines,
// with Confirm all and Cancel, each one app request carrying only the proposal ID. This page makes no model call
// and changes no state itself: the controller checks every command as the typed command is checked.

/** The app commands these controls send (src/core/command-table.ts, src/core/interpret.ts CONFIRM_COMMAND). */
export const SENTENCE = "sentence";
export const CONFIRM_ALL = "proposal_confirm";
export const CANCEL = "proposal_cancel";

/** Sends one app request; resolves to whether the server took it. */
type Send = (command: string, note: string, proposal?: string) => Promise<boolean>;

/** The text next to a command's button, or null for none. */
export type Outcome = { tone: "error" | "status"; text: string } | null;

/** An outcome beside its control: an alert for an error, else a status. */
export function OutcomeText({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return (
    <span
      role={outcome.tone === "error" ? "alert" : "status"}
      data-outcome
      className={cn("text-xs text-pretty break-words", outcome.tone === "error" ? "text-pill-bad-fg" : "text-text-1")}
    >
      {outcome.text}
    </span>
  );
}

/** Each pending proposal of the item: its commands as typed lines, then Confirm all and Cancel. */
export function PendingProposals({
  proposals, enabled, busy, outcomes, send,
}: { proposals: readonly ProposalView[]; enabled: boolean; busy: boolean; outcomes: (id: string) => Outcome; send: Send }) {
  if (proposals.length === 0) return null;
  return (
    <ul aria-label={t("command.proposals")} className="mt-3 space-y-2">
      {proposals.map((p) => (
        <li key={p.id} data-proposal={p.id} className="max-w-xl min-w-0 rounded-control border border-border-strong p-2">
          <p className="text-xs text-text-1">{t("command.pending")}</p>
          <ul className="my-1 space-y-0.5">
            {p.commands.map((c) => (
              <li key={c.index} className="min-w-0 text-sm break-words">
                <code className="break-all">{c.line}</code> <span className="text-xs text-text-1">{t("command.on", { id: c.work_item_id })}</span>
              </li>
            ))}
          </ul>
          <ButtonRow data-proposal-actions className="mt-3">
            <Button variant="secondary" disabled={!enabled || busy} onClick={() => void send(CANCEL, "", p.id)}>
              {t("common.cancel")}
            </Button>
            <Button variant="secondary" disabled={!enabled || busy} onClick={() => void send(CONFIRM_ALL, "", p.id)}>
              {t("command.confirmAll")}
            </Button>
            <OutcomeText outcome={outcomes(p.id)} />
          </ButtonRow>
        </li>
      ))}
    </ul>
  );
}
