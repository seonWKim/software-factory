import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { API, type AppliedRule, type RuleRow, type RuleVerdict, postRuleVerdict, useRuleEntry } from "../api.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Notice } from "../components/ui/notice.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { EntryDetail } from "./rules-detail.js";
import { CONSEQUENCE, VERDICTS, isClass } from "./rules-shared.js";

// The Rules page's verdict dialogs: Promote, Hold and Reject for a waiting entry (VerdictDialog, with the entry's full
// title and detail above a required reason; Promote of a class also asks for the rule's wording, default and
// exception, Promote of a proposal shows its Now and Proposed lines and is off until both are read) and Retire of an
// applied class (RetireDialog). useSendVerdict posts the verdict; a refusal or a failed apply stays in the dialog.

/** One of the rule's text fields in the promote dialog: a labelled textarea of up to 2000 characters. */
function RuleText({ id, label, help, value, onChange }: { id: string; label: string; help?: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id} help={help}>
      <Textarea id={id} aria-label={label} rows={2} className="min-h-12" value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Sends one verdict from a dialog: on success it says so, reloads the rules and closes; a refusal stays as `error`. */
function useSendVerdict(token: string, onClose: () => void) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: Parameters<typeof postRuleVerdict>[1], label: string, title: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postRuleVerdict(token, body);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("rules.sent", { label, title }));
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
 * default and exception (prefilled from its draft). Promote of a proposal shows its Now and Proposed lines in the
 * detail and is off until both are read.
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
  // The same read as the detail above: a proposal applies only with both its Now and Proposed lines.
  const lines = useRuleEntry(entry.id, applies);
  const noLines = applies && (lines.data?.detail?.current === undefined || lines.data.detail.proposed === undefined);
  const label = t(VERDICTS.find((v) => v.verdict === verdict)!.label);
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, title: entry.title })}
      consequence={t(promote ? "rules.consequencePromoteClass" : CONSEQUENCE[verdict])}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === "" || (promote && Object.values(rule).includes("")) || noLines}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send({ id: entry.id, verdict, reason: reason.trim(), ...(promote ? rule : {}) }, label, entry.title)}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <p data-dialog-summary className="min-w-0 text-sm font-medium text-pretty break-words whitespace-pre-wrap">
        {entry.title}
      </p>
      <EntryDetail entry={entry} applied={applied} />
      {promote && (
        <>
          <RuleText id={`${entry.id}-wording`} label={t("rules.wording")} help={t("rules.wordingHelp")} value={text} onChange={setText} />
          <RuleText id={`${entry.id}-default`} label={t("rules.default")} help={t("rules.draftHelp")} value={dflt} onChange={setDefault} />
          <RuleText id={`${entry.id}-exception`} label={t("rules.exception")} value={exception} onChange={setException} />
        </>
      )}
      {noLines && !lines.isPending && <Notice tone="warn">{t("rules.applyNoLines")}</Notice>}
      <ReasonField id={entry.id} value={reason} onChange={setReason} />
    </Dialog>
  );
}

/** Retire of an applied class: the required reason, then the verdict (the server removes the rule's block first). */
export function RetireDialog({ id, name, token, onClose }: { id: string; name: string; token: string; onClose: () => void }) {
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
    >
      <ReasonField id={id} value={reason} onChange={setReason} />
    </Dialog>
  );
}
