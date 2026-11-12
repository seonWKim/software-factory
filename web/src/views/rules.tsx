import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type RuleRow, type RuleVerdict, type RulesView, postRuleVerdict, postSettings, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571): the owner's tacit ledger entries
// waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`), each with its title, state and ID, read
// through GET /api/v1/rules. Promote, Hold and Reject each open a dialog that asks for a reason before it sends; Promote
// of a class also asks for the rule's wording, sent as the rule (a proposal takes none). Only the owner sends; anyone
// else sees the list with the reason. With the ledger off (design 08-settings, 2026-11-12) the page says whether it
// found the agents home: found, one primary Turn on, which stores the `integrations` entry through POST /api/v1/settings
// and then loads the rules with no reload; not found, which CLI is missing and how to point AGENTS_HOME at the home.
// The app's page title is the one "Rules" heading.
// One card per entry at every width, so no table turns into cards.

const muted = "text-xs text-pretty text-text-2";

const STATE_LABEL: Record<string, MessageKey> = { open: "rules.stateOpen", pending: "rules.statePending", held: "rules.stateHeld" };
/** A candidate class (`C-…`) takes the owner's wording as its rule on promote; a structure proposal takes none. */
const isClass = (id: string): boolean => id.startsWith("C-");
const VERDICTS: readonly { verdict: RuleVerdict; label: MessageKey }[] = [
  { verdict: "promote", label: "rules.promote" },
  { verdict: "hold", label: "rules.hold" },
  { verdict: "reject", label: "rules.reject" },
];
const CONSEQUENCE: Record<RuleVerdict, MessageKey> = {
  promote: "rules.consequencePromote",
  hold: "rules.consequenceHold",
  reject: "rules.consequenceReject",
};

/** The verdict dialog: a reason first, and for promote of a class the rule's wording, prefilled with its title. */
function VerdictDialog({ entry, verdict, token, onClose }: { entry: RuleRow; verdict: RuleVerdict; token: string; onClose: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promote = verdict === "promote" && isClass(entry.id);
  const wording = text.trim();
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postRuleVerdict(token, { id: entry.id, verdict, reason: reason.trim(), ...(promote ? { text: wording } : {}) });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("rules.sent", { label: t(VERDICTS.find((v) => v.verdict === verdict)!.label), id: entry.id }));
      await client.invalidateQueries({ queryKey: [API.rules] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const label = t(VERDICTS.find((v) => v.verdict === verdict)!.label);
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, id: entry.id })}
      consequence={t(CONSEQUENCE[verdict])}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === "" || (promote && wording === "")}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send()}
      onClose={onClose}
    >
      {promote && (
        <Field label={t("rules.wording")} htmlFor={`${entry.id}-wording`} help={t("rules.wordingHelp")}>
          <Textarea id={`${entry.id}-wording`} aria-label={t("rules.wording")} className="min-h-20" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      <Field label={t("rules.why")} htmlFor={`${entry.id}-reason`}>
        <Textarea id={`${entry.id}-reason`} aria-label={t("rules.reason")} className="min-h-16" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function RuleCard({ entry, token }: { entry: RuleRow; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]!) : entry.state}</Badge>
        <span className="min-w-0 font-mono text-xs break-all text-text-2">{entry.id}</span>
      </div>
      <p data-rule-title className="text-sm text-pretty break-words whitespace-pre-wrap">
        {entry.title}
      </p>
      {token !== null && (
        <ButtonRow className="pt-1">
          {VERDICTS.map((v) => (
            <Button key={v.verdict} variant={v.verdict === "reject" ? "danger" : "secondary"} onClick={() => setOpen(v.verdict)}>
              {t(v.label)}
            </Button>
          ))}
        </ButtonRow>
      )}
      {open !== null && token !== null && <VerdictDialog entry={entry} verdict={open} token={token} onClose={() => setOpen(null)} />}
    </li>
  );
}

/** The ledger off: the agents home found (Turn on) or the CLI missing there, and why the viewer cannot turn it on. */
function LedgerOff({ view }: { view: RulesView }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = view.home;
  const turnOn = async (token: string, value: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postSettings(token, { action: "set", key: "integrations", value });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("rules.ledgerOn"));
      await client.invalidateQueries({ queryKey: [API.rules] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Empty>{t("rules.ledgerOff")}</Empty>
      {home !== null && home.missing === null && (
        <p data-home className="text-sm text-pretty break-words">
          {t("rules.homeFound")}<span className="font-mono break-all">{home.path}</span>
        </p>
      )}
      {home !== null && home.missing !== null && (
        <p data-home className="text-sm text-pretty break-words">
          {t("rules.homeMissing")}<span className="font-mono break-all">{home.path}</span>:{" "}
          <span className="font-mono break-all">{home.missing}</span>
          {t("rules.homeMissingNext")}
          <span className="font-mono break-all">{`${home.path}/bin`}</span>
          {t("rules.homeMissingStart")}
          <code>{t("rules.factoryUi")}</code>
          {t("rules.homeMissingEnd")}
        </p>
      )}
      {view.judge !== null && (
        <p role="note" className="rounded-control bg-pill-warn-bg px-3 py-2 text-sm text-pretty break-words text-pill-warn-fg">
          {view.judge}
        </p>
      )}
      {view.turn_on !== null && view.csrf_token !== null && (
        <>
          <Button variant="primary" disabled={busy} onClick={() => void turnOn(view.csrf_token!, view.turn_on!)}>
            {t("rules.turnOn")}
          </Button>
          <p className={muted}>{t("rules.turnOnHint")}</p>
        </>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-pretty break-words text-pill-bad-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export function RulesPage() {
  const rules = useApi<RulesView>(API.rules);
  const v = rules.data;
  if (rules.isError) return <ErrorNote error={rules.error} />;
  if (!v) return <Loading rows={3} />;
  if (!v.enabled) return <LedgerOff view={v} />;
  const token = v.judge === null ? v.csrf_token : null;
  return (
    <Section title={t("rules.waiting")} count={v.entries.length}>
      {v.judge !== null && (
        <p role="note" className="mb-2 rounded-control bg-pill-warn-bg px-3 py-2 text-sm text-pretty break-words text-pill-warn-fg">
          {t("rules.readOnly")}{v.judge}
        </p>
      )}
      {v.error !== null && (
        <p role="alert" className="mb-2 text-sm text-pretty break-words text-pill-bad-fg">
          {v.error}
        </p>
      )}
      {v.entries.length === 0 ? (
        v.error === null && <Empty>{t("rules.empty")}</Empty>
      ) : (
        <ul aria-label={t("rules.waiting")} className="divide-y divide-border rounded-control border border-border">
          {v.entries.map((e) => (
            <RuleCard key={e.id} entry={e} token={token} />
          ))}
        </ul>
      )}
      <p className={`mt-3 ${muted}`}>
        {t("rules.footer")}
      </p>
    </Section>
  );
}
