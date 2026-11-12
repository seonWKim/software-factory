import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { API, type CommandReply, type ItemCommand, type ItemDetail, type MergeReadiness, type Session, plainRefusal, postCommand, showsMerge, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { CopyText } from "../components/ui/copy.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { OverflowMenu, Tooltip } from "../components/ui/menu.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { shortSource } from "../lib/format.js";
import { Link } from "../nav.js";
import { PAGE_COMMANDS_PATH, itemPath } from "../pages.js";
import { CommandBox, type Outcome, OutcomeText, PendingProposals, SENTENCE } from "./command-box.js";
import { PersonName } from "./common.js";
import {
  ApproveConfirm, type DecisionChoice, DecisionsPanel, InShort, RejectDialog, ReviseDialog, approveNote, approvePhase, chosenAnswers, initialChoices, type CommandDialogProps,
} from "./item-decisions.js";

// The item page's command buttons (design §9, issue #228): one button per entry of the item API's `commands`,
// in its order: the commands that apply now. One the viewer's grants do not allow (`allowed` false, issue #453) is
// disabled with the controller's reason beside it, in plain text; every refusal shows without backticks. Reject and revise open a dialog (issue #527): reject asks why and confirms what closes,
// revise takes a comment per spec section. Verdict (issue #523) is three buttons, Accept, Changes and Reject, with a
// severity choice; a click sends `<kind> <severity> <reason>` (verdictNote), the reason the note box's text. Beside
// them, the one-tap Good, Bad and Feedback (oneTapNote), the same verdict request as Slack's buttons store: Good is
// accept/none, Bad changes/minor, Feedback changes/none with the note box's text. Every
// other command carries the note box's text when it has any (tokens for budget, the approve note). A send
// is POST /api/v1/items/:id/commands with the token from GET /api/v1/session; the controller applies it on its
// next tick, and the item's `replies` say how that went. An item waiting for its merge also gets the Merge button
// (MergeButton, also in Needs you), enabled or disabled with its reason as the item API's `merge` says.
// A waiting spec (issue #526) shows its In short above Commands and its decisions as questions above the note box;
// approve in an approve phase (the spec gate, the floor block, the Rule of Two) goes through a confirm step first;
// approve sends the answers as `N: <answer>` lines. Below the buttons, the item's pending proposals and the command
// box (command-box.tsx), sent through the same app request route.
// All of it sits in one "What you need to decide" box at the top of the item page (design 09-dashboard-app): the
// reason, In short, the decisions with their defaults, the buttons that apply now (the one the state asks for is the
// primary button) and the same command for a terminal, naming the item's short number.

/** Commands sent from their own dialog, not with the note box. */
const FORMS = ["reject", "revise"];
/** In Needs you, which has no note box, verdict has its own dialog too (issue #513). */
const NEED_FORMS = [...FORMS, "verdict"];
/** The commands a Needs-you row shows as its one primary button: what the state asks for. */
const PRIMARY = ["approve", "retry", "resolve"];

/** The verdict as typed after `/verdict`, the placeholder of its text form. */
export const VERDICT_PLACEHOLDER = "accept|changes|reject <none|minor|major|critical> <reason>";

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
const ONE_TAP = [["good", "commands.good"], ["bad", "commands.bad"], ["feedback", "commands.feedback"]] as const satisfies readonly (readonly [string, MessageKey])[];
export type OneTapChoice = (typeof ONE_TAP)[number][0];

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

/**
 * The item page's decide box: `reason` (the why sentence) first; with commands that apply now, "What you need to
 * decide" with In short, the decisions, the note box and the buttons; else the reason and one line saying no
 * command applies.
 */
export function ItemCommands({ id, commands, replies, reason = null }: { id: string; commands: readonly ItemCommand[]; replies: readonly CommandReply[]; reason?: ReactNode }) {
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
      <div className="mt-2">
        {reason}
        <InShort spec={data?.spec} />
        <p data-commands-none className="mt-2 text-sm text-pretty text-text-2">
          {t("commands.none")}
        </p>
        {sentenceParts}
      </div>
    );
  }
  const off = session.isError || session.data?.commands_enabled === false;
  const usesNote = commands.some((c) => c.allowed && !FORMS.includes(c.name));
  const primary = primaryOf(commands);

  /** Sends `command` with `text` (a form's) or, without it, the note box's. */
  const send = async (command: string, text?: string) => {
    setConfirming(null);
    if (!(await post(command, text ?? (command === "approve" ? approveNote(answers, note) : note)))) return;
    if (text === undefined) setNote("");
    else setOpen(null);
    setPicked(null);
  };

  return (
    <section
      aria-label={t("decide.title")}
      data-decide
      className="mt-3 rounded-card border border-pill-warn-fg bg-pill-warn-bg p-3 text-text-1"
    >
      <h2 className="mb-1 text-balance text-sm font-semibold">{t("decide.title")}</h2>
      {reason}
      <InShort spec={data?.spec} />
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
        {usesNote && (
          <Textarea
            aria-label={t("commands.note")}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("commands.notePlaceholder")}
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
                  variant={c === primary ? "primary" : "secondary"}
                  className="capitalize"
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
                        {t("commands.cancel")}
                      </Button>
                      <Button variant="primary" disabled={disabled} onClick={() => void send(c.name)}>
                        {t("commands.confirm", { name: c.name })}
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
        {primary && detail && <CliHint command={primary.name} id={id} short={shortSource(detail.source.id)} />}
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
      </section>
    </section>
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
 * verdictNote with `reason` (the note box's text), then Good, Bad and Feedback (oneTapNote), and the outcome. Changes,
 * reject and Feedback need the note box's text, so they wait for it. A handled verdict shows Done as a ghost button,
 * which hides it; a newer verdict's outcome shows again.
 */
function VerdictButtons({
  title, disabled, reason, outcome, onSend,
}: { title: string; disabled: boolean; reason: string; outcome: Outcome; onSend: (note: string) => void }) {
  const [severity, setSeverity] = useState<VerdictSeverityChoice>("none");
  const [doneHidden, setDoneHidden] = useState(false);
  const done = outcome?.tone === "status" && outcome.text === t("commands.done");
  // A new send (its outcome "sent") shows the next Done again.
  if (!done && doneHidden) setDoneHidden(false);
  return (
    <div data-verdict className="flex flex-wrap items-center gap-2">
      {/* The visible label says Severity; the accessible name says which severity. */}
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        {t("decide.severity")}
        <Select
          aria-label={t("commands.severityLabel")}
          value={severity}
          disabled={disabled}
          onChange={(e) => setSeverity(e.target.value as VerdictSeverityChoice)}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(SEVERITY_LABEL[s])}
            </option>
          ))}
        </Select>
      </label>
      <ButtonRow>
        {VERDICTS.map(([kind, label]) => (
          <Button
            key={kind}
            variant={VERDICT_VARIANT[kind]}
            data-verdict-kind={kind}
            disabled={disabled || (kind !== "accept" && reason.trim() === "")}
            title={kind === "accept" ? title : `${title}${t("commands.needReason")}`}
            onClick={() => onSend(verdictNote(kind, severity, reason))}
          >
            {t(label)}
          </Button>
        ))}
        {ONE_TAP.map(([choice, label]) => {
          const sent = oneTapNote(choice, reason);
          return (
            <Button
              key={choice}
              variant="secondary"
              data-verdict-tap={choice}
              disabled={disabled || sent === null}
              title={choice === "feedback" ? `${title}${t("commands.needFeedback")}` : title}
              onClick={() => sent !== null && onSend(sent)}
            >
              {t(label)}
            </Button>
          );
        })}
        {done ? (
          !doneHidden && (
            <Button variant="ghost" data-outcome title={t("commands.handled")} onClick={() => setDoneHidden(true)}>
              {t("commands.done")}
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
          ? t("commands.mergeLocal")
          : t("commands.mergePr")}
        onClick={() => void send()}
      >
        {t("commands.merge")}
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
      title={t("commands.verdictTitle", { id })}
      consequence={t("commands.verdictConsequence")}
      confirmLabel={t("commands.sendVerdict")}
      confirmDisabled={busy || text.trim() === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(text.trim())}
      onClose={onClose}
    >
      <Input aria-label={t("commands.verdict")} value={text} onChange={(e) => setText(e.target.value)} placeholder={VERDICT_PLACEHOLDER} className="w-full" />
    </Dialog>
  );
}

/** A Needs-you row's primary button label, in sentence case; `resolve` answers what the item asked. */
const PRIMARY_LABEL: Record<string, MessageKey> = { approve: "needs.actApprove", retry: "needs.actRetry", resolve: "needs.actAnswer" };
/** The key that presses a row's primary button when the row is selected (never Merge). */
export const PRIMARY_KEY = "p";

const sentence = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** What a Needs-you row's Actions cell needs of the row: its group, the merge state and the commands the Why text names. */
export interface NeedActionsProps {
  id: string;
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
}

/**
 * A Needs-you row's actions (design §9, issues #453, #513): always one primary button, then the "⋯" menu last. The
 * primary is Merge on a merge row, else the command the state asks for (Approve, Retry or Answer, the first the
 * viewer may send), else "Open" to the item page. The menu holds every other command and the Why text's allow
 * entries; one the viewer may not send stays, disabled, with its reason. Reject, revise and verdict open a dialog
 * (outside the row, so the row never grows); the others send at once. A send re-reads the list, so the row moves on;
 * a failed send shows its error in the row, a sent one in a short status message that outlives the row.
 */
export function NeedActions({ id, commands, pr, group, merge, source, checking, cmd, allow }: NeedActionsProps) {
  const { on, busy, local, send: post } = cmd;
  const [open, setOpen] = useState<"reject" | "revise" | "verdict" | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const primary = group === "merge" ? undefined : primaryOf(commands);
  const others = commands.filter((c) => c !== primary);
  const off = !on || busy;
  const send = async (command: string, note: string) => {
    if (!(await post(command, note))) return;
    announceStatus(t("commands.commandSent", { command }));
    setOpen(null);
  };
  const canRetry = commands.some((c) => c.name === "retry" && c.allowed);
  const items = [
    ...others.map((c) => ({
      label: c.allowed ? sentence(c.name) : `${sentence(c.name)}: ${plainRefusal(c.reason ?? "not allowed")}`,
      disabled: off || !c.allowed,
      onSelect: () => (NEED_FORMS.includes(c.name) ? setOpen(c.name as "reject" | "revise" | "verdict") : void send(c.name, "")),
    })),
    ...allow.map((a) => ({ label: a.label, disabled: off || !canRetry, onSelect: () => void send("retry", a.note) })),
  ];
  const failed = Object.values(local).flatMap((l) => ("error" in l ? [l.error] : []));
  return (
    <span ref={wrap} data-need-commands className="inline-flex flex-wrap items-center justify-end gap-2">
      {group === "merge" ? (
        <span data-command="merge" className="inline-flex">
          <Tooltip text={merge && !merge.enabled && merge.reason ? merge.reason : source === "local" ? t("commands.mergeLocal") : t("commands.mergePr")}>
            <Button variant="secondary" disabled={off || checking || !merge?.enabled} onClick={() => void send("merge", "")}>
              {checking ? t("needs.checking") : t("commands.merge")}
            </Button>
          </Tooltip>
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
      {failed.map((text) => (
        <OutcomeText key={text} outcome={{ tone: "error", text }} />
      ))}
      {open !== null && (
        <CommandDialog
          command={open}
          id={id}
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
