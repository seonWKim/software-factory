import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { API, type CommandReply, type ThreadEntry, type ItemCommand, type ItemDetail, type MergeReadiness, POLL_MS, type Session, getJson, plainRefusal, postCommand, showsMerge, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { CopyText } from "../components/ui/copy.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Field } from "../components/ui/field.js";
import { Radio } from "../components/ui/radio.js";
import { OverflowMenu, Tooltip } from "../components/ui/menu.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { shortSource } from "../lib/format.js";
import { Link } from "../nav.js";
import { PAGE_COMMANDS_PATH, itemPath } from "../pages.js";
import { type Outcome, OutcomeText, PendingProposals, SENTENCE } from "./command-box.js";
import { PersonName } from "./common.js";
import { summaryOf, threadOrder } from "./thread.js";
import {
  ApproveDialog, type DecisionChoice, DecisionsPanel, InShort, RejectDialog, ReviseDialog, approvePhase, chosenAnswers, commandLabel, initialChoices, type CommandDialogProps,
} from "./item-decisions.js";

// The item page's decision box (design §9, issues #228, #526; compact since 2026-11-15, design 09-dashboard-app):
// shown only while the item waits for the owner (why.next_actor is human), with the newest factory message as its
// context ("Show in thread"), In short, the decisions as questions, one note box and one row of buttons built from the
// item API's `commands`: the primary action first (Merge, else Approve, Retry or Answer), the Good/Bad control, Feedback,
// the other commands, then the "…" menu with Verdict and Reject. A command the viewer's grants do not allow (`allowed`
// false, issue #453) is disabled with the controller's reason in plain text. Reject, revise, verdict and approve (in an
// approve phase) open the one shared Dialog; verdict (issue #523) is an Accept, Changes or Reject choice with a severity
// and a reason sent as `<kind> <severity> <reason>` (verdictNote). Good is accept/none and Bad changes/minor, Feedback
// changes/none with the note box's text (oneTapNote), the same verdict request as Slack's buttons store. Every other
// command carries the note box's text (tokens for budget, the approve note); Ctrl/⌘+Enter sends it as a `sentence`
// request, whose proposed commands the item's pending proposals show with Confirm all and Cancel. A send is
// POST /api/v1/items/:id/commands with the token from GET /api/v1/session; the controller applies it on its next tick,
// and the item's `replies` say how that went. Feedback a `/revise` queued while implementing is listed until the run
// that applies it starts (pendingFeedback).

/** Commands sent from their own dialog, not with the note box. */
const FORMS = ["reject", "revise"];
/** Every command that opens a dialog from a button: those, and verdict (its Accept, Changes or Reject choice). */
const DIALOGS = [...FORMS, "verdict"];
/** The commands the "…" menu holds on the item page: they are rare, so they are no buttons in the decision row. */
const MENU = ["reject", "verdict"];
type FormName = "reject" | "revise" | "verdict";
/** The commands a Needs-you row shows as its one primary button: what the state asks for. */
const PRIMARY = ["approve", "retry", "resolve"];

/** The verdicts a person gives, as `/verdict` takes them, with their button labels. */
const VERDICTS = [["accept", "commands.accept"], ["changes", "commands.changes"], ["reject", "commands.reject"]] as const satisfies readonly (readonly [string, MessageKey])[];
export type VerdictChoice = (typeof VERDICTS)[number][0];
const SEVERITIES = ["none", "minor", "major", "critical"] as const;
/** The shown label of each severity; the severity itself is what the server receives. */
const SEVERITY_LABEL: Record<(typeof SEVERITIES)[number], MessageKey> = {
  none: "commands.severityNone",
  minor: "commands.severityMinor",
  major: "commands.severityMajor",
  critical: "commands.severityCritical",
};
export type VerdictSeverityChoice = (typeof SEVERITIES)[number];

/** The note a verdict button sends: `<kind> <severity> <reason>`, the reason left out when empty. */
export function verdictNote(kind: VerdictChoice, severity: VerdictSeverityChoice, reason: string): string {
  return [kind, severity, reason.trim()].filter((s) => s !== "").join(" ");
}

/** The one-tap verdicts (design §9), as Slack's result messages offer them, with their labels. */
export type OneTapChoice = "good" | "bad" | "feedback";
/** Good and Bad are the two segments of the one-tap control; Feedback is a button, as it waits for the note box's text. */

/**
 * The verdict note a one-tap button sends, with `reason` the note box's text: Good `accept none`, Bad `changes minor`
 * (`/verdict` needs a reason, so `Bad` when the box is empty), Feedback `changes none <text>`; null for Feedback with
 * no text, which waits for it.
 */
export function oneTapNote(choice: OneTapChoice, reason: string): string | null {
  if (choice === "good") return verdictNote("accept", "none", reason);
  if (choice === "bad") return verdictNote("changes", "minor", reason.trim() || "Bad");
  return reason.trim() === "" ? null : verdictNote("changes", "none", reason);
}

/** A `/revise` queued while implementing, as the item page lists it until it is applied. */
export type QueuedFeedback = { comment_id: string; feedback: string };

/** The comment IDs a `revise_applied` or `max_loops` row settles (its `comment_ids` detail, JSON). */
function settledIds(detail: Record<string, string | null> | null): string[] {
  try {
    const ids: unknown = JSON.parse(detail?.comment_ids ?? "[]");
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The item's queued `/revise` feedback not applied yet (design 09-dashboard-app), oldest first: each `revise_queued`
 * row of the timeline whose comment ID no `revise_applied` or `max_loops` row names. The server's rule is
 * pendingRevises in src/controller/units/commands/queued-revise.ts.
 */
export function pendingFeedback(timeline: ItemDetail["timeline"]): QueuedFeedback[] {
  const settled = new Set(timeline.filter((r) => r.reason === "revise_applied" || r.reason === "max_loops").flatMap((r) => settledIds(r.detail)));
  const out: QueuedFeedback[] = [];
  for (const r of timeline) {
    const id = r.detail?.comment_id, feedback = r.detail?.feedback;
    if (r.reason === "revise_queued" && id && feedback && !settled.has(id) && !out.some((p) => p.comment_id === id)) out.push({ comment_id: id, feedback });
  }
  return out;
}

/** The feedback queued for the implementer, listed until the run that applies it starts; nothing when none waits. */
function QueuedFeedbackList({ timeline }: { timeline: ItemDetail["timeline"] | undefined }) {
  const pending = pendingFeedback(timeline ?? []);
  if (pending.length === 0) return null;
  return (
    <section aria-label={t("commands.feedback")} data-queued-feedback className="mt-3">
      <h3 className="text-sm font-medium">
        {t("commands.feedback")} <span className="text-xs font-normal text-text-2">({t("items.queued")})</span>
      </h3>
      <ul className="mt-1 space-y-1">
        {pending.map((p) => (
          <li key={p.comment_id} data-queued={p.comment_id} className="text-sm text-pretty break-words whitespace-pre-wrap text-text-1">
            {p.feedback}
          </li>
        ))}
      </ul>
    </section>
  );
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
  if (local && (!latest || latest.seq < local.seq)) return { tone: "status", text: t("commands.sent") };
  if (!latest) return null;
  if (latest.refusal) return { tone: "error", text: plainRefusal(latest.refusal) };
  return { tone: "status", text: latest.handled_at === null ? t("commands.sent") : t("commands.done") };
}

/** Whether `outcome` is the "sent" state: a request queued, its reply not here yet. */
export const awaitsReply = (outcome: Outcome): boolean => outcome?.tone === "status" && outcome.text === t("commands.sent");

/**
 * Sending app commands for item `id`: `send` posts one with the session's token, keeps what this page did with each
 * command (`local`), and on success re-reads the item and the list, so the controller's reply shows. `on`: commands
 * are on for this page's session.
 */
export function useCommandSend(id: string) {
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

/** The command the state asks for: the first of approve, retry and resolve the viewer may send. */
export const primaryOf = (commands: readonly ItemCommand[]) => commands.find((c) => PRIMARY.includes(c.name) && c.allowed);

/**
 * `factory <command> <short number>` for a terminal: the item's short number on the page, the full command (with the
 * item's ID, which the CLI takes) behind the Copy button.
 */
function CliHint({ command, id, short }: { command: string; id: string; short: string }) {
  return (
    <p data-cli-hint className="mt-3 flex flex-wrap items-baseline gap-x-2 text-xs text-text-2">
      <span>{t("decide.cli")}</span>
      <CopyText value={`factory ${command} ${id}`} what="command">{`factory ${command} ${short}`}</CopyText>
    </p>
  );
}

/** Opens the thread entry `anchor` (`msg-<seq>`) in the page; the link's href is the same fragment. */
function showInThread(e: MouseEvent<HTMLAnchorElement>, anchor: string) {
  const el = document.getElementById(anchor);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView?.({ block: "start" });
  history.replaceState(history.state, "", `#${anchor}`);
}

/** The newest factory message of the thread, as the context of the decision: its one-line summary and its anchor. */
function ThreadContext({ thread }: { thread: readonly ThreadEntry[] | undefined }) {
  const latest = threadOrder(thread ?? []).find((m) => m.role === "factory");
  if (!latest) return null;
  return (
    <div data-decide-context className="mt-2 text-sm text-pretty text-text-1">
      <p className="line-clamp-2 break-words">{summaryOf(latest.body)}</p>
      <a href={`#${latest.anchor}`} onClick={(e) => showInThread(e, latest.anchor)} className={LINK_CLASS}>
        {t("decide.showInThread")}
      </a>
    </div>
  );
}

/**
 * The item page's decision area. The reason (the why sentence) shows always. "What you need to decide" shows only
 * while the item waits for the owner (why.next_actor is human): the context (the newest factory message, with its
 * "Show in thread" link), In short, the decisions, one note box (Ctrl/⌘+Enter reads it as a sentence) with the item's
 * pending proposals, and one row: the primary action (Merge, else Approve, Retry or Answer), the Good/Bad control,
 * Feedback, the other commands and the "…" menu. Reject and Verdict live in that menu (outside the box too, so an
 * item that waits for nobody can still be rejected).
 */
export function ItemCommands({ id, commands, replies, reason = null }: { id: string; commands: readonly ItemCommand[]; replies: readonly CommandReply[]; reason?: ReactNode }) {
  const { session, on: enabled, busy, local, send: post } = useCommandSend(id);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<FormName | "approve" | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const opener = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<DecisionChoice[] | null>(null);
  // The page's own item query (same key and options), read here for its `merge`, `why` and its waiting spec.
  const data = useApi<ItemDetail>(API.item(id)).data;
  const detail = data?.item;
  const merge = detail?.merge;
  const showMerge = showsMerge(merge);
  const phase = approvePhase(detail?.blocked_reason);
  // Only a spec at the gate is answered; the floor block, the Rule of Two and a held run approve no decisions.
  const decisions = phase === "spec_pending" || phase === "max_revisions" ? (data?.spec?.decisions ?? []) : [];
  const choices = picked ?? initialChoices(decisions);
  const answers = chosenAnswers(decisions, choices);
  const waiting = detail?.why?.next_actor === "human";
  const off = session.isError || session.data?.commands_enabled === false;
  const itemTitle = detail?.title ?? id;
  const primary = primaryOf(commands);
  const proposals = (
    <PendingProposals
      proposals={data?.proposals ?? []}
      enabled={enabled}
      busy={busy}
      outcomes={(proposal) => commandOutcome([], proposal, local[proposal])}
      send={post}
    />
  );

  /** Sends `command` with `text` (a form's) or, without it, the note box's. */
  const send = async (command: string, text?: string) => {
    if (!(await post(command, text ?? note))) return;
    if (text === undefined) setNote("");
    else setOpen(null);
    setPicked(null);
  };
  const dialogs = (
    <>
      {open === "approve" && phase !== null && (
        <ApproveDialog
          title={`${commandLabel("approve")} ${itemTitle}`}
          phase={phase}
          answers={answers}
          note={note}
          busy={busy || !enabled}
          error={local.approve && "error" in local.approve ? local.approve.error : null}
          returnFocusTo={opener}
          onSend={(text) => void send("approve", text)}
          onClose={() => setOpen(null)}
        />
      )}
      {open !== null && open !== "approve" && (
        <CommandDialog
          command={open}
          title={itemTitle}
          pr={detail?.change_ref ?? null}
          busy={busy || !enabled}
          error={local[open] && "error" in local[open] ? local[open].error : null}
          returnFocusTo={open === "verdict" || open === "reject" ? moreButton : opener}
          onSend={(t) => void send(open, t)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
  // Verdict and Reject: in the "…" menu, one the viewer may not send disabled with its reason.
  const menuItems = commands.filter((c) => MENU.includes(c.name)).map((c) => ({
    label: c.allowed ? commandLabel(c.name) : `${commandLabel(c.name)}: ${plainRefusal(c.reason ?? "not allowed")}`,
    disabled: !enabled || busy || !c.allowed,
    onSelect: () => setOpen(c.name as FormName),
  }));
  const menu = menuItems.length > 0 && <OverflowMenu label={t("commands.more")} items={menuItems} />;

  // An item that waits for nobody (running, or the factory's turn): its reason, the "…" menu and no box.
  if (!waiting) {
    return (
      <div ref={wrap} className="mt-2">
        {reason}
        <QueuedFeedbackList timeline={data?.timeline} />
        {commands.length === 0 && !showMerge && (
          <p data-commands-none className="mt-2 text-sm text-pretty text-text-2">
            {t("commands.none")}
          </p>
        )}
        {menu && <div data-item-menu className="mt-2 flex">{menu}</div>}
        {proposals}
        {dialogs}
      </div>
    );
  }

  const verdict = commands.find((c) => c.name === "verdict");
  const verdictOff = !enabled || busy || !verdict?.allowed;
  const tap = (choice: OneTapChoice) => {
    const text = oneTapNote(choice, note);
    if (text !== null && !verdictOff) void post("verdict", text).then((ok) => ok && setNote(""));
  };
  const feedback = oneTapNote("feedback", note);
  const rest = commands.filter((c) => c !== primary && !MENU.includes(c.name));
  const outcomes = [
    ...commands.map((c) => ({ name: c.name, outcome: c.allowed ? commandOutcome(replies, c.name, local[c.name]) : notAllowed(c) })),
    { name: SENTENCE, outcome: commandOutcome(replies, SENTENCE, local[SENTENCE]) },
  ].filter((o) => o.outcome !== null);

  const button = (c: ItemCommand) => {
    const opensDialog = DIALOGS.includes(c.name) || (c.name === "approve" && phase !== null);
    return (
      <span key={c.name} data-command={c.name} className="inline-flex">
        <Button
          variant={c === primary && !showMerge ? "primary" : "secondary"}
          disabled={!enabled || busy || !c.allowed}
          title={`${c.usage}: ${c.description}`}
          {...(opensDialog ? { "aria-haspopup": "dialog" as const } : {})}
          onClick={(e) => {
            opener.current = e.currentTarget;
            if (!opensDialog) void send(c.name);
            else setOpen(c.name as FormName | "approve");
          }}
        >
          {commandLabel(c.name)}
        </Button>
      </span>
    );
  };

  return (
    <section
      ref={wrap}
      aria-label={t("decide.title")}
      data-decide
      className="mt-3 rounded-card border border-pill-warn-fg bg-pill-warn-bg p-3 text-text-1"
    >
      <h2 className="mb-1 text-balance text-sm font-semibold">{t("decide.title")}</h2>
      {reason}
      <ThreadContext thread={data?.thread} />
      <InShort spec={data?.spec} />
      <QueuedFeedbackList timeline={data?.timeline} />
      <section aria-label={t("commands.label")} className="mt-3">
        {off && (
          <p role="status" data-commands-off className="mb-2 text-sm text-pretty text-text-2">
            {t("commands.offBefore")}
            <Link href={PAGE_COMMANDS_PATH} className={LINK_CLASS}>
              {t("commands.offSettings")}
            </Link>
            {t("commands.offAfter")}
          </p>
        )}
        {enabled && session.data?.actor && (
          <p data-commands-actor className="mb-2 text-xs text-pretty text-text-2">
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
            if (enabled && !busy && note.trim() !== "") void send(SENTENCE);
          }}
          placeholder={t("commands.notePlaceholder")}
          className="mb-3 block w-full max-w-xl"
        />
        <div className="flex flex-wrap items-center gap-2">
          {showMerge ? <span data-command="merge" className="inline-flex"><MergeButton id={id} source={detail?.source.type} merge={merge} replies={replies} /></span> : primary && button(primary)}
          {verdict && (
            <span data-verdict className="inline-flex">
              <SegmentedControl<OneTapChoice | "">
                label={t("commands.verdict")}
                options={[{ id: "good", label: t("commands.good") }, { id: "bad", label: t("commands.bad") }]}
                value=""
                onChange={(choice) => choice !== "" && tap(choice)}
              />
            </span>
          )}
          {verdict && (
            <Button
              variant="secondary"
              data-verdict-tap="feedback"
              disabled={verdictOff || feedback === null}
              title={`${verdict.usage}: ${verdict.description}${t("commands.needFeedback")}`}
              onClick={() => feedback !== null && tap("feedback")}
            >
              {t("commands.feedback")}
            </Button>
          )}
          {rest.map(button)}
          {menu}
        </div>
        <div className="mt-2 flex flex-col items-start gap-1">
          {outcomes.map((o) => <div key={o.name} data-outcome-of={o.name}><OutcomeText outcome={o.outcome} /></div>)}
        </div>
        {proposals}
        {primary && detail && <CliHint command={primary.name} id={id} short={shortSource(detail.source.id)} />}
        {dialogs}
      </section>
    </section>
  );
}

/** The dialog for `command` (reject, revise or verdict), the same on the Floor and the item page. `title` is the item's. */
function CommandDialog({ command, title, pr, ...props }: Omit<CommandDialogProps, "title"> & { command: FormName; title: string; pr: string | null }) {
  const full = `${commandLabel(command)} ${title}`;
  if (command === "reject") return <RejectDialog title={full} pr={pr} {...props} />;
  if (command === "revise") return <ReviseDialog title={full} {...props} />;
  return <VerdictDialog title={full} {...props} />;
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
  // Merging… from the click until the controller's reply (handled or refused) arrives.
  const merging = merge.enabled && (busy || awaitsReply(outcome));
  return (
    <span data-merge={merge.enabled ? "enabled" : "disabled"} className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        disabled={!merge.enabled || !on || merging}
        title={source === "local"
          ? t("commands.mergeLocal")
          : t("commands.mergePr")}
        onClick={() => void send()}
      >
        {merging ? t("commands.merging") : t("commands.merge")}
      </Button>
      <OutcomeText outcome={outcome} />
    </span>
  );
}

/**
 * The verdict dialog, on the Floor and the item page: an Accept, Changes or Reject choice, a severity and a reason,
 * sent as `<kind> <severity> <reason>` (verdictNote). Changes and Reject need a reason; Accept sends without one.
 */
function VerdictDialog({ title, busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps) {
  const [kind, setKind] = useState<VerdictChoice>("accept");
  const [severity, setSeverity] = useState<VerdictSeverityChoice>("none");
  const [reason, setReason] = useState("");
  const uid = useId();
  return (
    <Dialog
      title={title}
      consequence={t("commands.verdictConsequence")}
      confirmLabel={t("commands.sendVerdict")}
      confirmDisabled={busy || (kind !== "accept" && reason.trim() === "")}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(verdictNote(kind, severity, reason))}
      onClose={onClose}
    >
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">{t("commands.verdict")}</legend>
        <div role="radiogroup" aria-label={t("commands.verdict")} className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {VERDICTS.map(([k, label]) => (
            <Radio key={k} name="verdict-kind" checked={kind === k} onChange={() => setKind(k)}>
              {t(label)}
            </Radio>
          ))}
        </div>
      </fieldset>
      <Field label={t("commands.severityLabel")} htmlFor={`${uid}-severity`}>
        <Select id={`${uid}-severity`} value={severity} onChange={(e) => setSeverity(e.target.value as VerdictSeverityChoice)}>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(SEVERITY_LABEL[s])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("decisions.reason")} htmlFor={`${uid}-reason`}>
        <Textarea id={`${uid}-reason`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full" />
      </Field>
    </Dialog>
  );
}

/** A Needs-you row's primary button label, in sentence case; `resolve` answers what the item asked. */
const PRIMARY_LABEL: Record<string, MessageKey> = { approve: "needs.actApprove", retry: "needs.actRetry", resolve: "needs.actAnswer" };
/** The key that presses a row's primary button when the row is selected (never Merge). */
export const PRIMARY_KEY = "p";

/** What a Needs-you row's Actions cell needs of the row: its group, the merge state and the commands the Why text names. */
export interface NeedActionsProps {
  id: string;
  /** The item's title, or its ID when it has none: the dialogs' titles. */
  title: string;
  commands: readonly ItemCommand[];
  pr: string | null;
  /** "merge": the primary button is Merge (disabled with the reason, or "Checking…" while the merge check runs). */
  group: "merge" | "approve" | "answer";
  merge?: MergeReadiness | undefined;
  source: string;
  checking: boolean;
  /** The row's command sender, shared with its Why text. */
  cmd: ReturnType<typeof useCommandSend>;
  /** Overflow entries from the Why text (`Allow x and retry`): each sends `retry` with `note`. */
  allow: readonly { label: string; note: string }[];
  /** False: the row shows the failed sends itself (SendErrors on its own line, design-system C-050), not this cell. */
  inlineErrors?: boolean;
}

/** The errors of a row's failed sends, one alert each (NeedActions' `cmd.local`). */
export function SendErrors({ local }: { local: Record<string, LocalSend> }) {
  return Object.values(local).flatMap((l) => ("error" in l ? [<OutcomeText key={l.error} outcome={{ tone: "error", text: l.error }} />] : []));
}

/**
 * A Needs-you row's actions (design §9, issues #453, #513): always one primary button, then the "⋯" menu last. The
 * primary is Merge on a merge row, else the command the state asks for (Approve, Retry or Answer, the first the
 * viewer may send), else "Open" to the item page. The menu holds every other command and the Why text's allow
 * entries; one the viewer may not send stays, disabled, with its reason. Reject, revise and verdict open a dialog
 * (outside the row, so the row never grows); the others send at once. A send re-reads the list, so the row moves on;
 * a failed send shows its error in the cell (or, with `inlineErrors` false, where the row puts SendErrors), a sent
 * one in a short status message that outlives the row.
 */
export function NeedActions({ id, title, commands, pr, group, merge, source, checking, cmd, allow, inlineErrors = true }: NeedActionsProps) {
  const { on, busy, local, send: post } = cmd;
  const [open, setOpen] = useState<FormName | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const primary = group === "merge" ? undefined : primaryOf(commands);
  const others = commands.filter((c) => c !== primary);
  const off = !on || busy;
  // A merge this row sent: its replies from the item's own query (the item page's key), read only until the reply.
  const mergeSent = group === "merge" && !!local.merge && "seq" in local.merge;
  const mergeOutcome = (replies: readonly CommandReply[] = []) => commandOutcome(replies, "merge", local.merge);
  const detail = useQuery({
    queryKey: [API.item(id)],
    queryFn: () => getJson<ItemDetail>(API.item(id)),
    enabled: mergeSent,
    refetchInterval: (q) => (awaitsReply(mergeOutcome(q.state.data?.replies)) ? POLL_MS : false),
  });
  const outcome = mergeSent ? mergeOutcome(detail.data?.replies) : null;
  // Merging… from the click until the controller's reply (handled or refused) arrives.
  const merging = group === "merge" && (busy || awaitsReply(outcome));
  const send = async (command: string, note: string) => {
    if (!(await post(command, note))) return;
    announceStatus(t("commands.commandSent", { command }));
    setOpen(null);
  };
  const canRetry = commands.some((c) => c.name === "retry" && c.allowed);
  const items = [
    ...others.map((c) => ({
      label: c.allowed ? commandLabel(c.name) : `${commandLabel(c.name)}: ${plainRefusal(c.reason ?? "not allowed")}`,
      disabled: off || !c.allowed,
      onSelect: () => (DIALOGS.includes(c.name) ? setOpen(c.name as FormName) : void send(c.name, "")),
    })),
    ...allow.map((a) => ({ label: a.label, disabled: off || !canRetry, onSelect: () => void send("retry", a.note) })),
  ];
  return (
    <span ref={wrap} data-need-commands className="inline-flex flex-wrap items-center justify-end gap-2">
      {group === "merge" ? (
        <span data-command="merge" className="inline-flex items-center gap-2">
          <Tooltip text={merge && !merge.enabled && merge.reason ? merge.reason : source === "local" ? t("commands.mergeLocal") : t("commands.mergePr")}>
            <Button variant="secondary" disabled={off || checking || merging || !merge?.enabled} onClick={() => void send("merge", "")}>
              {checking ? t("needs.checking") : merging ? t("commands.merging") : t("commands.merge")}
            </Button>
          </Tooltip>
          {!awaitsReply(outcome) && <OutcomeText outcome={outcome} />}
        </span>
      ) : primary ? (
        <span data-command={primary.name} className="inline-flex">
          <Tooltip text={t("needs.withKey", { label: t(PRIMARY_LABEL[primary.name]!), key: PRIMARY_KEY })}>
            <Button variant="secondary" data-shortcut={PRIMARY_KEY} disabled={off} onClick={() => void send(primary.name, "")}>
              {t(PRIMARY_LABEL[primary.name]!)}
            </Button>
          </Tooltip>
        </span>
      ) : (
        <Link href={itemPath(id)} data-command="open" className={cn("inline-flex min-h-8 items-center rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-text-1 hover:bg-surface-2", FOCUS)}>
          {t("needs.actOpen")}
        </Link>
      )}
      <OverflowMenu label={t("commands.more")} items={items.length > 0 ? items : [{ label: t("needs.noMore"), disabled: true, onSelect: () => undefined }]} />
      {inlineErrors && <SendErrors local={local} />}
      {open !== null && (
        <CommandDialog
          command={open}
          title={title}
          pr={pr}
          busy={off}
          error={local[open] && "error" in local[open] ? local[open].error : null}
          returnFocusTo={moreButton}
          onSend={(t) => void send(open, t)}
          onClose={() => setOpen(null)}
        />
      )}
    </span>
  );
}
