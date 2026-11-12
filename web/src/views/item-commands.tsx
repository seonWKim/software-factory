import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { API, type CommandReply, type ItemCommand, type ItemDetail, type MergeReadiness, type Session, plainRefusal, postCommand, showsMerge, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Section } from "../components/ui/parts.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { Link } from "../nav.js";
import { PAGE_COMMANDS_PATH } from "../pages.js";
import { CommandBox, type Outcome, OutcomeText, PendingProposals, SENTENCE } from "./command-box.js";
import {
  ApproveConfirm, type DecisionChoice, DecisionsPanel, InShort, RejectDialog, ReviseDialog, approveNote, approvePhase, chosenAnswers, initialChoices, type CommandDialogProps,
} from "./item-decisions.js";

// The item page's command buttons (design §9, issue #228): one button per entry of the item API's `commands`,
// in its order: the commands that apply now. One the viewer's grants do not allow (`allowed` false, issue #453) is
// disabled with the controller's reason beside it, in plain text; every refusal shows without backticks. Reject and revise open a dialog (issue #527): reject asks why and confirms what closes,
// revise takes a comment per spec section. Verdict (issue #523) is three buttons, Accept, Changes and Reject, with a
// severity choice; a click sends `<kind> <severity> <reason>` (verdictNote), the reason the note box's text. Every
// other command carries the note box's text when it has any (tokens for budget, the approve note). A send
// is POST /api/v1/items/:id/commands with the token from GET /api/v1/session; the controller applies it on its
// next tick, and the item's `replies` say how that went. An item waiting for its merge also gets the Merge button
// (MergeButton, also in Needs you), enabled or disabled with its reason as the item API's `merge` says.
// A waiting spec (issue #526) shows its In short above Commands and its decisions as questions above the note box;
// approve in an approve phase (the spec gate, the floor block, the Rule of Two) goes through a confirm step first;
// approve sends the answers as `N: <answer>` lines. Below the buttons, the item's pending proposals and the command
// box (command-box.tsx), sent through the same app request route.

/** Commands sent from their own dialog, not with the note box. */
const FORMS = ["reject", "revise"];
/** In Needs you, which has no note box, verdict has its own dialog too (issue #513). */
const NEED_FORMS = [...FORMS, "verdict"];
/** The commands a Needs-you row shows as its one primary button: what the state asks for. */
const PRIMARY = ["approve", "retry", "resolve"];

/** The verdict as typed after `/verdict`, the placeholder of its text form. */
export const VERDICT_PLACEHOLDER = "accept|changes|reject <none|minor|major|critical> <reason>";

/** The verdicts a person gives, as `/verdict` takes them, with their button labels. */
const VERDICTS = [["accept", "Accept"], ["changes", "Changes"], ["reject", "Reject"]] as const;
export type VerdictChoice = (typeof VERDICTS)[number][0];
const SEVERITIES = ["none", "minor", "major", "critical"] as const;
export type VerdictSeverityChoice = (typeof SEVERITIES)[number];

/** The note a verdict button sends: `<kind> <severity> <reason>`, the reason left out when empty. */
export function verdictNote(kind: VerdictChoice, severity: VerdictSeverityChoice, reason: string): string {
  return [kind, severity, reason.trim()].filter((s) => s !== "").join(" ");
}

/** What this page did with a command since it loaded: the request it sent, or the error its send got. */
export type LocalSend = { seq: number } | { error: string };


/** The text beside a button the viewer's grants do not allow: the controller's reason, in plain words. */
export function notAllowed(c: ItemCommand): Outcome {
  return { tone: "status", text: plainRefusal(c.reason ?? "not allowed") };
}

/**
 * The outcome of the item's latest request for `command`: its refusal, "sent" while not handled, else "Done".
 * A send from this page wins until a reply as new as it arrives; a failed send shows its error.
 */
