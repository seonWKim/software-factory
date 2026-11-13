import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { API, type AppliedRule, type RuleDetail, type RuleRow, type RuleVerdict, type RulesView, postRuleVerdict, postSettings, useApi, useRuleEntry } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571): the owner's tacit ledger entries
// waiting for a verdict, read through GET /api/v1/rules, in two groups, rule candidates (`C-…`) and structure proposals
// (`P-…`), each under one line saying what promoting one does. A card shows its state, ID, title and one line of what it
// would change (a candidate's rule, worded as its title until opened; a proposal's kind and target). "Why and where"
// reads the entry's detail on demand through GET /api/v1/rules/entry?id=, never on page load: what it would change, why
// (how many times it came up, the owner's words, the root reason) and where it applies, in that order. Promote, Hold
// and Reject each open a dialog that asks for a reason before it sends; Promote of a class also asks for the rule's
// wording, default and exception (the last two prefilled from the class's draft), which the server writes into the
// owner's rules file before the verdict (a proposal takes none). A class whose draft could not be read offers no
// Promote. An entry the ledger judged since its pending view was built shows that decision and no verdict buttons,
// until the view is rebuilt. Only the owner sends; anyone
// else sees the list with the reason. With the ledger off (design 08-settings, 2026-11-12) the page says whether it
// found the agents home: found, one primary Turn on, which stores the `integrations` entry through POST /api/v1/settings
// and then loads the rules with no reload; not found, which CLI is missing and how to point AGENTS_HOME at the home.
// After the waiting groups, an Applied group lists the promoted rules file read-only (design 09-dashboard-app.md,
// 2026-11-13): each block's ID, name, default, exception, scope, evidence and judged date (a missing part reads "not
// given"), an unparsable block as raw text, then the encoded-elsewhere lines. Not shown when there are none.
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
/** The two groups, candidates first, each with its line on what promoting one does. */
const GROUPS: readonly { classes: boolean; title: MessageKey; line: MessageKey }[] = [
  { classes: true, title: "rules.groupClasses", line: "rules.groupClassesLine" },
  { classes: false, title: "rules.groupProposals", line: "rules.groupProposalsLine" },
];
const CONSEQUENCE: Record<RuleVerdict, MessageKey> = {
  promote: "rules.consequencePromote",
  hold: "rules.consequenceHold",
  reject: "rules.consequenceReject",
};

