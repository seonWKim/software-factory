import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import {
  API, type CommandReply, type ItemCommand, type ItemDetail, type MergeReadiness, POLL_MS, getJson,
  mergeInFlight, mergeReturned, plainRefusal, showsMerge, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { FOCUS } from "../components/ui/control.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Radio } from "../components/ui/radio.js";
import { type MenuItem, OverflowMenu, Tooltip } from "../components/ui/menu.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { type Outcome, OutcomeText, PendingProposals } from "./command-box.js";
import { type LocalSend, awaitsReply, commandOutcome, useCommandSend } from "./command-send.js";
import { RejectDialog, ReviseDialog, commandLabel, type CommandDialogProps } from "./item-decisions.js";
import { RestartButton } from "./merge-button.js";

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
// app button (RestartButton), which sends `restart` with no note, as `factory restart` does.

/** Every command that opens a dialog from a button: reject and revise (their forms), and verdict (its Accept, Changes or Reject choice). */
export const DIALOGS = ["reject", "revise", "verdict"];
/** The commands the item's "…" menu holds (on the DecisionCard too): they are rare, so they are no buttons in its row. */
export const MENU = ["reject", "verdict"];
export type FormName = "reject" | "revise" | "verdict";
/**
 * The commands a decision's one primary button can be, in the order the state asks for them: Retry last, so a block
 * reason that accepts Approve or Answer never shows Retry first.
 */
const PRIMARY = ["approve", "resolve", "retry"];

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

/**
 * Command `c` as an entry of a "…" menu: its label (with the controller's reason when the viewer may not send it, then
 * disabled), its `data-action`, and `onSelect`. `off`: commands are off or a send is under way.
 */
export function menuEntry(c: ItemCommand, off: boolean, onSelect: () => void): MenuItem {
  return {
    label: c.allowed ? commandLabel(c.name) : `${commandLabel(c.name)}: ${plainRefusal(c.reason ?? "not allowed")}`,
    disabled: off || !c.allowed,
    action: c.name,
    onSelect,
  };
}

/** A command row with a permission ask's paths (the item API's `paths`, src/ui/commands.ts ItemCommandRow). */
type AcceptedCommand = ItemCommand & { paths?: readonly string[] };
/** The paths a permission ask names on `c`, which its button sends as `+paths`; none for any other command. */
export const pathsOf = (c: ItemCommand): readonly string[] => (c as AcceptedCommand).paths ?? [];

/** The note `c` sends: its permission ask's `+paths <path>...` line first (design §4, issue #280), then `note`. */
export function withPaths(c: ItemCommand, note: string): string {
  const paths = pathsOf(c);
  return paths.length === 0 ? note : [`+paths ${paths.join(" ")}`, note.trim()].filter((l) => l !== "").join("\n");
}

/**
 * The command the state asks for, of those the viewer may send: the one that allows a permission ask's paths, else
 * the first of approve, resolve and retry (PRIMARY order, not the API's), so Retry only when neither other applies.
 */
export function primaryOf(commands: readonly ItemCommand[]): ItemCommand | undefined {
  const rank = (c: ItemCommand) => PRIMARY.indexOf(c.name) - (pathsOf(c).length > 0 ? PRIMARY.length : 0);
  return commands.filter((c) => PRIMARY.includes(c.name) && c.allowed).sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The item's commands while it waits for nobody (running, or the factory's turn; the DecisionCard holds them while
 * the owner is next): its reason, the feedback queued for it, a line when no command applies, and the "…" menu with
 * Reject and Verdict, so any open item can still be rejected; then its pending proposals.
 */
export function ItemCommands({ id, commands, reason = null }: { id: string; commands: readonly ItemCommand[]; reason?: ReactNode }) {
  const { on: enabled, busy, local, send: post } = useCommandSend(id);
  const [open, setOpen] = useState<FormName | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // The OverflowMenu owns its button, so the dialogs hand focus back to it by looking it up when they close.
  const moreButton = { get current() { return wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]") ?? null; } } as RefObject<HTMLElement | null>;
  const data = useApi<ItemDetail>(API.item(id)).data;
  const detail = data?.item;
  // Verdict and Reject: in the "…" menu, one the viewer may not send disabled with its reason.
  const menuItems = commands.filter((c) => MENU.includes(c.name)).map((c) => menuEntry(c, !enabled || busy, () => setOpen(c.name as FormName)));
  const restart = commands.find((c) => c.name === "restart");
  return (
    <div ref={wrap} className="mt-2">
      {reason}
      <QueuedFeedbackList timeline={data?.timeline} />
      {restart && <RestartButton command={restart} on={enabled} busy={busy} replies={data?.replies ?? []} local={local.restart} send={() => void post("restart", "")} />}
      {commands.length === 0 && !showsMerge(detail?.merge) && (
        <p data-commands-none className="mt-2 text-sm text-pretty text-text-2">
          {t("commands.none")}
        </p>
      )}
      {menuItems.length > 0 && <div data-item-menu className="mt-2 flex"><OverflowMenu label={t("commands.more")} items={menuItems} /></div>}
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

/** A Needs-you row's primary button label, in sentence case; `resolve` answers what the item asked. */
const PRIMARY_LABEL: Record<string, MessageKey> = { approve: "needs.actApprove", retry: "needs.actRetry", resolve: "needs.actAnswer" };
/** The label of a primary that allows a permission ask's paths (it sends them as `+paths`). */
const ALLOW_LABEL: Record<string, MessageKey> = { approve: "needs.actAllowApprove", retry: "needs.actAllowRetry", resolve: "needs.actAllowAnswer" };
/** The primary button's label for `c`: what it does, naming the permission it gives when it carries paths. */
export const primaryLabel = (c: ItemCommand): string => t((pathsOf(c).length > 0 ? ALLOW_LABEL : PRIMARY_LABEL)[c.name]!);
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

/** The errors of a row's failed sends and refused transitions, one alert each (NeedActions' `cmd.local`). */
export function SendErrors({ local }: { local: Record<string, LocalSend> }) {
  const failed = Object.values(local).flatMap((l) => ("error" in l ? [l.error] : l.refusal ? [plainRefusal(l.refusal)] : []));
  return failed.map((text) => <OutcomeText key={text} outcome={{ tone: "error", text }} />);
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
  // Read while the row's Merge is sent or under way, and on a ready row for why its last Merge went back (mergeReturned).
  const detail = useQuery({
    queryKey: [API.item(id)],
    queryFn: () => getJson<ItemDetail>(API.item(id)),
    enabled: mergeSent || (group === "merge" && merge?.enabled === true),
    refetchInterval: (q) => (awaitsReply(mergeOutcome(q.state.data?.replies)) || mergeInFlight(q.state.data?.item.merge) ? POLL_MS : false),
  });
  const queued = group === "merge" && mergeInFlight(merge);
  const reply = mergeSent ? mergeOutcome(detail.data?.replies) : null;
  const returned = group === "merge" && merge?.enabled ? mergeReturned(detail.data) : null;
  const outcome: Outcome = returned && reply?.tone !== "error" ? { tone: "error", text: plainRefusal(returned) } : reply;
  // Merging… from the click until the controller's reply (handled or refused) arrives, then the merge's progress.
  const merging = group === "merge" && (busy || awaitsReply(outcome) || queued);
  const send = async (command: string, note: string) => {
    if (!(await post(command, note))) return;
    announceStatus(t("commands.commandSent", { command }));
    setOpen(null);
  };
  const canRetry = commands.some((c) => c.name === "retry" && c.allowed);
  const items = [
    ...others.map((c) => menuEntry(c, off, () => (DIALOGS.includes(c.name) ? setOpen(c.name as FormName) : void send(c.name, withPaths(c, ""))))),
    ...allow.map((a) => ({ label: a.label, disabled: off || !canRetry, onSelect: () => void send("retry", a.note) })),
  ];
  // Applied at once (Approve): the row's label, e.g. "Approved", until the list's next read moves the row on.
  const applied = Object.entries(local).flatMap(([k, l]) => (k !== "merge" && "seq" in l && l.label && !l.refusal ? [l.label] : []));
  // The primary command this row sent and the controller has not refused: its button says so and stays off until the
  // list's next read moves the row on, so a click never looks like nothing happened.
  const sentLocal = primary ? local[primary.name] : undefined;
  const sent = sentLocal !== undefined && "seq" in sentLocal && !sentLocal.refusal ? sentLocal : null;
  return (
    <span ref={wrap} data-need-commands className="inline-flex flex-wrap items-center justify-end gap-2">
      {group === "merge" ? (
        <span data-command="merge" className="inline-flex items-center gap-2">
          <Tooltip text={merge && !merge.enabled && merge.reason ? merge.reason : source === "local" ? t("commands.mergeLocal") : t("commands.mergePr")}>
            <Button variant="secondary" data-action="merge" disabled={off || checking || merging || !merge?.enabled} onClick={() => void send("merge", "")}>
              {checking ? t("needs.checking") : queued ? merge?.reason : merging ? t("commands.merging") : t("commands.merge")}
            </Button>
          </Tooltip>
          {!awaitsReply(outcome) && !queued && <OutcomeText outcome={outcome} />}
        </span>
      ) : primary ? (
        <span data-command={primary.name} className="inline-flex">
          <Tooltip text={pathsOf(primary).length > 0
            ? t("needs.allowPaths", { paths: pathsOf(primary).join(", "), key: PRIMARY_KEY })
            : t("needs.withKey", { label: primaryLabel(primary), key: PRIMARY_KEY })}>
            <Button variant="secondary" data-shortcut={PRIMARY_KEY} data-action={primary.name} data-sent={sent ? "" : undefined} disabled={off || sent !== null} onClick={() => void send(primary.name, withPaths(primary, ""))}>
              {sent ? (sent.label ?? t("commands.sentWaiting")) : primaryLabel(primary)}
            </Button>
          </Tooltip>
        </span>
      ) : (
        <Link href={itemPath(id)} data-command="open" data-action="open" className={cn("inline-flex min-h-8 items-center rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-text-1 hover:bg-surface-2", FOCUS)}>
          {t("needs.actOpen")}
        </Link>
      )}
      <OverflowMenu label={t("commands.more")} items={items.length > 0 ? items : [{ label: t("needs.noMore"), disabled: true, onSelect: () => undefined }]} />
      {applied.filter((text) => text !== sent?.label).map((text) => (
        <OutcomeText key={text} outcome={{ tone: "status", text }} />
      ))}
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
