import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import {
  API, type CommandReply, type ItemCommand, type ItemDetail, type ItemRow, type MergeReadiness, POLL_MS, type RequestState, type Session, getJson,
  mergeInFlight, mergeReturned, plainRefusal, postCommand, showsMerge, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Radio } from "../components/ui/radio.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { type Outcome, OutcomeText, PendingProposals } from "./command-box.js";
import { RejectDialog, ReviseDialog, commandLabel, type CommandDialogProps } from "./item-decisions.js";

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
 * What this page did with a command since it loaded: the request it sent (with the row's `label` when the server
 * applied it at once, or the `refusal` it answered with), or the error its send got.
 */
export type LocalSend = { seq: number; label?: string | null; refusal?: string | null } | { error: string };


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
  if (local?.refusal) return { tone: "error", text: plainRefusal(local.refusal) };
  const latest = replies.filter((r) => r.command === command).reduce<CommandReply | null>((a, r) => (a && a.seq > r.seq ? a : r), null);
  // Applied at once: its label until a newer request's reply, or a refusal of this one, arrives.
  if (local?.label && (!latest || latest.seq <= local.seq) && !latest?.refusal) return { tone: "status", text: local.label };
  if (local && (!latest || latest.seq < local.seq)) return { tone: "status", text: t("commands.sent") };
  if (!latest) return null;
  if (latest.refusal) return { tone: "error", text: plainRefusal(latest.refusal) };
  return { tone: "status", text: latest.handled_at === null ? t("commands.sent") : t("commands.done") };
}

/** Whether `outcome` is the "sent" state: a request queued, its reply not here yet. */
export const awaitsReply = (outcome: Outcome): boolean => outcome?.tone === "status" && outcome.text === t("commands.sent");

/** The fields of the item's row and page that a request's state changes; a Merge under way also turns its button. */
function statePatch(s: RequestState): Partial<ItemRow> {
  const fields = { stage: s.stage, blocked_on: s.blocked_on, blocked_reason: s.blocked_reason };
  const merge = { enabled: false, reason: s.label };
  return mergeInFlight(merge) ? { ...fields, merge } : fields;
}

/**
 * Sending app commands for item `id`: `send` posts one with the session's token, keeps what this page did with each
 * command (`local`), merges the item's new state from the response (Approve, Merge) into the item and list queries at
 * once, then re-reads them, so the controller's reply shows. `on`: commands are on for this page's session.
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
      setLocal((m) => ({ ...m, [key]: r.ok ? { seq: r.seq, label: r.state?.label ?? null, refusal: r.refusal ?? null } : { error: r.error } }));
      if (r.ok && r.state) {
        const patch = statePatch(r.state);
        client.setQueryData<ItemDetail>([API.item(id)], (old) => (old ? { ...old, item: { ...old.item, ...patch } } : old));
        client.setQueriesData<{ items?: ItemRow[] }>({ predicate: (q) => String(q.queryKey[0]).startsWith(API.items) }, (old) =>
          Array.isArray(old?.items) ? { ...old, items: old.items.map((row) => (row.id === id ? { ...row, ...patch } : row)) } : old);
      }
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
export const primaryLabel = (c: ItemCommand): string => {
  const key = (pathsOf(c).length > 0 ? ALLOW_LABEL : PRIMARY_LABEL)[c.name];
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
  /** False: the row shows the failed sends itself (SendErrors on its own line, design-system C-050), not this cell. */
  inlineErrors?: boolean;
  /** The row's own actions after the item's commands (a task row's Add sub-task, Projects, Delete): one menu per row. */
  extra?: readonly MenuItem[] | undefined;
  /** The menu button's accessible name; default "More actions". */
  label?: string | undefined;
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
export function NeedActions({ id, title, commands, pr, group, merge, checking, cmd, allow, inlineErrors = true, extra = [], label }: NeedActionsProps) {
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
  const rest = [
    ...others.map((c) => menuEntry(c, off, () => (DIALOGS.includes(c.name) ? setOpen(c.name as FormName) : void send(c.name, withPaths(c, ""))))),
    ...allow.map((a) => ({ label: a.label, disabled: off || !canRetry, onSelect: () => void send("retry", a.note) })),
  ];
  // Applied at once (Approve): the row's label, e.g. "Approved", until the list's next read moves the row on.
  const applied = Object.entries(local).flatMap(([k, l]) => (k !== "merge" && "seq" in l && l.label && !l.refusal ? [l.label] : []));
  // The primary command this row sent and the controller has not refused: its button says so and stays off until the
  // list's next read moves the row on, so a click never looks like nothing happened.
  const sentLocal = primary ? local[primary.name] : undefined;
  const sent = sentLocal !== undefined && "seq" in sentLocal && !sentLocal.refusal ? sentLocal : null;
  // Revise or Reject as the main action (a repeated stop, primaryOf) opens its dialog, as its menu entry does.
  const sendPrimary = () => {
    if (!primary) return;
    if (DIALOGS.includes(primary.name)) setOpen(primary.name as FormName);
    else void send(primary.name, withPaths(primary, ""));
  };
  // A disabled Merge says why in its label ("Merge: 1 conflicting file"), as a disabled command's menu entry does.
  const mergeLabel = checking ? t("needs.checking") : queued ? (merge?.reason ?? t("commands.merging")) : merging ? t("commands.merging")
    : merge && !merge.enabled && merge.reason ? `${t("commands.merge")}: ${merge.reason}` : t("commands.merge");
  const head: MenuItem[] = group === "merge"
    ? [{ label: mergeLabel, action: "merge", disabled: off || checking || merging || !merge?.enabled, onSelect: () => void send("merge", "") }]
    : primary
      ? [{ label: sent ? (sent.label ?? t("commands.sentWaiting")) : primaryLabel(primary), action: primary.name, disabled: off || sent !== null || !primary.allowed, onSelect: sendPrimary }]
      : [];
  const items = [...head, ...rest, ...extra];
  return (
    <span ref={wrap} data-need-commands className="inline-flex flex-wrap items-center justify-end gap-2">
      {/* Every action is in the menu (owner feedback 2026-11-20); this hidden button only carries the row's "p" shortcut. */}
      {primary && group !== "merge" && (
        <Button hidden data-shortcut={PRIMARY_KEY} data-command={primary.name} disabled={off || sent !== null || !primary.allowed} onClick={sendPrimary} />
      )}
      {group === "merge" && merging && !queued && <OutcomeText outcome={{ tone: "status", text: t("commands.merging") }} />}
      {group === "merge" && !awaitsReply(outcome) && !queued && <OutcomeText outcome={outcome} />}
      <OverflowMenu label={label ?? t("commands.more")} items={items.length > 0 ? items : [{ label: t("needs.noMore"), disabled: true, onSelect: () => undefined }]} />
      {/* The menu closes on a send, so the row itself says what happened: the applied label, else "Sent, waiting…". */}
      {applied.map((text) => (
        <OutcomeText key={text} outcome={{ tone: "status", text }} />
      ))}
      {sent !== null && !sent.label && <OutcomeText outcome={{ tone: "status", text: t("commands.sentWaiting") }} />}
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
