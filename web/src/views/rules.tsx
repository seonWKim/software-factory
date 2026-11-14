import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  API, type AppliedRule, type RetiredRule, type RuleDetail, type RuleRow, type RuleVerdict, type RulesView, postRuleVerdict, postSettings, useApi, useRuleEntry,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Markdown } from "../components/ui/markdown.js";
import { Tooltip } from "../components/ui/menu.js";
import { Badge, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { EmptyState, Notice, PageHeader, StatusBadge } from "../components/ui/notice.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571), under one PageHeader that says what
// the page is for and how many entries wait, at most max-w-3xl wide, with a "How this works" disclosure. Only entries
// the ledger has not judged (judged null) wait: they are counted and shown in two groups, rule candidates (`C-…`) and
// structure proposals (`P-…`), each under one line saying what promoting one does; judged ones collapse into one
// "N decided" line, and with none waiting an EmptyState gives the next step. A card lists its title, a StatusBadge
// (open, pending, held, or the judged decision) and its ID. "Why and where" (aria-expanded, a chevron) reads the entry's
// detail on demand through GET /api/v1/rules/entry?id=, never on page load. Promote (primary, with a Tooltip when off),
// Hold and Reject (danger, last) each open a dialog that shows the entry's why and where above a required reason;
// Promote of a class also asks for the rule's wording, default and exception (prefilled from the class's draft);
// Promote of a proposal asks for the file the change went into, "Applied to" (prefilled with its target, required: an
// empty field says why and keeps Send off), sent as `applied_to`.
// Only the owner sends. With the ledger off the page is an EmptyState whose action is Turn on (stores `integrations`
// through POST /api/v1/settings, then loads the rules) or, with no agents home, says which CLI is missing.
// Applied lists the promoted rules file in the file's order, one compact row per rule (ID, name, scope, judged date,
// the "Suggested to retire" badge and Retire) that expands to a label/value list, with a search over ID, name, default
// and scope; it is collapsed while something waits. Suggest reads each class's retire suggestions on demand. Then a
// collapsed Retired list. Scope and the encoded-elsewhere lines render through Markdown.
// One card per entry at every width, so no table turns into cards.

const muted = "text-xs text-pretty text-text-2";

const STATE_LABEL: Record<string, MessageKey> = { open: "rules.stateOpen", pending: "rules.statePending", held: "rules.stateHeld" };
/** The StatusBadge level of each state, so open, pending and held look different. */
const STATE_LEVEL: Record<string, string> = { open: "running", pending: "needs_approval" };
/** The page's reading width, and the longest title a dialog heading shows. */
const PAGE_WIDTH = "max-w-3xl";
const TITLE_MAX = 60;
const shorten = (title: string): string => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title);
/** A candidate class (`C-…`) takes the owner's wording as its rule on promote; a structure proposal the file it was applied to. */
const isClass = (id: string): boolean => id.startsWith("C-");
const VERDICTS: readonly { verdict: RuleVerdict; label: MessageKey; variant: "primary" | "secondary" | "danger" }[] = [
  { verdict: "promote", label: "rules.promote", variant: "primary" },
  { verdict: "hold", label: "rules.hold", variant: "secondary" },
  { verdict: "reject", label: "rules.reject", variant: "danger" },
];
/** The two groups, candidates first, each with its line on what promoting one does. */
const GROUPS: readonly { classes: boolean; title: MessageKey; line: MessageKey }[] = [
  { classes: true, title: "rules.groupClasses", line: "rules.groupClassesLine" },
  { classes: false, title: "rules.groupProposals", line: "rules.groupProposalsLine" },
];
const CONSEQUENCE: Record<RuleVerdict, MessageKey> = {
  promote: "rules.consequencePromoteProposal",
  hold: "rules.consequenceHold",
  reject: "rules.consequenceReject",
  retire: "rules.consequenceRetire",
};

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
  const send = async (body: Parameters<typeof postRuleVerdict>[1], label: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postRuleVerdict(token, body);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("rules.sent", { label, id: body.id }));
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
 * The verdict dialog: a reason first, and for promote of a class the rule's wording (prefilled with its title) and its
 * default and exception (prefilled from its draft); for promote of a proposal the file it was applied to (prefilled
 * with its target).
 */
