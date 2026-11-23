import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { API, type AppliedRule, type RuleRow, type RuleVerdict, postRuleEdit, postRuleVerdict, useRuleEntry } from "../api.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { EntryDetail } from "./rules-detail.js";
import { CONSEQUENCE, VERDICTS, isClass, ruleName } from "./rules-shared.js";

// The Rules page's verdict dialogs: Promote, Hold and Reject for a waiting entry (VerdictDialog, with the entry's full
// title and detail above a required reason; Promote of a class also asks for the rule's wording, default and
// exception, Promote of a proposal shows its Now and Proposed lines, or its prose change, and is off until they are
// read), Retire of an
// applied class (RetireDialog), and Edit of an applied class (EditDialog: the same three fields as Promote, no reason,
// no verdict). useSend posts one write; a refusal or a failed apply stays in the dialog.

/** One of the rule's text fields in the promote dialog: a labelled textarea of up to 2000 characters. */
function RuleText({ id, label, help, value, onChange }: { id: string; label: string; help?: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id} help={help}>
      <Textarea id={id} aria-label={label} rows={2} className="min-h-12" value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/**
 * Sends one Rules write from a dialog: on success it says `done`, reloads the rules and closes; a refusal stays as
 * `error`; `busy` while it is on its way.
 */
export function useSend(onClose: () => void) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (post: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(done);
      await client.invalidateQueries({ queryKey: [API.rules] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, send };
}

/** Sends one verdict from a dialog (useSend), saying "<label> sent for <title>." on success. */
function useSendVerdict(token: string, onClose: () => void) {
  const { busy, error, send } = useSend(onClose);
  return { busy, error, send: (body: Parameters<typeof postRuleVerdict>[1], label: string, title: string) => send(() => postRuleVerdict(token, body), t("rules.sent", { label, title })) };
}

/** The required reason, "Why?", in a verdict's dialog. */
function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={t("rules.reason")} htmlFor={`${id}-reason`}>
      <Textarea id={`${id}-reason`} rows={2} className="min-h-12" value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/**
 * The verdict dialog: the entry's full title and its detail above the fields, then a reason, and for promote of a class the rule's wording (prefilled with its title) and its
 * default and exception (prefilled from its draft). Promote of a proposal shows its Now and Proposed lines (or its
 * prose change) in the detail and is off until they are read; a prose change is recorded as applied to its target and
 * the server creates a task to build it, which the card then links to.
 */
export function VerdictDialog({ entry, applied, verdict, token, returnFocusTo, onClose }: { entry: RuleRow; applied: AppliedRule[]; verdict: RuleVerdict; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.title);
  const [dflt, setDefault] = useState(entry.draft?.default ?? "");
  const [exception, setException] = useState(entry.draft?.exception ?? "");
  const { busy, error, send } = useSendVerdict(token, onClose);
  const promote = verdict === "promote" && isClass(entry.id);
  const applies = verdict === "promote" && !isClass(entry.id);
  const rule = { text: text.trim(), default: dflt.trim(), exception: exception.trim() };
  // The same read as the detail above: a proposal with Now or Proposed lines applies them; one with neither (a prose
  // change) records the verdict as applied to its target. Send waits for the read, so the consequence shown is the one sent.
  const lines = useRuleEntry(entry.id, applies);
  const prose = applies && !lines.isPending && lines.data?.detail?.current === undefined && lines.data?.detail?.proposed === undefined;
  const label = t(VERDICTS.find((v) => v.verdict === verdict)!.label);
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, title: entry.title })}
      consequence={t(promote ? "rules.consequencePromoteClass" : prose ? "rules.consequencePromoteBuild" : CONSEQUENCE[verdict])}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === "" || (promote && Object.values(rule).includes("")) || (applies && lines.isPending)}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send({ id: entry.id, verdict, reason: reason.trim(), ...(promote ? rule : {}) }, label, entry.title)}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <EntryDetail entry={entry} applied={applied} />
      {promote && (
        <>
          <RuleText id={`${entry.id}-wording`} label={t("rules.wording")} help={t("rules.wordingHelp")} value={text} onChange={setText} />
          <RuleText id={`${entry.id}-default`} label={t("rules.default")} help={t("rules.draftHelp")} value={dflt} onChange={setDefault} />
          <RuleText id={`${entry.id}-exception`} label={t("rules.exception")} value={exception} onChange={setException} />
        </>
      )}
      <ReasonField id={entry.id} value={reason} onChange={setReason} />
    </Dialog>
  );
}

/** Retire of an applied class: the required reason, then the verdict (the server removes the rule's block first). */
export function RetireDialog({ id, name, token, returnFocusTo, onClose }: { id: string; name: string; token: string; returnFocusTo?: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, send } = useSendVerdict(token, onClose);
  const label = t("rules.retire");
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, title: name })}
      consequence={t(CONSEQUENCE.retire)}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === ""}
      danger
      error={error}
      onConfirm={() => void send({ id, verdict: "retire", reason: reason.trim() }, label, name)}
      onClose={onClose}
      {...(returnFocusTo ? { returnFocusTo } : {})}
    >
      <ReasonField id={id} value={reason} onChange={setReason} />
    </Dialog>
  );
}

/**
 * Edit of an applied class: the rule's wording (prefilled with its name), default and exception (prefilled with its
 * own), each required and up to 2000 characters, as in Promote. It asks for no reason and sends no verdict: the server
 * rewrites the rule's block in your rules and updates your agents' instructions.
 */
export function EditDialog({ rule, id, token, returnFocusTo, onClose }: { rule: AppliedRule; id: string; token: string; returnFocusTo?: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [text, setText] = useState(rule.name ?? "");
  const [dflt, setDefault] = useState(rule.default ?? "");
  const [exception, setException] = useState(rule.exceptions ?? "");
  const { busy, error, send } = useSend(onClose);
  const name = ruleName(rule);
  const body = { id, text: text.trim(), default: dflt.trim(), exception: exception.trim() };
  return (
    <Dialog
      title={t("rules.dialogTitle", { label: t("rules.edit"), title: name })}
      consequence={t("rules.consequenceEdit")}
      confirmLabel={t("rules.save")}
      confirmDisabled={busy || [body.text, body.default, body.exception].includes("")}
      error={error}
      onConfirm={() => void send(() => postRuleEdit(token, body), t("rules.saved", { title: name }))}
      onClose={onClose}
      {...(returnFocusTo ? { returnFocusTo } : {})}
    >
      <RuleText id={`${id}-edit-wording`} label={t("rules.wording")} help={t("rules.wordingHelp")} value={text} onChange={setText} />
      <RuleText id={`${id}-edit-default`} label={t("rules.default")} value={dflt} onChange={setDefault} />
      <RuleText id={`${id}-edit-exception`} label={t("rules.exception")} value={exception} onChange={setException} />
    </Dialog>
  );
}
