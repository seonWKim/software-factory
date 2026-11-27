import { type MouseEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { API, type CommandReply, type ItemCommand, type ItemDetail, type ThreadEntry, mergeReturned, showsMerge, useApi } from "../api.js";
import { Clamp } from "../components/ui/clamp.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { CARD_PAD, CARD_TITLE, SUB_TITLE } from "../components/ui/card.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { PAGE_COMMANDS_PATH } from "../pages.js";
import { OutcomeText, PendingProposals, SENTENCE } from "./command-box.js";
import { PersonName } from "./common.js";
import {
  AllowResolveDialog, CommandDialog, DIALOGS, type FormName, ItemCommands, MENU, allowsResolve, menuEntry, type OneTapChoice, QueuedFeedbackList,
  oneTapNote, pathsOf, pendingFeedback, primaryLabel, primaryOf, withPaths,
} from "./item-commands.js";
import { commandOutcome, notAllowed, useCommandSend } from "./command-send.js";
import { MergeButton } from "./merge-button.js";
import { ApproveDialog, type DecisionChoice, DecisionsPanel, InShort, approvePhase, chosenAnswers, commandLabel, initialChoices } from "./item-decisions.js";
import { AddContextActions, ContextDialog } from "./item-attachments.js";
import { ModelCredentialDialog } from "./model-credential-dialog.js";
import { summaryOf, threadOrder } from "./thread.js";

// The item page's DecisionCard (design 09-dashboard-item-commands): shown first on the page, and only while the item
// waits for the owner (why.next_actor is human). It reads top to bottom as the question (the why sentence), the
// evidence it is based on (the newest factory message with "Show in thread", In short, a permission ask's paths, the
// feedback queued for the implementer), then the actions that decision takes: the spec's decisions and one note box
// (Ctrl/⌘+Enter reads it as a sentence, whose proposed commands show with Confirm all and Cancel), then one row of
// buttons built from the item API's `commands`. The primary comes first (Merge, else the command that allows a
// permission ask's paths, else Approve, Answer or Retry: primaryOf), then the verdict's Good and Bad (one tap each,
// oneTapNote) and Feedback (the note box's text), the other commands (Revise, …) in the API's order, and the "…" menu
// with Reject and Verdict (their dialogs). Revise opens the five-section form only for an item with a spec; without one
// it opens the Add context modal, and on a New item Add context and Attach take its place. Every button and menu item carries `data-action`, its CLI command's name,
// and `data-item`, the item's ID (Good, Bad and Feedback are `verdict` with `data-choice`), and sends that command
// through the item commands route; one the API marks not allowed is disabled with the controller's
// reason under the row (in the menu, in its label). The command help (every command, how to type it) is behind ? and
// ⌘K, never in the card.

/** The sub-group heading type (SUB_TITLE) in the warn fill's own fg, which passes 4.5:1 there where text-2 does not. */
const PANEL_SUB_TITLE = SUB_TITLE.replace(/text-text-\d/, "text-pill-warn-fg");

/** The newest factory message's anchor, shown in the thread (which opens to it). */
function showInThread(e: MouseEvent<HTMLAnchorElement>, anchor: string) {
  const el = document.getElementById(anchor);
  if (!el) return;
  e.preventDefault();
  history.replaceState(history.state, "", `#${anchor}`);
  // The thread listens for it and shows its earlier messages when the anchor is one of them (thread.tsx).
  dispatchEvent(new HashChangeEvent("hashchange"));
  setTimeout(() => el.scrollIntoView?.({ block: "start" }), 0);
}

/** The why reason code while the model_credential claim pause holds: the item waits for the owner to add a credential. */
const CREDENTIAL_PAUSE = "paused_model_credential";

/** A reply to a refused command (marker `factory:refused:`): it answers the command, so it is no evidence for a wait. */
const isRefusal = (m: ThreadEntry) => m.kind === "refused" || m.body.includes(" was not applied");

/** The newest factory message that is not a command refusal: the thread's evidence for the wait. */
function latestEvidence(thread: readonly ThreadEntry[] | undefined): ThreadEntry | undefined {
  return threadOrder(thread ?? []).find((m) => m.role === "factory" && !isRefusal(m));
}

/** The newest factory message of the thread, as evidence: its one-line summary and its anchor. */
function ThreadContext({ latest }: { latest: ThreadEntry }) {
  return (
    <div data-decide-context className="text-sm text-pretty text-text-1">
      <Clamp className="break-words">{summaryOf(latest.body)}</Clamp>
      <a href={`#${latest.anchor}`} onClick={(e) => showInThread(e, latest.anchor)} className={LINK_CLASS}>
        {t("decide.showInThread")}
      </a>
    </div>
  );
}

/** The paths a permission ask names, which its button allows. */
function AskedPaths({ paths }: { paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <div data-asked-paths className="text-sm text-text-1">
      <p>{t("decide.askedPaths")}</p>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {paths.map((p) => <li key={p}><code className="font-mono text-xs break-all">{p}</code></li>)}
      </ul>
    </div>
  );
}

export interface DecisionCardProps {
  id: string;
  commands: readonly ItemCommand[];
  replies: readonly CommandReply[];
  /** The question: the item's why sentence. */
  question?: ReactNode;
}

/** The item's decision while the owner is next: the question, its evidence, then one button per action it takes. */
export function DecisionCard({ id, commands, replies, question = null }: DecisionCardProps) {
  const { session, on: enabled, busy, local, send: post } = useCommandSend(id);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<FormName | "approve" | "resolve" | null>(null);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<DecisionChoice[] | null>(null);
  // The page's own item query (same key and options), read here for its `merge`, its thread and its waiting spec.
  const data = useApi<ItemDetail>(API.item(id)).data;
  const detail = data?.item;
  const merge = detail?.merge;
  const showMerge = showsMerge(merge);
  const phase = approvePhase(detail?.blocked_reason);
  // Only a spec at the gate is answered; the floor block, the Rule of Two and a held run approve no decisions.
  const decisions = phase === "spec_pending" || phase === "max_revisions" ? (data?.spec?.decisions ?? []) : [];
  const choices = picked ?? initialChoices(decisions);
  const answers = chosenAnswers(decisions, choices);
  const off = session.isError || session.data?.commands_enabled === false;
  const itemTitle = detail?.title ?? id;
  // The credential pause has no spec or run to judge: its one primary action is adding the credential (Good, Bad, Feedback hide).
  const credentialPause = detail?.why?.reason_code === CREDENTIAL_PAUSE;
  const primary = showMerge || credentialPause ? undefined : primaryOf(commands);
  const asked = commands.map(pathsOf).find((p) => p.length > 0) ?? [];
  const latest = latestEvidence(data?.thread);
  const hasEvidence = !!latest || !!data?.spec?.in_short || asked.length > 0 || pendingFeedback(data?.timeline ?? []).length > 0;

  /** Sends `command` with `text`; once sent, empties the note box (`fromBox`: the text is the box's) or closes the dialog. */
  const send = async (command: string, text: string, fromBox: boolean) => {
    if (!(await post(command, text))) return;
    if (fromBox) setNote("");
    else setOpen(null);
    setPicked(null);
  };
  const verdict = commands.find((c) => c.name === "verdict");
  const resolve = commands.find(allowsResolve);
  const verdictOff = !enabled || busy || !verdict?.allowed;
  const tap = (choice: OneTapChoice) => {
    const text = oneTapNote(choice, note);
    if (text !== null && !verdictOff) void post("verdict", text).then((ok) => ok && setNote(""));
  };
  const feedback = oneTapNote("feedback", note);
  // A New item has no spec to comment on: Add context and Attach (AddContextActions) take Revise's place.
  const revise = commands.find((c) => c.name === "revise");
  const addContext = detail?.stage === "NEW" ? revise : undefined;
  const rest = commands.filter((c) => c !== primary && c !== addContext && !MENU.includes(c.name));
  // Verdict and Reject: in the "…" menu, one the viewer may not send disabled with its reason.
  const menuItems = commands.filter((c) => MENU.includes(c.name)).map((c) => menuEntry(id, c, !enabled || busy, () => setOpen(c.name as FormName)));
  const actions = useRef<HTMLDivElement>(null);
  // The OverflowMenu owns its button, so a menu dialog hands focus back to it by looking it up when it closes.
  const moreButton = { get current() { return actions.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const outcomes = [
    ...commands.map((c) => ({ name: c.name, outcome: c.allowed ? commandOutcome(replies, c.name, local[c.name]) : notAllowed(c) })),
    { name: SENTENCE, outcome: commandOutcome(replies, SENTENCE, local[SENTENCE]) },
  ].filter((o) => o.outcome !== null);

  const button = (c: ItemCommand) => {
    // Allow and resolve (an out_of_scope resolve failure's reply files) lists the files in AllowResolveDialog first.
    const opensDialog = DIALOGS.includes(c.name) || (c.name === "approve" && phase !== null) || allowsResolve(c);
    // Applied at once (its label shows): not sent again before the item's new state arrives.
    const sent = local[c.name];
    const outcome = c.allowed ? commandOutcome(replies, c.name, sent) : notAllowed(c);
    const disabled = !enabled || busy || !c.allowed || (!!sent && "label" in sent && !!sent.label && outcome?.text === sent.label);
    return (
      <span key={c.name} className="inline-flex">
        <Button
          variant={c === primary ? "primary" : "secondary"}
          data-action={c.name}
          data-item={id}
          disabled={disabled}
          title={c.description}
          {...(opensDialog ? { "aria-haspopup": "dialog" as const } : {})}
          onClick={(e) => {
            opener.current = e.currentTarget;
            if (!opensDialog) void send(c.name, withPaths(c, note), true);
            else setOpen(c.name as FormName | "approve" | "resolve");
          }}
        >
          {pathsOf(c).length > 0 ? primaryLabel(c) : commandLabel(c.name)}
        </Button>
      </span>
    );
  };

  return (
    <section aria-label={t("decide.title")} data-decide data-decision-card className={cn("space-y-3 rounded-card border border-pill-warn-fg bg-pill-warn-bg text-text-1", CARD_PAD)}>
      <div data-decision-question>
        <h2 className={cn("mb-1", CARD_TITLE)}>{t("decide.title")}</h2>
        {question}
      </div>
      {hasEvidence && (
        <div data-decision-evidence className="space-y-2">
          <h3 className={PANEL_SUB_TITLE}>{t("decide.evidence")}</h3>
          {latest && <ThreadContext latest={latest} />}
          <InShort spec={data?.spec} />
          <AskedPaths paths={asked} />
          <QueuedFeedbackList timeline={data?.timeline} />
        </div>
      )}
      <section aria-label={t("commands.label")}>
        {off && (
          <p role="status" data-commands-off className="mb-2 text-sm text-pretty text-pill-warn-fg">
            {t("commands.offBefore")}
            <Link href={PAGE_COMMANDS_PATH} className={LINK_CLASS}>
              {t("commands.offSettings")}
            </Link>
            {t("commands.offAfter")}
          </p>
        )}
        {enabled && session.data?.actor && (
          <p data-commands-actor className="mb-2 text-xs text-pretty text-pill-warn-fg">
            {t("commands.actingAs")}<PersonName id={session.data.actor} viewer={session.data.actor} />{t("commands.actorFrom", { source: session.data.actor_source === "config" ? t("commands.sourceConfig") : t("commands.sourceEnv") })}
          </p>
        )}
        <DecisionsPanel decisions={decisions} choices={choices} onChange={(i, c) => setPicked(choices.map((x, j) => (j === i ? c : x)))} />
        <Textarea
          aria-label={t("commands.note")}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘+Enter: the note is read as a sentence; the factory proposes the commands it names (below).
            if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
            e.preventDefault();
            if (enabled && !busy && note.trim() !== "") void send(SENTENCE, note, true);
          }}
          placeholder={t("commands.notePlaceholder")}
          className="mb-3 block w-full max-w-xl"
        />
        <div ref={actions} data-decision-actions className="flex flex-wrap items-center gap-2">
          {credentialPause && (
            <Button variant="primary" data-action="add_model_credential" aria-haspopup="dialog" onClick={() => setCredentialOpen(true)}>
              {t("needs.addCredential")}
            </Button>
          )}
          {showMerge ? <span className="inline-flex"><MergeButton id={id} source={detail?.source.type} merge={merge} replies={replies} returned={mergeReturned(data)} /></span> : primary && button(primary)}
          {verdict && !credentialPause && (
            <span data-verdict className="inline-flex">
              {/* Good and Bad send a verdict at once: actions, not a choice, so two Buttons in one named group. */}
              <ButtonRow role="group" aria-label={t("commands.verdict")}>
                {([["good", t("commands.good")], ["bad", t("commands.bad")]] as const).map(([choice, label]) => (
                  <Button key={choice} data-action="verdict" data-item={id} data-choice={choice} onClick={() => tap(choice)}>
                    {label}
                  </Button>
                ))}
              </ButtonRow>
            </span>
          )}
          {verdict && !credentialPause && (
            <Button
              variant="secondary"
              data-action="verdict"
              data-item={id}
              data-choice="feedback"
              disabled={verdictOff || feedback === null}
              title={`${verdict.description}${t("commands.needFeedback")}`}
              onClick={() => feedback !== null && tap("feedback")}
            >
              {t("commands.feedback")}
            </Button>
          )}
          {rest.map(button)}
          {addContext && (
            <AddContextActions id={id} title={itemTitle} token={session.data?.csrf_token} off={!enabled || busy || !addContext.allowed}
              error={local.revise && "error" in local.revise ? local.revise.error : null} send={(text) => post("revise", text)} />
          )}
          {menuItems.length > 0 && <OverflowMenu label={t("commands.more")} items={menuItems} />}
        </div>
        <div className="mt-2 flex flex-col items-start gap-1">
          {outcomes.map((o) => <div key={o.name} data-outcome-of={o.name}><OutcomeText outcome={o.outcome} /></div>)}
        </div>
        <PendingProposals proposals={data?.proposals ?? []} enabled={enabled} busy={busy} outcomes={(proposal) => commandOutcome([], proposal, local[proposal])} send={post} />
        {credentialOpen && <ModelCredentialDialog onClose={() => setCredentialOpen(false)} />}
        {open === "approve" && phase !== null && (
          <ApproveDialog
            title={`${commandLabel("approve")} ${itemTitle}`}
            phase={phase}
            answers={answers}
            note={note}
            busy={busy || !enabled}
            error={local.approve && "error" in local.approve ? local.approve.error : null}
            returnFocusTo={opener}
            onSend={(text) => void send("approve", text, false)}
            onClose={() => setOpen(null)}
          />
        )}
        {open === "revise" && !data?.spec && (
          <ContextDialog
            title={`${t("attach.addContext")} ${itemTitle}`}
            busy={busy || !enabled}
            error={local.revise && "error" in local.revise ? local.revise.error : null}
            returnFocusTo={opener}
            onSend={(text) => void send("revise", text, false)}
            onClose={() => setOpen(null)}
          />
        )}
        {open === "resolve" && resolve && (
          <AllowResolveDialog
            title={`${t("needs.actAllowResolve")} ${itemTitle}`}
            paths={pathsOf(resolve)}
            note={note}
            busy={busy || !enabled}
            error={local.resolve && "error" in local.resolve ? local.resolve.error : null}
            returnFocusTo={opener}
            onSend={(text) => void send("resolve", withPaths(resolve, text), false)}
            onClose={() => setOpen(null)}
          />
        )}
        {open !== null && open !== "approve" && open !== "resolve" && !(open === "revise" && !data?.spec) && (
          <CommandDialog
            command={open}
            title={itemTitle}
            pr={detail?.change_ref ?? null}
            busy={busy || !enabled}
            error={local[open] && "error" in local[open] ? local[open].error : null}
            returnFocusTo={MENU.includes(open) ? moreButton : opener}
            onSend={(text) => void send(open, text, false)}
            onClose={() => setOpen(null)}
          />
        )}
      </section>
    </section>
  );
}

/**
 * The item's decision on the item page and in a task's state dialog: the DecisionCard while the owner is next
 * (why.next_actor human), else its reason and its "…" menu (ItemCommands).
 */
export function ItemDecision({ id, commands, replies, reason = null }: { id: string; commands: readonly ItemCommand[]; replies: readonly CommandReply[]; reason?: ReactNode }) {
  const waiting = useApi<ItemDetail>(API.item(id)).data?.item.why?.next_actor === "human";
  return waiting ? <DecisionCard id={id} commands={commands} replies={replies} question={reason} /> : <ItemCommands id={id} commands={commands} reason={reason} />;
}