function VerdictDialog({ entry, verdict, token, onClose }: { entry: RuleRow; verdict: RuleVerdict; token: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.title);
  const [dflt, setDefault] = useState(entry.draft?.default ?? "");
  const [exception, setException] = useState(entry.draft?.exception ?? "");
  const [appliedTo, setAppliedTo] = useState(entry.target ?? "");
  const { busy, error, send } = useSendVerdict(token, onClose);
  const promote = verdict === "promote" && isClass(entry.id);
  const applies = verdict === "promote" && !isClass(entry.id);
  const rule = { text: text.trim(), default: dflt.trim(), exception: exception.trim() };
  const noFile = applies && appliedTo.trim() === "";
  const label = t(VERDICTS.find((v) => v.verdict === verdict)!.label);
  return (
    <Dialog
      title={t("rules.dialogTitleEntry", { label, id: entry.id, title: shorten(entry.title) })}
      consequence={t(promote ? "rules.consequencePromoteClass" : CONSEQUENCE[verdict])}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === "" || (promote && Object.values(rule).includes("")) || noFile}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send({ id: entry.id, verdict, reason: reason.trim(), ...(promote ? rule : {}), ...(applies ? { applied_to: appliedTo.trim() } : {}) }, label)}
      onClose={onClose}
    >
      <div className="max-h-40 overflow-y-auto">
        <EntryDetail entry={entry} />
      </div>
      {promote && (
        <>
          <RuleText id={`${entry.id}-wording`} label={t("rules.wording")} help={t("rules.wordingHelp")} value={text} onChange={setText} />
          <RuleText id={`${entry.id}-default`} label={t("rules.default")} help={t("rules.draftHelp")} value={dflt} onChange={setDefault} />
          <RuleText id={`${entry.id}-exception`} label={t("rules.exception")} value={exception} onChange={setException} />
        </>
      )}
      {applies && (
        <Field label={t("rules.appliedTo")} htmlFor={`${entry.id}-applied-to`} help={t(noFile ? "rules.appliedToEmpty" : "rules.appliedToHelp")}>
          <Input
            id={`${entry.id}-applied-to`} aria-label={t("rules.appliedTo")} aria-invalid={noFile} className="font-mono" value={appliedTo} maxLength={1000}
            onChange={(e) => setAppliedTo(e.target.value)}
          />
        </Field>
      )}
      <ReasonField id={entry.id} value={reason} onChange={setReason} />
    </Dialog>
  );
}

/** Retire of an applied class: the required reason, then the verdict (the server removes the rule's block first). */
function RetireDialog({ id, token, onClose }: { id: string; token: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, send } = useSendVerdict(token, onClose);
  const label = t("rules.retire");
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, id })}
      consequence={t(CONSEQUENCE.retire)}
      confirmLabel={t("rules.send", { label: label.toLowerCase() })}
      confirmDisabled={busy || reason.trim() === ""}
      danger
      error={error}
      onConfirm={() => void send({ id, verdict: "retire", reason: reason.trim() }, label)}
      onClose={onClose}
    >
      <ReasonField id={id} value={reason} onChange={setReason} />
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
    <div data-rule-detail>
      <Notice tone="info">{t("rules.detailUnread")}</Notice>
    </div>
  );
}

