import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type CommandReply, type ItemCommand, type ItemDetail, type MergeReadiness, type Session, plainRefusal, postCommand, showsMerge, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Section } from "../components/ui/parts.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { PAGE_COMMANDS_PATH } from "../pages.js";
import {
  ApproveConfirm, type DecisionChoice, DecisionsPanel, InShort, RejectForm, ReviseForm, approveNote, approvePhase, chosenAnswers, initialChoices, textButton,
} from "./item-decisions.js";

// The item page's command buttons (design §9, issue #228): one button per entry of the item API's `commands`,
// in its order: the commands that apply now. One the viewer's grants do not allow (`allowed` false, issue #453) is
// disabled with the controller's reason beside it, in plain text; every refusal shows without backticks. Reject and revise open their own forms (issue #527): reject asks why and confirms what closes,
// revise takes a comment per spec section. Verdict (issue #523) is three buttons, Accept, Changes and Reject, with a
// severity choice; a click sends `<kind> <severity> <reason>` (verdictNote), the reason the note box's text. Every
// other command carries the note box's text when it has any (tokens for budget, the approve note). A send
// is POST /api/v1/items/:id/commands with the token from GET /api/v1/session; the controller applies it on its
// next tick, and the item's `replies` say how that went. An item waiting for its merge also gets the Merge button
// (MergeButton, also in Needs you), enabled or disabled with its reason as the item API's `merge` says.
// A waiting spec (issue #526) shows its In short above Commands and its decisions as questions above the note box;
// approve in an approve phase (the spec gate, the floor block, the Rule of Two) goes through a confirm step first;
// approve sends the answers as `N: <answer>` lines.

/** Commands sent from their own form, not with the note box. */
const FORMS = ["reject", "revise"];

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

/** The text next to a command's button, or null for none. */
export type Outcome = { tone: "error" | "status"; text: string } | null;

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