/** One of the rule's text fields in the promote dialog: a labelled textarea of up to 2000 characters. */
function RuleText({ id, label, help, value, onChange }: { id: string; label: string; help?: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id} help={help}>
      <Textarea id={id} aria-label={label} className="min-h-16" value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/**
 * The verdict dialog: a reason first, and for promote of a class the rule's wording (prefilled with its title) and its
 * default and exception (prefilled from its draft).
 */
function VerdictDialog({ entry, verdict, token, onClose }: { entry: RuleRow; verdict: RuleVerdict; token: string; onClose: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.title);
  const [dflt, setDefault] = useState(entry.draft?.default ?? "");
  const [exception, setException] = useState(entry.draft?.exception ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promote = verdict === "promote" && isClass(entry.id);
  const rule = { text: text.trim(), default: dflt.trim(), exception: exception.trim() };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postRuleVerdict(token, { id: entry.id, verdict, reason: reason.trim(), ...(promote ? rule : {}) });
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
      consequence={t(promote ? "rules.consequencePromoteClass" : CONSEQUENCE[verdict])}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === "" || (promote && Object.values(rule).includes(""))}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send()}
      onClose={onClose}
    >
      {promote && (
        <>
          <RuleText id={`${entry.id}-wording`} label={t("rules.wording")} help={t("rules.wordingHelp")} value={text} onChange={setText} />
          <RuleText id={`${entry.id}-default`} label={t("rules.default")} help={t("rules.draftHelp")} value={dflt} onChange={setDefault} />
          <RuleText id={`${entry.id}-exception`} label={t("rules.exception")} value={exception} onChange={setException} />
        </>
      )}
      <Field label={t("rules.why")} htmlFor={`${entry.id}-reason`}>
        <Textarea id={`${entry.id}-reason`} aria-label={t("rules.reason")} className="min-h-16" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** A proposal's kind and target as one line; a part the ledger did not list reads "not given". */
const proposalLine = (kind: string | undefined, target: string | undefined): string =>
  t("rules.whatProposal", { kind: kind ?? t("rules.notGiven"), target: target ?? t("rules.notGiven") });

/** One part of the detail: its label, then its lines, or "not given" when it has none. */
function DetailPart({ label, part, children }: { label: MessageKey; part: string; children: ReactNode[] }) {
  const lines = children.filter(Boolean);
  return (
    <div data-detail-part={part}>
      <h3 className="text-xs font-semibold text-text-2">{t(label)}</h3>
      {lines.length > 0 ? lines : <p className={muted}>{t("rules.notGiven")}</p>}
    </div>
  );
}

const line = "text-sm text-pretty break-words whitespace-pre-wrap";

/** The detail in its order: what it would change, why, where it applies. */
function Detail({ entry, d }: { entry: RuleRow; d: RuleDetail }) {
  const kind = d.kind ?? entry.kind;
  const target = d.target ?? entry.target;
  return (
    <div data-rule-detail className="space-y-2 rounded-control bg-surface-2 p-3">
      <DetailPart label="rules.detailWhat" part="what">
        {[
          d.default !== undefined && <p key="rule" className={line}>{t("rules.whatRule", { rule: d.default })}</p>,
          d.exceptions !== undefined && <p key="except" className={line}>{t("rules.whatExcept", { exceptions: d.exceptions })}</p>,
          kind !== undefined && <p key="kind" className={line}>{t("rules.whatKind", { kind })}</p>,
          target !== undefined && <p key="target" className={`${line} font-mono`}>{t("rules.whatTarget", { target })}</p>,
        ]}
      </DetailPart>
      <DetailPart label="rules.detailWhy" part="why">
        {[
          d.incidents !== undefined && <p key="count" className={line}>{d.incidents === 1 ? t("rules.detailOnce") : t("rules.detailCount", { count: d.incidents })}</p>,
          ...(d.quotes ?? []).map((q, i) => (
            <blockquote key={`q${i}`} data-quote className={`${line} border-l-2 border-border-strong pl-2`}>
              {q}
            </blockquote>
          )),
          d.root_reason !== undefined && <p key="root" className={line}>{t("rules.detailRoot", { reason: d.root_reason })}</p>,
        ]}
      </DetailPart>
      <DetailPart label="rules.detailWhere" part="where">
        {[d.scope !== undefined && <p key="scope" className={line}>{d.scope}</p>]}
      </DetailPart>
    </div>
  );
}

/** The detail, read once when the card opens; "could not be read" when the ledger gave none or failed. */
function EntryDetail({ entry }: { entry: RuleRow }) {
  const q = useRuleEntry(entry.id, true);
  if (q.isPending) return <Loading rows={2} />;
  const d = q.data?.detail ?? null;
  if (d !== null) return <Detail entry={entry} d={d} />;
  return (
    <p role="status" data-rule-detail className="text-sm text-pretty break-words text-pill-bad-fg">
      {t("rules.detailUnread")}
    </p>
  );
}

function RuleCard({ entry, token }: { entry: RuleRow; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  const [detail, setDetail] = useState(false);
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]!) : entry.state}</Badge>
        <span className="min-w-0 font-mono text-xs break-all text-text-2">{entry.id}</span>
      </div>
      <p data-rule-title className="text-sm font-medium text-pretty break-words whitespace-pre-wrap">
        {entry.title}
      </p>
      <p data-rule-what className={muted}>
        {isClass(entry.id) ? t("rules.whatRule", { rule: entry.title }) : proposalLine(entry.kind, entry.target)}
      </p>
      <Button variant="ghost" size="sm" aria-expanded={detail} onClick={() => setDetail(!detail)}>
        {t("rules.showDetail")}
      </Button>
      {detail && <EntryDetail entry={entry} />}
      {entry.judged !== null && (
        <p data-judged className={muted}>
          {t("rules.judged", { decision: entry.judged })} {t("rules.judgedHint")}
        </p>
      )}
      {entry.judged === null && entry.draft_error !== null && (
        <p data-draft-error className="text-xs text-pretty break-words text-pill-bad-fg">
          {t("rules.draftError", { error: entry.draft_error })}
        </p>
      )}
      {token !== null && entry.judged === null && (
        <ButtonRow className="pt-1">
          {VERDICTS.map((v) => (
            <Button
              key={v.verdict}
              variant={v.verdict === "reject" ? "danger" : "secondary"}
              disabled={v.verdict === "promote" && isClass(entry.id) && entry.draft === null}
              onClick={() => setOpen(v.verdict)}
            >
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

/** One part of an applied rule: its label and value, or "not given". */
function AppliedPart({ label, value }: { label: MessageKey; value: string | null }) {
  return <p className={line}>{t(label, { value: value ?? t("rules.notGiven") })}</p>;
}

/** One promoted block: its ID, name and parts; an unparsable block shows its raw text. */
function AppliedCard({ rule }: { rule: AppliedRule }) {
  if (rule.raw !== null) {
    return (
      <li data-applied-raw className="p-3">
        <pre className="font-mono text-xs break-words whitespace-pre-wrap">{rule.raw}</pre>
      </li>
    );
  }
  return (
    <li data-applied={rule.id} className="space-y-1 p-3">
      <span className="font-mono text-xs break-all text-text-2">{rule.id}</span>
      <p className="text-sm font-medium text-pretty break-words">{rule.name}</p>
      <AppliedPart label="rules.appliedDefault" value={rule.default} />
      <AppliedPart label="rules.appliedException" value={rule.exceptions} />
      <AppliedPart label="rules.appliedScope" value={rule.scope} />
      <AppliedPart label="rules.appliedIncidents" value={rule.incidents === null ? null : rule.incidents.join(", ")} />
      <AppliedPart label="rules.appliedJudged" value={rule.judged} />
    </li>
  );
}

/** The promoted rules and the encoded-elsewhere lines, read-only; not shown when there are none. */
function Applied({ applied }: { applied: NonNullable<RulesView["applied"]> }) {
  const { rules, elsewhere } = applied;
  if (rules.length === 0 && elsewhere.length === 0) return null;
  return (
    <Section title={t("rules.groupApplied")} count={rules.length}>
      <p data-group-line className={`mb-2 ${muted}`}>
        {t("rules.groupAppliedLine")}
      </p>
      {rules.length > 0 && (
        <ul aria-label={t("rules.groupApplied")} className="divide-y divide-border rounded-control border border-border">
          {rules.map((r, i) => (
            <AppliedCard key={r.id ?? `raw${i}`} rule={r} />
          ))}
        </ul>
      )}
      {elsewhere.length > 0 && (
        <div data-elsewhere className="mt-3 space-y-1">
          <h3 className="text-xs font-semibold text-text-2">{t("rules.elsewhere")}</h3>
          <ul className="space-y-1">
            {elsewhere.map((l, i) => (
              <li key={i} className={line}>
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
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
    <div>
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
      {v.entries.length === 0 && v.error === null && <Empty>{t("rules.empty")}</Empty>}
      {GROUPS.map((g) => {
        const entries = v.entries.filter((e) => isClass(e.id) === g.classes);
        return (
          entries.length > 0 && (
            <Section key={g.title} title={t(g.title)} count={entries.length}>
              <p data-group-line className={`mb-2 ${muted}`}>
                {t(g.line)}
              </p>
              <ul aria-label={t(g.title)} className="divide-y divide-border rounded-control border border-border">
                {entries.map((e) => (
                  <RuleCard key={e.id} entry={e} token={token} />
                ))}
              </ul>
            </Section>
          )
        );
      })}
      {v.applied !== null && <Applied applied={v.applied} />}
      <p className={`mt-3 ${muted}`}>
        {t("rules.footer")}
      </p>
    </div>
  );
}