function RuleCard({ entry, token }: { entry: RuleRow; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  const [detail, setDetail] = useState(false);
  const noDraft = isClass(entry.id) && entry.draft === null;
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p data-rule-title className="min-w-0 text-sm font-medium text-pretty break-words whitespace-pre-wrap">
          {entry.title}
        </p>
        {entry.judged !== null ? (
          <span data-judged>
            <StatusBadge level="ready_to_merge" size="sm">{t("rules.judged", { decision: entry.judged })}</StatusBadge>
          </span>
        ) : (
          <StatusBadge level={STATE_LEVEL[entry.state]} size="sm">{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]!) : entry.state}</StatusBadge>
        )}
        <span className="font-mono text-xs break-all text-text-2">{entry.id}</span>
      </div>
      {!isClass(entry.id) && (
        <p data-rule-what className={muted}>
          {proposalLine(entry.kind, entry.target)}
        </p>
      )}
      <Button variant="ghost" size="sm" aria-expanded={detail} onClick={() => setDetail(!detail)}>
        {t("rules.showDetail")}
        <ChevronDown aria-hidden className={`size-4 motion-safe:transition-transform ${detail ? "rotate-180" : ""}`} />
      </Button>
      {detail && <EntryDetail entry={entry} />}
      {entry.judged === null && entry.draft_error !== null && (
        <p data-draft-error className="text-xs text-pretty break-words text-pill-bad-fg">
          {t("rules.draftError", { error: entry.draft_error })}
        </p>
      )}
      {token !== null && entry.judged === null && (
        <ButtonRow className="pt-1">
          {VERDICTS.map((v) => {
            const button = (
              <Button key={v.verdict} variant={v.variant} disabled={v.verdict === "promote" && noDraft} onClick={() => setOpen(v.verdict)}>
                {t(v.label)}
              </Button>
            );
            return v.verdict === "promote" && noDraft ? (
              <Tooltip key={v.verdict} text={t("rules.promoteOff")}>
                {button}
              </Tooltip>
            ) : (
              button
            );
          })}
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
  const canTurnOn = view.turn_on !== null && view.csrf_token !== null;
  return (
    <div className={`${PAGE_WIDTH} space-y-3`}>
      <EmptyState
        title={t("rules.ledgerOff")}
        action={
          canTurnOn && (
            <Button variant="primary" disabled={busy} onClick={() => void turnOn(view.csrf_token!, view.turn_on!)}>
              {t("rules.turnOn")}
            </Button>
          )
        }
      >
        {canTurnOn ? t("rules.turnOnHint") : undefined}
      </EmptyState>
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
      {view.judge !== null && <Notice tone="warn">{view.judge}</Notice>}
      {error !== null && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

/** One label and its value in an applied rule's details; no value reads "not given". */
function AppliedPart({ label, children }: { label: MessageKey; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs font-semibold text-text-2">{t(label)}</dt>
      <dd className="min-w-0">{children ?? <span className="text-sm text-text-2">{t("rules.notGiven")}</span>}</dd>
    </>
  );
}

/** A text part through Markdown, or nothing when the rule has none. */
const md = (value: string | null): ReactNode => (value === null || value === "" ? null : <Markdown text={value} />);

/** The evidence as a count and the incident IDs once each; nothing when the block gave none. */
function evidence(incidents: string[] | null): ReactNode {
  if (incidents === null) return null;
  const ids = [...new Set(incidents)];
  return <p className="text-sm break-words">{t("rules.appliedEvidence", { count: ids.length, ids: ids.join(", ") })}</p>;
}

/** One promoted block: its ID, name and parts; an unparsable block shows its raw text. */
function AppliedCard({ rule, token, round }: { rule: AppliedRule; token: string | null; round: number }) {
  if (rule.raw !== null || rule.id === null) {
    return (
      <li data-applied-raw className="p-3">
        <pre className="font-mono text-xs break-words whitespace-pre-wrap">{rule.raw}</pre>
      </li>
    );
  }
  return <AppliedClass rule={rule} id={rule.id} token={token} round={round} />;
}

/**
 * An applied class as a compact row: ID, name, scope and judged date, the "Suggested to retire" badge with its reasons
 * once Suggest was pressed (`round` > 0), and Retire, which opens the reason dialog (disabled for anyone but the owner,
 * no `token`); its details open under the row as a label/value list.
 */
function AppliedClass({ rule, id, token, round }: { rule: AppliedRule; id: string; token: string | null; round: number }) {
  const [retiring, setRetiring] = useState(false);
  const suggested = useRuleEntry(id, round > 0, round).data?.retire ?? [];
  return (
    <li data-applied={id} className="space-y-1 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs break-all text-text-2">{id}</span>
        <p className="min-w-0 text-sm font-medium text-pretty break-words">{rule.name}</p>
        {suggested.length > 0 && <Badge level="needs_approval">{t("rules.suggested")}</Badge>}
        {rule.judged !== null && <span className={`${muted} tabular-nums`}>{rule.judged}</span>}
        <div className="ml-auto">
          <Button variant="danger" size="sm" disabled={token === null} title={token === null ? t("rules.retireOwner") : undefined} onClick={() => setRetiring(true)}>
            {t("rules.retire")}
          </Button>
        </div>
      </div>
      {rule.scope !== null && rule.scope !== "" && <div className="line-clamp-2 text-text-2">{md(rule.scope)}</div>}
      {suggested.length > 0 && (
        <ul data-suggested className="space-y-0.5">
          {suggested.map((r) => (
            <li key={r} className={muted}>
              {r}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-text-2">{t("rules.appliedDetails")}</summary>
        <dl className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
          <AppliedPart label="rules.appliedDefault">{md(rule.default)}</AppliedPart>
          <AppliedPart label="rules.appliedException">{md(rule.exceptions)}</AppliedPart>
          <AppliedPart label="rules.appliedIncidents">{evidence(rule.incidents)}</AppliedPart>
          <AppliedPart label="rules.appliedJudged">{rule.judged === null ? null : <p className="text-sm">{rule.judged}</p>}</AppliedPart>
        </dl>
      </details>
      {retiring && token !== null && <RetireDialog id={id} token={token} onClose={() => setRetiring(false)} />}
    </li>
  );
}

/** Whether a rule matches the search: its ID, name, default and scope (or its raw text), case-insensitively. */
const matches = (r: AppliedRule, query: string): boolean =>
  [r.id, r.name, r.default, r.scope, r.raw].some((v) => v !== null && v.toLowerCase().includes(query));

/**
 * The promoted rules in the file's order with a search, and the encoded-elsewhere lines, with Suggest; collapsed while
 * `collapsed` (something waits). Not shown when the file has none.
 */
function Applied({ applied, token, collapsed }: { applied: NonNullable<RulesView["applied"]>; token: string | null; collapsed: boolean }) {
  const { rules, elsewhere } = applied;
  // Each Suggest press is a new round of reads; 0 until the first press.
  const [round, setRound] = useState(0);
  const [query, setQuery] = useState("");
  if (rules.length === 0 && elsewhere.length === 0) return null;
  const suggest = rules.some((r) => r.raw === null && r.id !== null) && (
    <Button size="sm" onClick={() => setRound(round + 1)}>
      {t("rules.suggest")}
    </Button>
  );
  const q = query.trim().toLowerCase();
  const shown = rules.filter((r) => matches(r, q));
  return (
    <Section title={t("rules.groupApplied")} count={rules.length} action={suggest}>
      <details open={!collapsed}>
        <summary className="cursor-pointer text-xs text-pretty text-text-2">{t("rules.appliedShow")}</summary>
        <div className="mt-2 space-y-2">
          <p data-group-line className={muted}>
            {t("rules.groupAppliedLine")} {t("rules.appliedOrder")}
          </p>
          {rules.length > 0 && <Input type="search" aria-label={t("rules.appliedSearch")} placeholder={t("rules.appliedSearch")} className="w-full" value={query} onChange={(e) => setQuery(e.target.value)} />}
          {shown.length > 0 && (
            <ul aria-label={t("rules.groupApplied")} className="divide-y divide-border rounded-control border border-border">
              {shown.map((r, i) => (
                <AppliedCard key={r.id ?? `raw${i}`} rule={r} token={token} round={round} />
              ))}
            </ul>
          )}
          {rules.length > 0 && shown.length === 0 && <p className={muted}>{t("rules.appliedNone")}</p>}
          {elsewhere.length > 0 && (
            <div data-elsewhere className="space-y-1">
              <h3 className="text-xs font-semibold text-text-2">{t("rules.elsewhere")}</h3>
              <Markdown text={elsewhere.join("\n")} />
            </div>
          )}
        </div>
      </details>
    </Section>
  );
}

/** The ledger's retired classes, newest first, in a collapsed list with reason and date; not shown when there are none. */
function Retired({ retired }: { retired: RetiredRule[] }) {
  if (retired.length === 0) return null;
  return (
    <Section title={t("rules.groupRetired")} count={retired.length}>
      <details data-retired>
        <summary className="cursor-pointer text-xs text-pretty text-text-2">{t("rules.retiredShow")}</summary>
        <ul aria-label={t("rules.groupRetired")} className="mt-2 divide-y divide-border rounded-control border border-border">
          {retired.map((r) => (
            <li key={r.id} data-retired-rule={r.id} className="space-y-1 p-3">
              <span className="font-mono text-xs break-all text-text-2">{r.id}</span>
              <p className={line}>{t("rules.retiredOn", { date: r.date, reason: r.reason })}</p>
            </li>
          ))}
        </ul>
      </details>
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
  // Only an entry the ledger has not judged waits; a judged one is decided.
  const waiting = v.entries.filter((e) => e.judged === null);
  const decided = v.entries.filter((e) => e.judged !== null);
  return (
    <div className={`${PAGE_WIDTH} space-y-4`}>
      <PageHeader title={t("rules.pageTitle")} description={t("rules.pageDescription")} actions={<span data-waiting className="text-sm font-medium tabular-nums">{t("rules.waiting", { count: waiting.length })}</span>} />
      <details data-how className="rounded-control border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">{t("rules.how")}</summary>
        <p className={`mt-2 ${muted}`}>{t("rules.footer")}</p>
      </details>
      {v.judge !== null && <Notice tone="warn">{t("rules.readOnly")}{v.judge}</Notice>}
      {v.error !== null && <Notice tone="bad">{v.error}</Notice>}
      {waiting.length === 0 && v.error === null && <EmptyState title={t("rules.emptyTitle")}>{t("rules.empty")}</EmptyState>}
      <div>
        {GROUPS.map((g) => {
          const entries = waiting.filter((e) => isClass(e.id) === g.classes);
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
        {decided.length > 0 && (
          <details data-decided className="mt-6">
            <summary className="cursor-pointer text-sm font-semibold">{t("rules.decided", { count: decided.length })}</summary>
            <p className={`my-2 ${muted}`}>{t("rules.judgedHint")}</p>
            <ul aria-label={t("rules.decidedList")} className="divide-y divide-border rounded-control border border-border">
              {decided.map((e) => (
                <RuleCard key={e.id} entry={e} token={token} />
              ))}
            </ul>
          </details>
        )}
        {v.applied !== null && <Applied applied={v.applied} token={token} collapsed={waiting.length > 0} />}
        {v.retired && <Retired retired={v.retired} />}
      </div>
    </div>
  );
}