export function commandOutcome(replies: readonly CommandReply[], command: string, local?: LocalSend): Outcome {
  if (local && "error" in local) return { tone: "error", text: local.error };
  const latest = replies.filter((r) => r.command === command).reduce<CommandReply | null>((a, r) => (a && a.seq > r.seq ? a : r), null);
  if (local && (!latest || latest.seq < local.seq)) return { tone: "status", text: "sent" };
  if (!latest) return null;
  if (latest.refusal) return { tone: "error", text: plainRefusal(latest.refusal) };
  return { tone: "status", text: latest.handled_at === null ? "sent" : "Done" };
}

/**
 * Sending app commands for item `id`: `send` posts one with the session's token, keeps what this page did with each
 * command (`local`), and on success re-reads the item and the list, so the controller's reply shows. `on`: commands
 * are on for this page's session.
 */
function useCommandSend(id: string) {
  const client = useQueryClient();
  const session = useApi<Session>(API.session, false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<Record<string, LocalSend>>({});
  const token = session.data?.csrf_token;
  const send = async (command: string, note: string, proposal?: string): Promise<boolean> => {
    if (!token) return false;
    setBusy(true);
    // A proposal's Confirm all or Cancel is kept under the proposal's ID, every other send under its command.
    const key = proposal ?? command;
    try {
      const r = await postCommand(token, id, command, note, proposal);
      setLocal((m) => ({ ...m, [key]: r.ok ? { seq: r.seq } : { error: r.error } }));
      if (r.ok) await Promise.all([client.invalidateQueries({ queryKey: [API.item(id)] }), client.invalidateQueries({ queryKey: [API.items] })]);
      return r.ok;
    } catch (err) {
      setLocal((m) => ({ ...m, [key]: { error: err instanceof Error ? err.message : String(err) } }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { session, on: !!token && session.data?.commands_enabled === true, busy, local, send };
}

export function ItemCommands({ id, commands, replies }: { id: string; commands: readonly ItemCommand[]; replies: readonly CommandReply[] }) {
  const { session, on: enabled, busy, local, send: post } = useCommandSend(id);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<DecisionChoice[] | null>(null);
  // The page's own item query (same key and options), read here for its `merge` and its waiting spec.
  const data = useApi<ItemDetail>(API.item(id)).data;
  const detail = data?.item;
  const merge = detail?.merge;
  const showMerge = showsMerge(merge);
  const phase = approvePhase(detail?.blocked_reason);
  // Only a spec at the gate is answered; the floor block, the Rule of Two and a held run approve no decisions.
  const decisions = phase === "spec_pending" || phase === "max_revisions" ? (data?.spec?.decisions ?? []) : [];
  const choices = picked ?? initialChoices(decisions);
  const answers = chosenAnswers(decisions, choices);
  // The item's pending proposals and the command box, whatever the state: a sentence may name any open item.
  const sentenceParts = (
    <>
      <PendingProposals
        proposals={data?.proposals ?? []}
        enabled={enabled}
        busy={busy}
        outcomes={(proposal) => commandOutcome([], proposal, local[proposal])}
        send={post}
      />
      <CommandBox enabled={enabled} busy={busy} outcome={commandOutcome(replies, SENTENCE, local[SENTENCE])} send={post} />
    </>
  );
  // Nothing the page can send now (a running item): say so once, with no note box or buttons that could only be refused.
  if (commands.length === 0 && !showMerge) {
    return (
      <>
        <InShort spec={data?.spec} />
        <Section title="Commands">
          <p data-commands-none className="text-sm text-pretty text-text-2">
            No command applies now; the factory continues on its own. Commands show here when the item waits for you.
          </p>
          {sentenceParts}
        </Section>
      </>
    );
  }
  const off = session.isError || session.data?.commands_enabled === false;
  const usesNote = commands.some((c) => c.allowed && !FORMS.includes(c.name));

  /** Sends `command` with `text` (a form's) or, without it, the note box's. */
  const send = async (command: string, text?: string) => {
    setConfirming(null);
    if (!(await post(command, text ?? (command === "approve" ? approveNote(answers, note) : note)))) return;
    if (text === undefined) setNote("");
    else setOpen(null);
    setPicked(null);
  };

  return (
    <>
      <InShort spec={data?.spec} />
      <Section title="Commands">
        {off && (
          <p role="status" data-commands-off className="mb-2 text-sm text-pretty text-text-2">
            Commands are off: this server is not on loopback, so it needs ui.user_id.{" "}
            <Link href={PAGE_COMMANDS_PATH} className={LINK_CLASS}>
              Settings
            </Link>{" "}
            says what to set.
          </p>
        )}
        {enabled && session.data?.actor && (
          <p data-commands-actor className="mb-2 text-xs text-pretty text-text-2">
            Acting as {session.data.actor} (from {session.data.actor_source === "config" ? "config" : "environment"})
          </p>
        )}
        <DecisionsPanel decisions={decisions} choices={choices} onChange={(i, c) => setPicked(choices.map((x, j) => (j === i ? c : x)))} />
        {usesNote && (
          <Textarea
            aria-label="Note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tokens for budget, a verdict's reason, or a note"
            className="mb-3 block w-full max-w-xl"
          />
        )}
        <ul className="space-y-2">
          {commands.map((c) => {
            const disabled = !enabled || busy || !c.allowed;
            const outcome = c.allowed ? commandOutcome(replies, c.name, local[c.name]) : notAllowed(c);
            const hasForm = FORMS.includes(c.name);
            const confirms = c.name === "approve" && phase !== null;
            if (c.name === "verdict") {
              return (
                <li key={c.name} data-command={c.name}>
                  <VerdictButtons
                    title={`${c.usage}: ${c.description}`}
                    disabled={disabled}
                    reason={note}
                    outcome={outcome}
                    onSend={(text) => void post("verdict", text).then((ok) => ok && setNote(""))}
                  />
                </li>
              );
            }
            return (
              <li key={c.name} data-command={c.name} className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={disabled || confirming === c.name}
                  title={`${c.usage}: ${c.description}`}
                  {...(hasForm ? { "aria-haspopup": "dialog" as const } : {})}
                  onClick={(e) => {
                    opener.current = e.currentTarget;
                    if (hasForm) setOpen(c.name);
                    else if (confirms) setConfirming(c.name);
                    else void send(c.name);
                  }}
                >
                  {c.name}
                </Button>
                {confirming === c.name && phase !== null && (
                  <>
                    <ApproveConfirm phase={phase} answers={answers} note={note} />
                    <ButtonRow>
                      <Button variant="secondary" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                      <Button variant="primary" disabled={disabled} onClick={() => void send(c.name)}>
                        Confirm {c.name}
                      </Button>
                    </ButtonRow>
                  </>
                )}
                <OutcomeText outcome={outcome} />
              </li>
            );
          })}
          {/* Merge is its own block, 24px (space-6) below the verdict row, so it never reads as one of the verdicts. */}
          {showMerge && (
            <li data-command="merge" className="flex flex-wrap items-center gap-2 not-first:mt-6">
              <MergeButton id={id} source={detail?.source.type} merge={merge} replies={replies} />
            </li>
          )}
        </ul>
        {(open === "reject" || open === "revise") && (
          <CommandDialog
            command={open}
            id={id}
            pr={detail?.change_ref ?? null}
            busy={busy || !enabled}
            error={local[open] && "error" in local[open] ? local[open].error : null}
            returnFocusTo={opener}
            onSend={(t) => void send(open, t)}
            onClose={() => setOpen(null)}
          />
        )}
        {sentenceParts}
      </Section>
    </>
  );
}

/** The dialog for `command` (reject, revise or verdict), the same on the Floor and the item page. */
function CommandDialog({ command, pr, ...props }: CommandDialogProps & { command: "reject" | "revise" | "verdict"; pr: string | null }) {
  if (command === "reject") return <RejectDialog pr={pr} {...props} />;
  if (command === "revise") return <ReviseDialog {...props} />;
  return <VerdictDialog {...props} />;
}

/** The verdict buttons' variants: Accept secondary, Changes secondary, Reject danger text. */
const VERDICT_VARIANT = { accept: "secondary", changes: "secondary", reject: "danger" } as const;

/**
 * The verdict buttons (issue #523): a severity choice, then one ButtonRow of Accept, Changes and Reject, each sending
 * verdictNote with `reason` (the note box's text), and the outcome. Changes and reject need a reason, so they wait for
 * one. A handled verdict shows Done as a ghost button, which hides it; a newer verdict's outcome shows again.
 */
function VerdictButtons({
  title, disabled, reason, outcome, onSend,
}: { title: string; disabled: boolean; reason: string; outcome: Outcome; onSend: (note: string) => void }) {
  const [severity, setSeverity] = useState<VerdictSeverityChoice>("none");
  const [doneHidden, setDoneHidden] = useState(false);
  const done = outcome?.tone === "status" && outcome.text === "Done";
  // A new send (its outcome "sent") shows the next Done again.
  if (!done && doneHidden) setDoneHidden(false);
  return (
    <div data-verdict className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Verdict severity"
        value={severity}
        disabled={disabled}
        onChange={(e) => setSeverity(e.target.value as VerdictSeverityChoice)}
      >
        {SEVERITIES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <ButtonRow>
        {VERDICTS.map(([kind, label]) => (
          <Button
            key={kind}
            variant={VERDICT_VARIANT[kind]}
            data-verdict-kind={kind}
            disabled={disabled || (kind !== "accept" && reason.trim() === "")}
            title={kind === "accept" ? title : `${title} (write the reason in the note box first)`}
            onClick={() => onSend(verdictNote(kind, severity, reason))}
          >
            {label}
          </Button>
        ))}
        {done ? (
          !doneHidden && (
            <Button variant="ghost" data-outcome title="The verdict was handled; hide this" onClick={() => setDoneHidden(true)}>
              Done
            </Button>
          )
        ) : (
          <OutcomeText outcome={outcome} />
        )}
      </ButtonRow>
    </div>
  );
}

/**
 * The Merge button (design §9), on the item page and in Needs you: sends `merge` with no note (a local item's local
 * merge, as `factory merge`; any other item's PR merged on the forge at the head the review passed), then re-reads
 * the item and the list, so the controller's reply shows. Disabled with the item API's reason beside it; else the
 * latest merge reply (a refusal: the head moved, a conflict, a failing check, no approve_merge).
 */
export function MergeButton({ id, source, merge, replies = [] }: { id: string; source: string | undefined; merge: MergeReadiness; replies?: readonly CommandReply[] }) {
  const { on, busy, local, send: post } = useCommandSend(id);
  const send = () => post("merge", "");
  const outcome: Outcome = merge.enabled ? commandOutcome(replies, "merge", local.merge) : { tone: "status", text: merge.reason ?? "" };
  return (
    <span data-merge={merge.enabled ? "enabled" : "disabled"} className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        disabled={!merge.enabled || !on || busy}
        title={source === "local"
          ? "Merge the item's local branch into the local base branch (factory merge), after the install and checks pass"
          : "Merge the PR on the forge with a merge commit, at the head the review passed"}
        onClick={() => void send()}
      >
        Merge
      </Button>
      <OutcomeText outcome={outcome} />
    </span>
  );
}

/**
 * A Needs-you row's verdict dialog (issue #513): one line, as typed after `/verdict`, sent as the item page's note box
 * sends it; Enter sends it. The controller parses it; a malformed one is refused with the usage line.
 */
function VerdictDialog({ id, busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps) {
  const [text, setText] = useState("");
  return (
    <Dialog
      title={`Record a verdict on ${id}`}
      consequence="The verdict is recorded on this item; the factory applies it on its next tick."
      confirmLabel="Send verdict"
      confirmDisabled={busy || text.trim() === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(text.trim())}
      onClose={onClose}
    >
      <Input aria-label="Verdict" value={text} onChange={(e) => setText(e.target.value)} placeholder={VERDICT_PLACEHOLDER} className="w-full" />
    </Dialog>
  );
}

/**
 * A Needs-you row's commands (design §9, issues #453, #513): at most one primary button, the command the state asks
 * for (approve, retry or resolve, the first the viewer may send), and one "⋯" menu with every other command of the
 * row's `commands`. One the viewer may not send stays in the menu, disabled, with its reason. Reject, revise and
 * verdict open a dialog (outside the row, so the row never grows); the others send at once. A send re-reads the list,
 * so the row moves on; a failed send shows its error in the row, a sent one in a short status message that
 * outlives the row (announceStatus).
 */
export function NeedCommands({ id, commands, pr }: { id: string; commands: readonly ItemCommand[]; pr: string | null }) {
  const { on, busy, local, send: post } = useCommandSend(id);
  const [open, setOpen] = useState<"reject" | "revise" | "verdict" | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const primary = commands.find((c) => PRIMARY.includes(c.name) && c.allowed);
  const others = commands.filter((c) => c !== primary);
  const send = async (command: string, note: string) => {
    if (!(await post(command, note))) return;
    // The row may have left the list by now (the send re-read it); the status line outlives it.
    announceStatus(`Command sent: ${command}`);
    setOpen(null);
  };
  const failed = commands.flatMap((c) => {
    const l = local[c.name];
    return l && "error" in l ? [l.error] : [];
  });
  return (
    <span data-need-commands className="inline-flex flex-wrap items-center gap-2">
      {primary && (
        <span data-command={primary.name} className="inline-flex">
          <Button variant="secondary" disabled={!on || busy} title={`${primary.usage}: ${primary.description}`} onClick={() => void send(primary.name, "")}>
            {primary.name}
          </Button>
        </span>
      )}
      {others.length > 0 && (
        <MoreMenu
          buttonRef={moreButton}
          commands={others}
          disabled={!on || busy}
          onPick={(name) => (NEED_FORMS.includes(name) ? setOpen(name as "reject" | "revise" | "verdict") : void send(name, ""))}
        />
      )}
      {failed.map((text) => (
        <OutcomeText key={text} outcome={{ tone: "error", text }} />
      ))}
      {open !== null && (
        <CommandDialog
          command={open}
          id={id}
          pr={pr}
          busy={!on || busy}
          error={local[open] && "error" in local[open] ? local[open].error : null}
          returnFocusTo={moreButton}
          onSend={(t) => void send(open, t)}
          onClose={() => setOpen(null)}
        />
      )}
    </span>
  );
}

/** The "⋯" menu: the row's other commands, each disabled with its reason when the viewer may not send it. */
function MoreMenu({
  buttonRef, commands, disabled, onPick,
}: { buttonRef: RefObject<HTMLButtonElement | null>; commands: readonly ItemCommand[]; disabled: boolean; onPick: (name: string) => void }) {
  const [shown, setShown] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const uid = useId();
  useEffect(() => {
    if (!shown) return;
    const away = (e: Event) => {
      if (e.type === "keydown" ? (e as KeyboardEvent).key === "Escape" : !wrap.current?.contains(e.target as Node)) setShown(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", away);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", away);
    };
  }, [shown]);
  return (
    <span ref={wrap} className="relative inline-flex">
      <Button
        ref={buttonRef}
        variant="secondary"
        aria-label="More commands"
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        ⋯
      </Button>
      {shown && (
        <ul
          role="menu"
          className="absolute top-full right-0 z-20 mt-1 w-max max-w-[calc(100vw-2rem)] rounded-control border border-border-strong bg-surface p-1 text-sm"
        >
          {commands.map((c) => {
            const off = disabled || !c.allowed;
            const why = !c.allowed ? plainRefusal(c.reason ?? "not allowed") : null;
            return (
              <li key={c.name} role="none" data-command={c.name}>
                <Button
                  variant="ghost"
                  role="menuitem"
                  disabled={off}
                  title={why ?? `${c.usage}: ${c.description}`}
                  aria-describedby={why ? `${uid}-why-${c.name}` : undefined}
                  className="w-full text-left"
                  onClick={() => {
                    setShown(false);
                    onPick(c.name);
                  }}
                >
                  {c.name}
                </Button>
                {why && (
                  <span id={`${uid}-why-${c.name}`} className="block max-w-xs px-2 pb-1 text-xs text-pretty break-words text-text-2">
                    {why}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </span>
  );
}