function OutcomeText({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return (
    <span
      role={outcome.tone === "error" ? "alert" : "status"}
      data-outcome
      className={cn("text-xs text-pretty break-words", outcome.tone === "error" ? "text-red-700 dark:text-red-300" : "text-zinc-600 dark:text-zinc-400")}
    >
      {outcome.text}
    </span>
  );
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
  const send = async (command: string, note: string): Promise<boolean> => {
    if (!token) return false;
    setBusy(true);
    try {
      const r = await postCommand(token, id, command, note);
      setLocal((m) => ({ ...m, [command]: r.ok ? { seq: r.seq } : { error: r.error } }));
      if (r.ok) await Promise.all([client.invalidateQueries({ queryKey: [API.item(id)] }), client.invalidateQueries({ queryKey: [API.items] })]);
      return r.ok;
    } catch (err) {
      setLocal((m) => ({ ...m, [command]: { error: err instanceof Error ? err.message : String(err) } }));
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
  // Nothing the page can send now (a running item): say so once, with no note box or buttons that could only be refused.
  if (commands.length === 0 && !showMerge) {
    return (
      <>
        <InShort spec={data?.spec} />
        <Section title="Commands">
          <p data-commands-none className="text-sm text-pretty text-zinc-600 dark:text-zinc-400">
            No command applies now; the factory continues on its own. Commands show here when the item waits for you.
          </p>
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
          <p role="status" data-commands-off className="mb-2 text-sm text-pretty text-zinc-600 dark:text-zinc-400">
            Commands are off: this server is not on loopback, so it needs ui.user_id.{" "}
            <Link href={PAGE_COMMANDS_PATH} className={LINK_CLASS}>
              Settings
            </Link>{" "}
            says what to set.
          </p>
        )}
        {enabled && session.data?.actor && (
          <p data-commands-actor className="mb-2 text-xs text-pretty text-zinc-600 dark:text-zinc-400">
            Acting as {session.data.actor} (from {session.data.actor_source === "config" ? "config" : "environment"})
          </p>
        )}
        <DecisionsPanel decisions={decisions} choices={choices} onChange={(i, c) => setPicked(choices.map((x, j) => (j === i ? c : x)))} />
        {usesNote && (
          <textarea
            aria-label="Note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tokens for budget, a verdict's reason, or a note"
            className={cn(
              "mb-2 w-full max-w-xl rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600",
            )}
          />
        )}
        <ul className="space-y-1.5">
          {commands.map((c) => {
            const disabled = !enabled || busy || !c.allowed;
            const outcome = c.allowed ? commandOutcome(replies, c.name, local[c.name]) : notAllowed(c);
            const hasForm = FORMS.includes(c.name);
            const confirms = c.name === "approve" && phase !== null;
            const close = () => setOpen(null);
            if (c.name === "verdict") {
              return (
                <li key={c.name} data-command={c.name} className="flex flex-wrap items-center gap-2">
                  <VerdictButtons
                    title={`${c.usage}: ${c.description}`}
                    disabled={disabled}
                    reason={note}
                    onSend={(text) => void post("verdict", text).then((ok) => ok && setNote(""))}
                  />
                  <OutcomeText outcome={outcome} />
                </li>
              );
            }
            return (
              <li key={c.name} data-command={c.name} className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  className={textButton}
                  disabled={disabled || confirming === c.name}
                  title={`${c.usage}: ${c.description}`}
                  {...(hasForm ? { "aria-expanded": open === c.name } : {})}
                  onClick={() => (hasForm ? setOpen(open === c.name ? null : c.name) : confirms ? setConfirming(c.name) : void send(c.name))}
                >
                  {c.name}
                </Button>
                {confirming === c.name && phase !== null && (
                  <>
                    <ApproveConfirm phase={phase} answers={answers} note={note} />
                    <Button variant="outline" className={textButton} disabled={disabled} onClick={() => void send(c.name)}>
                      Confirm {c.name}
                    </Button>
                    <Button variant="outline" className={textButton} onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </>
                )}
                <OutcomeText outcome={outcome} />
                {open === c.name && c.name === "reject" && (
                  <RejectForm pr={detail?.change_ref ?? null} disabled={disabled} onSend={(t) => void send("reject", t)} onCancel={close} />
                )}
                {open === c.name && c.name === "revise" && <ReviseForm disabled={disabled} onSend={(t) => void send("revise", t)} onCancel={close} />}
              </li>
            );
          })}
          {showMerge && (
            <li data-command="merge" className="flex flex-wrap items-center gap-2">
              <MergeButton id={id} source={detail?.source.type} merge={merge} replies={replies} />
            </li>
          )}
        </ul>
      </Section>
    </>
  );
}

/**
 * The verdict buttons (issue #523): a severity choice, then Accept, Changes and Reject, each sending verdictNote with
 * `reason` (the note box's text). Changes and reject need a reason, so they wait for one.
 */
function VerdictButtons({ title, disabled, reason, onSend }: { title: string; disabled: boolean; reason: string; onSend: (note: string) => void }) {
  const [severity, setSeverity] = useState<VerdictSeverityChoice>("none");
  return (
    <span data-verdict className="inline-flex flex-wrap items-center gap-2">
      <select
        aria-label="Verdict severity"
        value={severity}
        disabled={disabled}
        onChange={(e) => setSeverity(e.target.value as VerdictSeverityChoice)}
        className="h-8 rounded-md border border-zinc-300 bg-white px-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {SEVERITIES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {VERDICTS.map(([kind, label]) => (
        <Button
          key={kind}
          variant="outline"
          className={textButton}
          data-verdict-kind={kind}
          disabled={disabled || (kind !== "accept" && reason.trim() === "")}
          title={kind === "accept" ? title : `${title} (write the reason in the note box first)`}
          onClick={() => onSend(verdictNote(kind, severity, reason))}
        >
          {label}
        </Button>
      ))}
    </span>
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
        variant="outline"
        className={textButton}
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
 * A Needs-you row's command buttons (design §9, issue #453): one per entry of the row's `commands` (the item API's,
 * each allowed or not for the viewer). Approve, retry and resolve send at once; reject and revise open the item
 * page's forms first, and reject confirms what it closes. One the viewer may not send is disabled with its reason
 * beside it. A send re-reads the list, so the row moves on; a failed send shows its error.
 */
export function NeedCommands({ id, commands, pr }: { id: string; commands: readonly ItemCommand[]; pr: string | null }) {
  const { on, busy, local, send: post } = useCommandSend(id);
  const [open, setOpen] = useState<string | null>(null);
  const send = async (command: string, note: string) => {
    if (await post(command, note)) setOpen(null);
  };
  const close = () => setOpen(null);
  return (
    <span data-need-commands className="inline-flex flex-wrap items-center gap-2">
      {commands.map((c) => {
        const disabled = !on || busy || !c.allowed;
        const hasForm = FORMS.includes(c.name);
        return (
          <span key={c.name} data-command={c.name} className="inline-flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className={textButton}
              disabled={disabled}
              title={`${c.usage}: ${c.description}`}
              {...(hasForm ? { "aria-expanded": open === c.name } : {})}
              onClick={() => (hasForm ? setOpen(open === c.name ? null : c.name) : void send(c.name, ""))}
            >
              {c.name}
            </Button>
            <OutcomeText outcome={c.allowed ? commandOutcome([], c.name, local[c.name]) : notAllowed(c)} />
            {open === c.name && c.name === "reject" && <RejectForm pr={pr} disabled={disabled} onSend={(t) => void send("reject", t)} onCancel={close} />}
            {open === c.name && c.name === "revise" && <ReviseForm disabled={disabled} onSend={(t) => void send("revise", t)} onCancel={close} />}
          </span>
        );
      })}
    </span>
  );
}
