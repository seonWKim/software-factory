import { Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import {
  API, type CommandReply, type ItemCommand, type ItemDetail, type MergeReadiness, type OverCapSizes, POLL_MS, getJson,
  alreadyQueued, mergeInFlight, mergeReturned, plainRefusal, showsMerge, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { copyToClipboard } from "../components/ui/copy.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { KeyValue } from "../components/ui/key-value.js";
import { Radio } from "../components/ui/radio.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { SUB_TITLE } from "../components/ui/card.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { type Outcome, OutcomeText, PendingProposals } from "./command-box.js";
import { type LocalSend, awaitsReply, commandOutcome, useCommandSend } from "./command-send.js";
import { RestartButton } from "./merge-button.js";
import { RejectDialog, ReviseDialog, commandLabel, type CommandDialogProps } from "./item-decisions.js";
import { AddContextActions } from "./item-attachments.js";

// Item commands (design §9, issues #228, #526; design 09-dashboard-item-commands): the sends, outcomes and dialogs
// the item page's DecisionCard (decision-card.tsx) and the Needs you rows share. A send is POST
// /api/v1/items/:id/commands with the token from GET /api/v1/session. Approve and Merge are applied while the request
// is handled (design 09-dashboard-app, 2026-11-15): the response's state goes into the item and list queries at once and
// the row reads its label ("Approved", "Merging…") or the refusal; the controller applies every other command on its
// next tick, and the item's `replies` say how that went. A command the viewer's grants do not allow (`allowed` false,
// issue #453) is disabled with the controller's reason in plain text. Reject, revise and verdict open the one shared
// Dialog; verdict (issue #523) is an Accept, Changes or Reject choice with a severity and a reason sent as
// `<kind> <severity> <reason>` (verdictNote). A permission ask's paths (the item API's `paths`) go with the command
// that allows them as `+paths` (withPaths). Feedback a `/revise` queued while implementing is listed until the run that
// applies it starts (pendingFeedback). A merged item with `repo.restart_command` set has a `restart` row: the Restart
// app button (RestartButton), which sends `restart` with no note, as `factory restart` does. A New or in-triage item
// (stage NEW, where `/revise` applies) has Add context and Attach (AddContextActions, item-attachments.tsx, design 02-attachments).
// An item with a queued run has Run next (RunNextButton, design 05-coordination), which sends `run-next` with no note,
// as `factory run-next` does; in the "…" menu when the Add context row already holds three actions.

/** Every command that opens a dialog from a button: reject and revise (their forms), and verdict (its Accept, Changes or Reject choice). */
export const DIALOGS = ["reject", "revise", "verdict"];
/**
 * A Needs-you Approve over the item's size caps (its `over_cap`) opens OverCapApproveDialog: the controller refuses it
 * without a note. Allow and resolve (allowsResolve) opens AllowResolveDialog, which lists the files first.
 */
const opensDialog = (c: ItemCommand): boolean => DIALOGS.includes(c.name) || (c.name === "approve" && c.over_cap !== undefined) || allowsResolve(c);
/** The commands the item's "…" menu holds (on the DecisionCard too): they are rare, so they are no buttons in its row. */
export const MENU = ["reject", "verdict"];
export type FormName = "reject" | "revise" | "verdict";
/**
 * The commands a decision's one primary button can be, in the order the state asks for them: Retry last, so a block
 * reason that accepts Approve or Answer never shows Retry first.
 */
const PRIMARY = ["approve", "resolve", "retry"];
/** The main action of an item that stopped the same way three times (`repeated_stop`), in this order, before PRIMARY. */
const AFTER_REPEATS = ["revise", "reject"];

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

/**
 * The one-tap verdicts (design §9), as Slack's result messages offer them. Good and Bad are the two segments of the
 * one-tap control; Feedback is a button, as it waits for the note box's text.
 */
export type OneTapChoice = "good" | "bad" | "feedback";

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
export function QueuedFeedbackList({ timeline }: { timeline: ItemDetail["timeline"] | undefined }) {
  const pending = pendingFeedback(timeline ?? []);
  if (pending.length === 0) return null;
  return (
    <section aria-label={t("commands.feedback")} data-queued-feedback className="mt-3">
      <h3 className={SUB_TITLE}>
        {t("commands.feedback")} ({t("items.queued")})
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

/**
 * Item `id`'s command `c` as an entry of a "…" menu: its label (with the controller's reason when the viewer may not
 * send it, then disabled), its `data-action` and `data-item`, and `onSelect`. `off`: commands are off or a send is under way.
 */
export function menuEntry(id: string, c: ItemCommand, off: boolean, onSelect: () => void): MenuItem {
  return {
    label: c.allowed ? commandLabel(c.name) : `${commandLabel(c.name)}: ${plainRefusal(c.reason ?? "not allowed")}`,
    disabled: off || !c.allowed,
    action: c.name,
    item: id,
    onSelect,
  };
}

/** The actions that are `factory task <verb>` commands (src/core/command-table.ts); every other action is `factory <verb>`. */
const TASK_VERBS = ["build", "done", "reopen"];

/** Action `action` on `id` as typed in a terminal: `factory approve wi_1`, `factory task reopen tk_1`. */
export const cliCommand = (action: string, id: string): string => `factory ${TASK_VERBS.includes(action) ? "task " : ""}${action} ${id}`;

/**
 * A row's "Copy as CLI command" menu entry (design 09-dashboard-shell): copies `cliCommand(action, id)`, the row's
 * main action as a terminal runs it, and says so.
 */
export function copyCliEntry(action: string, id: string): MenuItem {
  return {
    label: t("commands.copyCli"),
    icon: Terminal,
    onSelect: () => void copyToClipboard(cliCommand(action, id)).then((ok) => ok && announceStatus(t("commands.copiedCli", { command: cliCommand(action, id) }))),
  };
}

/**
 * A command row with a permission ask's paths (the item API's `paths`, src/ui/commands.ts ItemCommandRow), and
 * `out_of_scope` when they are an out_of_scope resolve failure's `/resolve +paths` reply files.
 */
type AcceptedCommand = ItemCommand & { paths?: readonly string[]; out_of_scope?: boolean };
/** The paths a permission ask names on `c`, which its button sends as `+paths`; none for any other command. */
export const pathsOf = (c: ItemCommand): readonly string[] => (c as AcceptedCommand).paths ?? [];
/** A resolve row with an out_of_scope failure's reply files: its Allow and resolve opens AllowResolveDialog first (2026-11-26). */
export const allowsResolve = (c: ItemCommand): boolean => c.name === "resolve" && (c as AcceptedCommand).out_of_scope === true && pathsOf(c).length > 0;

/** The note `c` sends: its permission ask's `+paths <path>...` line first (design §4, issue #280), then `note`. */
export function withPaths(c: ItemCommand, note: string): string {
  const paths = pathsOf(c);
  return paths.length === 0 ? note : [`+paths ${paths.join(" ")}`, note.trim()].filter((l) => l !== "").join("\n");
}

/**
 * The command the state asks for, of those the viewer may send: the one that allows a permission ask's paths; else,
 * on an item that stopped the same way three times (`repeated_stop`), Revise, then Reject; else the first of approve,
 * resolve and retry (PRIMARY order, not the API's), so Retry only when neither other applies.
 */
export function primaryOf(commands: readonly ItemCommand[]): ItemCommand | undefined {
  const allowed = commands.filter((c) => c.allowed);
  const first = (names: readonly string[], cs: readonly ItemCommand[]) => cs.filter((c) => names.includes(c.name)).sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name))[0];
  return first(PRIMARY, allowed.filter((c) => pathsOf(c).length > 0))
    ?? first(AFTER_REPEATS, allowed.filter((c) => c.repeated_stop))
    ?? first(PRIMARY, allowed);
}

/**
 * The item's commands while it waits for nobody (running, or the factory's turn; the DecisionCard holds them while
 * the owner is next): its reason, the feedback queued for it, a line when no command applies, and the "…" menu with
 * Reject and Verdict, so any open item can still be rejected; then its pending proposals.
 */
export function ItemCommands({ id, commands, reason = null }: { id: string; commands: readonly ItemCommand[]; reason?: ReactNode }) {
  const { on: enabled, busy, local, send: post, session } = useCommandSend(id);
  const [open, setOpen] = useState<FormName | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const data = useApi<ItemDetail>(API.item(id)).data;
  const detail = data?.item;
  // Verdict and Reject: in the "…" menu, one the viewer may not send disabled with its reason.
  const menuItems = commands.filter((c) => MENU.includes(c.name)).map((c) => menuEntry(id, c, !enabled || busy, () => setOpen(c.name as FormName)));
  const restart = commands.find((c) => c.name === "restart");
  const queued = data?.runs.some((r) => r.status === "queued") ?? false;
  // Add context and Attach: a New or in-triage item where the viewer may send `/revise` (design 02-attachments).
  const context = detail?.stage === "NEW" ? commands.find((c) => c.name === "revise" && c.allowed) : undefined;
  // Run next: a button beside the "…" menu, or a menu entry when the Add context row already has three actions.
  if (queued && context) menuItems.push({ label: t("commands.runNext"), disabled: !enabled || busy, action: "run-next", item: id, onSelect: () => void post("run-next", "") });
  // The "…" menu: in the Add context row when that row shows (one decision, one action row), else on its own.
  const menu = menuItems.length > 0 ? <span data-item-menu className="flex"><OverflowMenu label={t("commands.more")} items={menuItems} /></span> : null;
  return (
    <div ref={wrap} className="mt-2">
      {reason}
      <QueuedFeedbackList timeline={data?.timeline} />
      {context && (
        <AddContextActions id={id} title={detail?.title ?? id} token={session.data?.csrf_token} off={!enabled || busy}
          error={local.revise && "error" in local.revise ? local.revise.error : null} send={(text) => post("revise", text)}>
          {menu}
        </AddContextActions>
      )}
      {restart && <RestartButton id={id} command={restart} on={enabled} busy={busy} replies={data?.replies ?? []} local={local.restart} send={() => void post("restart", "")} />}
      {/* Only for an open item: a closed one says so in its status line (item-facts.tsx ClosedStatus). */}
      {commands.length === 0 && !queued && !showsMerge(detail?.merge) && detail?.stage !== "CLOSED" && (
        <p data-commands-none className="mt-2 text-sm text-pretty text-text-2">
          {t("commands.none")}
        </p>
      )}
      {!context && (queued || menuItems.length > 0) && (
        <ButtonRow data-item-menu className="mt-2">
          {queued && <RunNextButton id={id} on={enabled} busy={busy} replies={data?.replies ?? []} local={local["run-next"]} send={() => void post("run-next", "")} />}
          {menuItems.length > 0 && <OverflowMenu label={t("commands.more")} items={menuItems} />}
        </ButtonRow>
      )}
      <PendingProposals proposals={data?.proposals ?? []} enabled={enabled} busy={busy} outcomes={(proposal) => commandOutcome([], proposal, local[proposal])} send={post} />
      {open !== null && (
        <CommandDialog
          command={open}
          title={detail?.title ?? id}
          pr={detail?.change_ref ?? null}
          busy={busy || !enabled}
          error={local[open] && "error" in local[open] ? local[open].error : null}
          returnFocusTo={moreButton}
          onSend={(text) => void post(open, text).then((ok) => ok && setOpen(null))}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * Run next (design 05-coordination): a secondary button, beside the "…" menu, on an item with a queued run. It sends
 * `run-next` with no note; "Moving…" until the controller's reply, then "Moved to the front of the queue" (its reply in
 * the thread gives the position) or the refusal. The controller checks the owner and starts nothing that is held.
 */
function RunNextButton({ id, on, busy, replies, local, send }: { id: string; on: boolean; busy: boolean; replies: readonly CommandReply[]; local: LocalSend | undefined; send: () => void }) {
  const reply = commandOutcome(replies, "run-next", local);
  const waiting = busy || awaitsReply(reply);
  const outcome: Outcome = waiting ? null : reply?.tone === "status" && reply.text === t("commands.done") ? { tone: "status", text: t("commands.runNextDone") } : reply;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button variant="secondary" data-action="run-next" data-item={id} disabled={!on || waiting} title={t("commands.runNextTitle")} onClick={send}>
        {waiting ? t("commands.runNextMoving") : t("commands.runNext")}
      </Button>
      <OutcomeText outcome={outcome} />
    </span>
  );
}

/** The dialog for `command` (reject, revise or verdict), the same in Needs you and on the item page. `title` is the item's. */
export function CommandDialog({ command, title, pr, ...props }: Omit<CommandDialogProps, "title"> & { command: FormName; title: string; pr: string | null }) {
  const full = `${commandLabel(command)} ${title}`;
  if (command === "reject") return <RejectDialog title={full} pr={pr} {...props} />;
  if (command === "revise") return <ReviseDialog title={full} {...props} />;
  return <VerdictDialog title={full} {...props} />;
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

/**
 * The over-cap Approve dialog (design 09-dashboard-item-commands, 2026-11-24): the size, the caps in force and the
 * proposed one-time cap, in the words of the controller's refusal (overCapNoteRequired), and the note saying why.
 * Confirm stays off until the note has text; it sends `approve` with the trimmed note, as `factory approve <id> <why>`.
 */
function OverCapApproveDialog({ title, over, busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps & { over: OverCapSizes }) {
  const [note, setNote] = useState("");
  const uid = useId();
  const size = (lines: number, files: number) => t("overCap.lines", { lines, files });
  return (
    <Dialog
      title={title}
      consequence={t("overCap.consequence")}
      confirmLabel={commandLabel("approve")}
      confirmDisabled={busy || note.trim() === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(note.trim())}
      onClose={onClose}
    >
      <KeyValue data-over-cap items={[
        { key: "size", term: t("overCap.size"), value: size(over.sizes.lines, over.sizes.files) },
        { key: "cap", term: t("overCap.cap"), value: size(over.caps.max_diff_lines, over.caps.max_diff_files) },
        { key: "one-time", term: t("overCap.oneTimeCap"), value: size(over.one_time_cap.max_diff_lines, over.one_time_cap.max_diff_files) },
      ]} />
      <Field label={t("overCap.note")} htmlFor={`${uid}-note`}>
        <Textarea id={`${uid}-note`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" />
      </Field>
    </Dialog>
  );
}

/**
 * The Allow and resolve dialog (design 09-dashboard-item-commands, 2026-11-26), laid out as OverCapApproveDialog: the
 * files an out_of_scope resolve failure's reply names, and optional notes for the run. Confirm sends `note` trimmed
 * (the caller puts the `+paths` line first, withPaths); Cancel sends nothing.
 */
export function AllowResolveDialog({ title, paths, note: initial = "", busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps & { paths: readonly string[]; note?: string }) {
  const [note, setNote] = useState(initial);
  const uid = useId();
  return (
    <Dialog
      title={title}
      consequence={t("needs.allowResolveConsequence")}
      confirmLabel={t("needs.actAllowResolve")}
      confirmDisabled={busy}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(note.trim())}
      onClose={onClose}
    >
      <div data-allow-resolve className="text-sm text-text-1">
        <p>{t("needs.allowResolveFiles")}</p>
        <ul className="mt-1 flex flex-col gap-1">
          {paths.map((p) => <li key={p}><code className="font-mono text-xs break-all">{p}</code></li>)}
        </ul>
      </div>
      <Field label={t("needs.allowResolveNotes")} htmlFor={`${uid}-note`}>
        <Textarea id={`${uid}-note`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" />
      </Field>
    </Dialog>
  );
}

/** A Needs-you row's primary button label, in sentence case; `resolve` answers what the item asked. */
const PRIMARY_LABEL: Record<string, MessageKey> = { approve: "needs.actApprove", retry: "needs.actRetry", resolve: "needs.actAnswer" };
/** The label of a primary that allows a permission ask's paths (it sends them as `+paths`). */
const ALLOW_LABEL: Record<string, MessageKey> = { approve: "needs.actAllowApprove", retry: "needs.actAllowRetry", resolve: "needs.actAllowAnswer" };
/** The primary button's label for `c`: what it does, naming the permission it gives when it carries paths. */
export const primaryLabel = (c: ItemCommand): string => {
  const key = allowsResolve(c) ? "needs.actAllowResolve" : (pathsOf(c).length > 0 ? ALLOW_LABEL : PRIMARY_LABEL)[c.name];
  // Revise or Reject after a repeated stop (primaryOf): the command's own name.
  return key ? t(key) : commandLabel(c.name);
};
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
  checking: boolean;
  /** The row's command sender, shared with its Why text. */
  cmd: ReturnType<typeof useCommandSend>;
  /** Overflow entries from the Why text (`Allow x and retry`): each sends `retry` with `note`. */
  allow: readonly { label: string; note: string }[];
  /** False: the row shows the failed sends and a merge error itself (on its own line, design-system C-050), not this cell. */
  inlineErrors?: boolean;
  /** The row's own actions after the item's commands (a task row's Add sub-task, Projects, Delete): one menu per row. */
  extra?: readonly MenuItem[] | undefined;
  /** The menu button's accessible name; default "More actions". */
  label?: string | undefined;
}

/**
 * The texts of a row's failed sends and refused transitions (NeedActions' `cmd.local`). A Merge the merge queue
 * refused as already there is no error: the row says Merging… (useMergeReply).
 */
export const sendErrorTexts = (local: Record<string, LocalSend>): string[] =>
  Object.values(local).flatMap((l) => ("error" in l ? [l.error] : l.refusal && !alreadyQueued(l.refusal) ? [plainRefusal(l.refusal)] : []));

/** The errors of a row's failed sends and refused transitions, one alert each. */
export function SendErrors({ local }: { local: Record<string, LocalSend> }) {
  return sendErrorTexts(local).map((text) => <OutcomeText key={text} outcome={{ tone: "error", text }} />);
}

/**
 * A Merge row's merge state (design 09-dashboard-item-commands): `outcome`, the reply to the Merge this row sent, else
 * why the item's last Merge went back (mergeReturned); `queued` while the server says the merge is under way; and
 * `merging` from the click until the reply and while it is under way, also when the merge queue refused the Merge as
 * already there (alreadyQueued): the merge is running, so that refusal is no outcome. NeedActions and the Needs you row,
 * which shows an error on its own line (C-050), read it from the same item query.
 */
export function useMergeReply(id: string, group: NeedActionsProps["group"], merge: MergeReadiness | undefined, cmd: ReturnType<typeof useCommandSend>) {
  const { busy, local } = cmd;
  // A merge this row sent: its replies from the item's own query (the item page's key), read only until the reply.
  const mergeSent = group === "merge" && !!local.merge && "seq" in local.merge;
  const mergeOutcome = (replies: readonly CommandReply[] = []) => commandOutcome(replies, "merge", local.merge);
  // Read while the row's Merge is sent or under way, and on a ready row for why its last Merge went back (mergeReturned).
  const detail = useQuery({
    queryKey: [API.item(id)],
    queryFn: () => getJson<ItemDetail>(API.item(id)),
    enabled: mergeSent || (group === "merge" && merge?.enabled === true),
    refetchInterval: (q) => (awaitsReply(mergeOutcome(q.state.data?.replies)) || mergeInFlight(q.state.data?.item.merge) || alreadyQueued(mergeReturned(q.state.data)) ? POLL_MS : false),
  });
  const queued = group === "merge" && mergeInFlight(merge);
  const reply = mergeSent ? mergeOutcome(detail.data?.replies) : null;
  const returned = group === "merge" && merge?.enabled ? mergeReturned(detail.data) : null;
  const latest: Outcome = returned && reply?.tone !== "error" ? { tone: "error", text: plainRefusal(returned) } : reply;
  const requeued = group === "merge" && latest?.tone === "error" && alreadyQueued(latest.text);
  const outcome: Outcome = requeued ? null : latest;
  // Merging… from the click until the controller's reply (handled or refused) arrives, then the merge's progress.
  const merging = group === "merge" && (busy || awaitsReply(outcome) || queued || requeued);
  return { outcome, queued, merging };
}

/**
 * A Needs-you row's actions (design §9, issues #453, #513): always one primary button, then the "⋯" menu last. The
 * primary is Merge on a merge row, else the command the state asks for (Approve, Retry or Answer, the first the
 * viewer may send), else "Open" to the item page. The menu holds every other command and the Why text's allow
 * entries; one the viewer may not send stays, disabled, with its reason. Reject, revise, verdict, an over-cap
 * Approve (OverCapApproveDialog) and Allow and resolve (AllowResolveDialog) open a dialog (outside the row, so the row never grows); the others send at once. A send re-reads the list, so the row moves on;
 * a failed send shows its error in the cell (or, with `inlineErrors` false, where the row puts SendErrors), a sent
 * one in a short status message that outlives the row.
 */
export function NeedActions({ id, title, commands, pr, group, merge, checking, cmd, allow, inlineErrors = true, extra = [], label }: NeedActionsProps) {
  const { on, busy, local, send: post } = cmd;
  const [open, setOpen] = useState<FormName | "approve" | "resolve" | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const primary = group === "merge" ? undefined : primaryOf(commands);
  const others = commands.filter((c) => c !== primary);
  const off = !on || busy;
  const { outcome, queued, merging } = useMergeReply(id, group, merge, cmd);
  const send = async (command: string, note: string) => {
    if (!(await post(command, note))) return;
    announceStatus(t("commands.commandSent", { command }));
    setOpen(null);
  };
  const canRetry = commands.some((c) => c.name === "retry" && c.allowed);
  const rest = [
    ...others.map((c) => menuEntry(id, c, off, () => (opensDialog(c) ? setOpen(c.name as FormName | "approve" | "resolve") : void send(c.name, withPaths(c, ""))))),
    ...allow.map((a) => ({ label: a.label, action: "retry", item: id, disabled: off || !canRetry, onSelect: () => void send("retry", a.note) })),
  ];
  // Applied at once (Approve): the row's label, e.g. "Approved", until the list's next read moves the row on.
  const applied = Object.entries(local).flatMap(([k, l]) => (k !== "merge" && "seq" in l && l.label && !l.refusal ? [l.label] : []));
  // The primary command this row sent and the controller has not refused: its button says so and stays off until the
  // list's next read moves the row on, so a click never looks like nothing happened.
  const sentLocal = primary ? local[primary.name] : undefined;
  const sent = sentLocal !== undefined && "seq" in sentLocal && !sentLocal.refusal ? sentLocal : null;
  // Revise or Reject as the main action (a repeated stop, primaryOf), or an over-cap Approve, opens its dialog, as its menu entry does.
  const sendPrimary = () => {
    if (!primary) return;
    if (opensDialog(primary)) setOpen(primary.name as FormName | "approve" | "resolve");
    else void send(primary.name, withPaths(primary, ""));
  };
  const approve = commands.find((c) => c.name === "approve");
  const resolve = commands.find(allowsResolve);
  // A disabled Merge says why in its label ("Merge: 1 conflicting file"), as a disabled command's menu entry does.
  const mergeLabel = checking ? t("needs.checking") : queued ? (merge?.reason ?? t("commands.merging")) : merging ? t("commands.merging")
    : merge && !merge.enabled && merge.reason ? `${t("commands.merge")}: ${merge.reason}` : t("commands.merge");
  const head: MenuItem[] = group === "merge"
    ? [{ label: mergeLabel, action: "merge", item: id, disabled: off || checking || merging || !merge?.enabled, onSelect: () => void send("merge", "") }]
    : primary
      ? [{ label: sent ? (sent.label ?? t("commands.sentWaiting")) : primaryLabel(primary), action: primary.name, item: id, shortcut: PRIMARY_KEY, disabled: off || sent !== null || !primary.allowed, onSelect: sendPrimary }]
      : [];
  // Copy as CLI command: the row's main action (its first command entry), as a terminal runs it; before the row's own.
  const main = [...head, ...rest].find((e) => e.action !== undefined);
  const items = [...head, ...rest, ...(main?.action ? [copyCliEntry(main.action, id)] : []), ...extra];
  return (
    <span ref={wrap} data-need-commands className="inline-flex flex-wrap items-center justify-end gap-2">
      {/* Every action is in the menu (owner feedback 2026-11-20); this hidden button only carries the row's "p" shortcut. */}
      {primary && group !== "merge" && (
        <Button hidden data-shortcut={PRIMARY_KEY} data-action={primary.name} data-item={id} disabled={off || sent !== null || !primary.allowed} onClick={sendPrimary} />
      )}
      {group === "merge" && merging && !queued && <OutcomeText outcome={{ tone: "status", text: t("commands.merging") }} />}
      {/* With inlineErrors false a merge error is the row's, on its own line (C-050): never in this cell. */}
      {group === "merge" && !awaitsReply(outcome) && !queued && (inlineErrors || outcome?.tone !== "error") && <OutcomeText outcome={outcome} />}
      <OverflowMenu label={label ?? t("commands.more")} items={items.length > 0 ? items : [{ label: t("needs.noMore"), disabled: true, onSelect: () => undefined }]} />
      {/* The menu closes on a send, so the row itself says what happened: the applied label, else "Sent, waiting…". */}
      {applied.map((text) => (
        <OutcomeText key={text} outcome={{ tone: "status", text }} />
      ))}
      {sent !== null && !sent.label && <OutcomeText outcome={{ tone: "status", text: t("commands.sentWaiting") }} />}
      {inlineErrors && <SendErrors local={local} />}
      {open === "approve" && approve?.over_cap && (
        <OverCapApproveDialog
          title={`${commandLabel("approve")} ${title}`}
          over={approve.over_cap}
          busy={off}
          error={local.approve && "error" in local.approve ? local.approve.error : null}
          returnFocusTo={moreButton}
          onSend={(note) => void send("approve", withPaths(approve, note))}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "resolve" && resolve && (
        <AllowResolveDialog
          title={`${t("needs.actAllowResolve")} ${title}`}
          paths={pathsOf(resolve)}
          busy={off}
          error={local.resolve && "error" in local.resolve ? local.resolve.error : null}
          returnFocusTo={moreButton}
          onSend={(note) => void send("resolve", withPaths(resolve, note))}
          onClose={() => setOpen(null)}
        />
      )}
      {open !== null && open !== "approve" && open !== "resolve" && (
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
