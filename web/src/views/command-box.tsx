import { useState } from "react";
import type { ProposalView } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Field } from "../components/ui/field.js";
import { Textarea } from "../components/ui/textarea.js";
import { cn } from "../lib/cn.js";

// The item page's command box and pending proposals (design 09-dashboard-app). The box sends the owner's words as one
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
      className={cn("text-xs text-pretty break-words", outcome.tone === "error" ? "text-pill-bad-fg" : "text-text-2")}
    >
      {outcome.text}
    </span>
  );
}

/** The command box: a sentence in the owner's own words, sent as one app request. */
export function CommandBox({ enabled, busy, outcome, send }: { enabled: boolean; busy: boolean; outcome: Outcome; send: Send }) {
  const [words, setWords] = useState("");
  const submit = async () => {
    if (await send(SENTENCE, words)) setWords("");
  };
  return (
    <form
      data-command-box
      className="mt-6 flex max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Say it in your own words"
        htmlFor="command-box"
        help="The factory answers in the thread below with the commands it read. Nothing changes until you confirm them."
      >
        <Textarea
          id="command-box"
          rows={2}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          placeholder="e.g. looks good, approve it but keep it small"
          className="w-full"
        />
      </Field>
      <ButtonRow>
        <Button type="submit" variant="secondary" disabled={!enabled || busy || words.trim() === ""}>
          Read it
        </Button>
        <OutcomeText outcome={outcome} />
      </ButtonRow>
    </form>
  );
}

/** Each pending proposal of the item: its commands as typed lines, then Confirm all and Cancel. */
export function PendingProposals({
  proposals, enabled, busy, outcomes, send,
}: { proposals: readonly ProposalView[]; enabled: boolean; busy: boolean; outcomes: (id: string) => Outcome; send: Send }) {
  if (proposals.length === 0) return null;
  return (
    <ul aria-label="Proposed commands" className="mt-3 space-y-2">
      {proposals.map((p) => (
        <li key={p.id} data-proposal={p.id} className="max-w-xl min-w-0 rounded-control border border-border-strong p-2">
          <p className="text-xs text-text-2">Proposed, not applied yet:</p>
          <ul className="my-1 space-y-0.5">
            {p.commands.map((c) => (
              <li key={c.index} className="min-w-0 text-sm break-words">
                <code className="break-all">{c.line}</code> <span className="text-xs text-text-2">on {c.work_item_id}</span>
              </li>
            ))}
          </ul>
          <ButtonRow className="mt-3">
            <Button variant="secondary" disabled={!enabled || busy} onClick={() => void send(CANCEL, "", p.id)}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={!enabled || busy} onClick={() => void send(CONFIRM_ALL, "", p.id)}>
              Confirm all
            </Button>
            <OutcomeText outcome={outcomes(p.id)} />
          </ButtonRow>
        </li>
      ))}
    </ul>
  );
}
