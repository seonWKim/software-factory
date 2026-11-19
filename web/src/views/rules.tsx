import { ScrollText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
  API, type AgentsHomeView, type AppliedRule, type ImproveGroupView, type ImproveView, type RetiredRule, type RuleDetail, type RuleEvidence, type RuleRow, type RuleVerdict, type RulesView,
  postImproveRun, postRuleVerdict, postSettings, useApi, useRuleEntry,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { IdDetails } from "../components/ui/copy.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { KeyValue } from "../components/ui/key-value.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Markdown } from "../components/ui/markdown.js";
import { Tooltip } from "../components/ui/menu.js";
import { Radio } from "../components/ui/radio.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { EmptyState, Notice, PageHeader } from "../components/ui/notice.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ApprovalsSection } from "./standing.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Card } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571), under one PageHeader that says what
// the page is for and how many entries wait, at most max-w-3xl wide, with a "How this works" disclosure. Only entries
// the ledger has not judged (judged null) wait: they are counted and shown in two groups, rule candidates (`C-…`) and
// structure proposals (`P-…`), each under one line saying what promoting one does; judged ones collapse into one
// "N decided" line, and with none waiting an EmptyState gives the next step. A card lists its title (an IdDetails: the ID in its tooltip) and a StatusBadge
// (open, pending, held, or the judged decision). "Why and where" (a Disclosure) reads the entry's
// detail on demand through GET /api/v1/rules/entry?id=, never on page load: a description, what it would change,
// before → after, why, the evidence (newest first, 3 shown, the rest behind "Show all N"), where it applies and the
// related applied rules (sharing an incident ID or naming the target file), each part left out when it has nothing.
// Promote (primary, with a Tooltip when off), Hold and Reject (danger, last) each open a dialog that shows the
// entry's full title and that detail above a required reason;
// Promote of a class also asks for the rule's wording, default and exception (prefilled from the class's draft);
// Promote of a proposal shows its Now and Proposed lines (the detail's before → after) and sends only the reason on
// confirm: the server applies the change through the plugin; a failed apply's error stays in the dialog. With no
// lines to apply Send stays off and a Notice says why.
// Only the owner sends. With the ledger off the page is an EmptyState whose action is Turn on (stores `integrations`,
// the plugin name only, through POST /api/v1/settings, then loads the rules), and an agents home picker over the
// known homes (AGENTS_HOME when set, ~/.agents) shows the chosen one's check: both CLIs executable, else the missing file.
// Applied lists the promoted rules file in the file's order, one compact row per rule (name with its ID in a tooltip, scope, judged date,
// the "Suggested to retire" badge and Retire) that expands to a label/value list, with a search over ID, name, default
// and scope; it is collapsed while something waits. Suggest reads each class's retire suggestions on demand. Then a
// collapsed Retired list. Scope and the encoded-elsewhere lines render through Markdown.
// One card per entry at every width, so no table turns into cards.
// Approvals (standing.tsx, moved from Settings 2026-11-16) sit under the "How this works" line: the pending standing-approval
// proposals and the standing rules, each part hidden when it has no items and the whole heading when both are empty.
// The improve report (design 07-self-improvement, 2026-11-16) is a Section from GET /api/v1/rules's `improve`: its
// window and counts, then one row per failure group with its draft and filing. Run now shows only when `run_now` says
// the viewer may run it (approve_spec); it posts to POST /api/v1/improve/run and shows the queued run_id, or a 409's
// refusal and the run already queued, with no reload. It sits below the rules, and above the EmptyState with the ledger off.

const muted = "text-xs text-pretty text-text-2";

const STATE_LABEL: Record<string, MessageKey> = { open: "rules.stateOpen", pending: "rules.statePending", held: "rules.stateHeld" };
/** The StatusBadge level of each state, so open, pending and held look different. */
const STATE_LEVEL: Record<string, string> = { open: "running", pending: "needs_approval" };
/** The page's reading width. */
const PAGE_WIDTH = "max-w-3xl";
/** A candidate class (`C-…`) takes the owner's wording as its rule on promote; a structure proposal applies its lines. */
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
function VerdictDialog({ entry, applied, verdict, token, onClose }: { entry: RuleRow; applied: AppliedRule[]; verdict: RuleVerdict; token: string; onClose: () => void }) {
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
function RetireDialog({ id, name, token, onClose }: { id: string; name: string; token: string; onClose: () => void }) {
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

/** A proposal's kind and target as one line; a part the ledger did not list reads "not given". */
const proposalLine = (kind: string | undefined, target: string | undefined): string =>
  t("rules.whatProposal", { kind: kind ?? t("rules.notGiven"), target: target ?? t("rules.notGiven") });

/** One part of the detail: its label, then its lines; nothing at all when it has none. */
function DetailPart({ label, part, children }: { label: MessageKey; part: string; children: ReactNode[] }) {
  const lines = children.filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div data-detail-part={part} className="space-y-1">
      <h3 className="text-xs font-semibold text-text-2">{t(label)}</h3>
      {lines}
    </div>
  );
}

const line = "text-sm text-pretty break-words whitespace-pre-wrap";
const quote = `${line} border-l-2 border-border-strong pl-2`;
/** How many incidents show before "Show all N". */
const EVIDENCE_SHOWN = 3;

/** The incidents, newest first: the first EVIDENCE_SHOWN, the rest behind "Show all N". */
function Evidence({ items }: { items: RuleEvidence[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, EVIDENCE_SHOWN);
  return (
    <DetailPart label="rules.detailEvidence" part="evidence">
      {[
        <ol key="list" className="space-y-2">
          {shown.map((e, i) => (
            <li key={`${e.ref ?? ""}${i}`} data-evidence={e.ref ?? ""} className="min-w-0 space-y-0.5">
              {(e.ref !== undefined || e.date !== undefined) && (
                <p className="flex flex-wrap gap-x-2 text-xs text-text-2">
                  {e.ref !== undefined && <span className="font-mono break-all">{e.ref}</span>}
                  {e.date !== undefined && <span data-evidence-date className="tabular-nums">{e.date}</span>}
                </p>
              )}
              {e.proposal !== undefined && <p className={line}>{t("rules.evidenceProposal", { proposal: e.proposal })}</p>}
              {e.quote !== undefined && <blockquote data-quote className={quote}>{e.quote}</blockquote>}
              {e.root_reason !== undefined && <p className={line}>{t("rules.detailRoot", { reason: e.root_reason })}</p>}
            </li>
          ))}
        </ol>,
        !all && items.length > EVIDENCE_SHOWN && (
          <Button key="all" variant="ghost" size="sm" onClick={() => setAll(true)}>
            {t("rules.showAll", { count: items.length })}
          </Button>
        ),
      ]}
    </DetailPart>
  );
}

/** Lines of a file, kept as written. */
const fileLines = "rounded-control bg-surface p-2 font-mono text-xs break-words whitespace-pre-wrap";

/** An applied rule's name, else its default, else "not given". */
const ruleName = (r: AppliedRule): string => r.name || r.default || t("rules.notGiven");

/** The applied rules that share an incident ID with the entry or name its target file. */
function related(applied: AppliedRule[], ids: ReadonlySet<string>, target: string | undefined): AppliedRule[] {
  return applied.filter(
    (r) => (r.incidents ?? []).some((i) => ids.has(i)) || (target !== undefined && target !== "" && [r.name, r.default, r.exceptions, r.scope, r.raw].some((v) => v?.includes(target))),
  );
}

/**
 * The detail in its order: a description, what it would change (a proposal's kind and target), before → after, why,
 * the evidence, where it applies, and the related applied rules. A part with nothing to show is left out; only "what"
 * says "not given".
 */
function Detail({ entry, d, applied }: { entry: RuleRow; d: RuleDetail; applied: AppliedRule[] }) {
  const kind = d.kind ?? entry.kind;
  const target = d.target ?? entry.target;
  const rule = d.default ?? entry.draft?.default;
  const exception = d.exceptions ?? entry.draft?.exception;
  const evidence = d.evidence ?? [];
  const ids = new Set([...evidence.flatMap((e) => (e.ref === undefined ? [] : [e.ref])), ...(entry.draft?.incidents ?? [])]);
  const overlaps = related(applied, ids, target);
  return (
    <div data-rule-detail className="min-w-0 space-y-3 rounded-control bg-surface-2 p-3">
      {d.description !== undefined && <p data-detail-description className={line}>{d.description}</p>}
      {!isClass(entry.id) && (
        <DetailPart label="rules.detailWhat" part="what">
          {kind === undefined && target === undefined
            ? [<p key="none" className={muted}>{t("rules.notGiven")}</p>]
            : [
              kind !== undefined && <p key="kind" className={line}>{t("rules.whatKind", { kind })}</p>,
              target !== undefined && <p key="target" className={`${line} font-mono`}>{t("rules.whatTarget", { target })}</p>,
            ]}
        </DetailPart>
      )}
      <DetailPart label="rules.detailChange" part="change">
        {[
          rule !== undefined && <p key="rule" className={line}>{t("rules.whatRule", { rule })}</p>,
          exception !== undefined && <p key="except" className={line}>{t("rules.whatExcept", { exceptions: exception })}</p>,
          d.current !== undefined && <p key="nowl" className="text-xs text-text-2">{t("rules.changeNow")}</p>,
          d.current !== undefined && <pre key="now" data-change="current" className={fileLines}>{d.current}</pre>,
          d.proposed !== undefined && <p key="nextl" className="text-xs text-text-2">{t("rules.changeProposed")}</p>,
          d.proposed !== undefined && <pre key="next" data-change="proposed" className={fileLines}>{d.proposed}</pre>,
        ]}
      </DetailPart>
      <DetailPart label="rules.detailWhy" part="why">
        {[
          d.incidents !== undefined && <p key="count" className={line}>{d.incidents === 1 ? t("rules.detailOnce") : t("rules.detailCount", { count: d.incidents })}</p>,
          d.root_reason !== undefined && <p key="root" className={line}>{t("rules.detailRoot", { reason: d.root_reason })}</p>,
        ]}
      </DetailPart>
      {evidence.length > 0 && <Evidence items={evidence} />}
      <DetailPart label="rules.detailWhere" part="where">
        {[d.scope !== undefined && <Markdown key="scope" text={d.scope} />]}
      </DetailPart>
      <DetailPart label="rules.detailRelated" part="related">
        {[
          overlaps.length > 0 && (
            <ul key="list" className="space-y-0.5">
              {overlaps.map((r, i) => (
                <li key={r.id ?? `raw${i}`} data-related={r.id ?? ""} className={line}>
                  {r.id !== null ? <IdDetails label={ruleName(r)} id={r.id} what="rule ID" /> : r.raw?.split("\n")[0]}
                </li>
              ))}
            </ul>
          ),
        ]}
      </DetailPart>
    </div>
  );
}

/** The detail, read once when the card opens; "could not be read" when the ledger gave none or failed. */
function EntryDetail({ entry, applied }: { entry: RuleRow; applied: AppliedRule[] }) {
  const q = useRuleEntry(entry.id, true);
  if (q.isPending) return <Loading rows={2} />;
  const d = q.data?.detail ?? null;
  if (d !== null) return <Detail entry={entry} d={d} applied={applied} />;
  return (
    <div data-rule-detail>
      <Notice tone="info">{t("rules.detailUnread")}</Notice>
    </div>
  );
}

function RuleCard({ entry, applied, token }: { entry: RuleRow; applied: AppliedRule[]; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  const noDraft = isClass(entry.id) && entry.draft === null;
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p data-rule-title className="min-w-0 text-sm font-medium text-pretty break-words whitespace-pre-wrap">
          <IdDetails label={entry.title} id={entry.id} what="rule ID" />
        </p>
        {entry.judged !== null ? (
          <span data-judged>
            <Badge level="ready_to_merge">{t("rules.judged", { decision: entry.judged })}</Badge>
          </span>
        ) : (
          <Badge level={STATE_LEVEL[entry.state]}>{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]!) : entry.state}</Badge>
        )}
      </div>
      {!isClass(entry.id) && (
        <p data-rule-what className={muted}>
          {proposalLine(entry.kind, entry.target)}
        </p>
      )}
      <Disclosure lazy summary={t("rules.showDetail")}>
        <EntryDetail entry={entry} applied={applied} />
      </Disclosure>
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
      {open !== null && token !== null && <VerdictDialog entry={entry} applied={applied} verdict={open} token={token} onClose={() => setOpen(null)} />}
    </li>
  );
}

/** The chosen home's check: both CLIs executable, else the first missing file; and whether the ledger reads it. */
function HomeCheck({ home, inUse }: { home: AgentsHomeView; inUse: string }) {
  return (
    <div data-home-check className="space-y-2">
      {home.missing === null ? (
        <Notice tone="ok">{t("rules.homeOk", { path: home.path })}</Notice>
      ) : (
        <Notice tone="warn">{t("rules.homeMissingFile", { file: home.missing, path: home.path })}</Notice>
      )}
      {home.path !== inUse && <p className={muted}>{t("rules.homeNotUsed", { path: inUse })}</p>}
    </div>
  );
}

/**
 * The agents home picker: the known homes only (AGENTS_HOME when set, ~/.agents), the one in use chosen first, and the
 * chosen one's check. Choosing stores nothing.
 */
function HomePicker({ home }: { home: AgentsHomeView & { homes?: AgentsHomeView[] } }) {
  const homes = home.homes ?? [home];
  const [chosen, setChosen] = useState(home.path);
  const shown = homes.find((h) => h.path === chosen) ?? home;
  return (
    <div data-home className="space-y-2">
      <Field label={t("rules.homePick")} help={t("rules.homePickHelp")}>
        <div role="radiogroup" aria-label={t("rules.homePick")} className="space-y-1">
          {homes.map((h) => (
            <Radio key={h.path} name="agents-home" value={h.path} checked={h.path === chosen} onChange={() => setChosen(h.path)}>
              <span className="font-mono break-all">{h.path === home.path ? t("rules.homeInUse", { path: h.path }) : h.path}</span>
            </Radio>
          ))}
        </div>
      </Field>
      <HomeCheck home={shown} inUse={home.path} />
    </div>
  );
}

/** The ledger off: the agents home picker with its check, Turn on when the home in use is found, and why the viewer cannot turn it on. */
function LedgerOff({ view }: { view: RulesView }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        description={canTurnOn ? t("rules.turnOnHint") : undefined}
      />
      {view.home !== null && <HomePicker home={view.home} />}
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
        <p className="min-w-0 text-sm font-medium text-pretty break-words">
          <IdDetails label={ruleName(rule)} id={id} what="rule ID" />
        </p>
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
      <Disclosure summary={t("rules.appliedDetails")}>
        <dl className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
          <AppliedPart label="rules.appliedDefault">{md(rule.default)}</AppliedPart>
          <AppliedPart label="rules.appliedException">{md(rule.exceptions)}</AppliedPart>
          <AppliedPart label="rules.appliedIncidents">{evidence(rule.incidents)}</AppliedPart>
          <AppliedPart label="rules.appliedJudged">{rule.judged === null ? null : <p className="text-sm">{rule.judged}</p>}</AppliedPart>
        </dl>
      </Disclosure>
      {retiring && token !== null && <RetireDialog id={id} name={ruleName(rule)} token={token} onClose={() => setRetiring(false)} />}
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
    <Card title={t("rules.groupApplied")} count={rules.length} action={suggest}>
      <Disclosure defaultOpen={!collapsed} summary={t("rules.appliedShow")}>
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
      </Disclosure>
    </Card>
  );
}

/** The ledger's retired classes, newest first, in a collapsed list with reason and date; not shown when there are none. */
function Retired({ retired }: { retired: RetiredRule[] }) {
  if (retired.length === 0) return null;
  return (
    <Card title={t("rules.groupRetired")} count={retired.length}>
      <Disclosure data-retired summary={t("rules.retiredShow")}>
        <ul aria-label={t("rules.groupRetired")} className="mt-2 divide-y divide-border rounded-control border border-border">
          {retired.map((r) => (
            <li key={r.id} data-retired-rule={r.id} className="space-y-1 p-3">
              <p className="text-sm font-medium"><IdDetails label={t("rules.retiredRule")} id={r.id} what="rule ID" /></p>
              <p className={line}>{t("rules.retiredOn", { date: r.date, reason: r.reason })}</p>
            </li>
          ))}
        </ul>
      </Disclosure>
    </Card>
  );
}

export function RulesPage() {
  const rules = useApi<RulesView>(API.rules);
  const v = rules.data;
  const title = t("page.rules");
  if (rules.isError) return <><PageHeader title={title} /><ErrorNote error={rules.error} /></>;
  if (!v) return <><PageHeader title={title} /><Loading rows={3} /></>;
  if (!v.enabled) {
    return (
      <>
        <PageHeader title={title} />
        <div className={`${PAGE_WIDTH} space-y-4`}>
          <ApprovalsSection />
          {v.improve && <Improve view={v.improve} />}
          <LedgerOff view={v} />
        </div>
      </>
    );
  }
  const token = v.judge === null ? v.csrf_token : null;
  // Only an entry the ledger has not judged waits; a judged one is decided.
  const waiting = v.entries.filter((e) => e.judged === null);
  const decided = v.entries.filter((e) => e.judged !== null);
  const applied = v.applied?.rules ?? [];
  return (
    <div className={`${PAGE_WIDTH} space-y-4`}>
      <PageHeader title={title} description={t("rules.pageDescription")} actions={<span data-waiting className="text-sm font-medium tabular-nums">{t("rules.waiting", { count: waiting.length })}</span>} />
      <Disclosure data-how summary={t("rules.how")}>
        <p className={`mt-2 ${muted}`}>{t("rules.footer")}</p>
      </Disclosure>
      {v.judge !== null && <Notice tone="warn">{t("rules.readOnly")}{v.judge}</Notice>}
      {v.error !== null && <Notice tone="bad">{v.error}</Notice>}
      <ApprovalsSection />
      {waiting.length === 0 && v.error === null && <EmptyState icon={ScrollText} title={t("rules.emptyTitle")} description={t("rules.empty")} />}
      <div>
        {GROUPS.map((g) => {
          const entries = waiting.filter((e) => isClass(e.id) === g.classes);
          return (
            entries.length > 0 && (
              <Card key={g.title} title={t(g.title)} count={entries.length}>
                <p data-group-line className={`mb-2 ${muted}`}>
                  {t(g.line)}
                </p>
                <ul aria-label={t(g.title)} className="divide-y divide-border rounded-control border border-border">
                  {entries.map((e) => (
                    <RuleCard key={e.id} entry={e} applied={applied} token={token} />
                  ))}
                </ul>
              </Card>
            )
          );
        })}
        {decided.length > 0 && (
          <Disclosure data-decided className="mt-6" summary={t("rules.decided", { count: decided.length })}>
            <p className={`my-2 ${muted}`}>{t("rules.judgedHint")}</p>
            <ul aria-label={t("rules.decidedList")} className="divide-y divide-border rounded-control border border-border">
              {decided.map((e) => (
                <RuleCard key={e.id} entry={e} applied={applied} token={token} />
              ))}
            </ul>
          </Disclosure>
        )}
        {v.applied !== null && <Applied applied={v.applied} token={token} collapsed={waiting.length > 0} />}
        {v.retired && <Retired retired={v.retired} />}
        {v.improve && <Improve view={v.improve} />}
      </div>
    </div>
  );
}

/**
 * Run now: posts to POST /api/v1/improve/run and shows the queued run_id, or the refusal and the run already queued
 * (409). The rules are reloaded only after a run was queued, so a refusal never reads as one.
 */
function RunNow({ token }: { token: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await postImproveRun(token);
      if (r.ok) {
        setResult({ ok: true, text: t("rules.runNowQueued", { run_id: r.run_id }) });
        await client.invalidateQueries({ queryKey: [API.rules] });
      } else {
        setResult({ ok: false, text: r.run_id === null ? r.error : t("rules.runNowRefused", { error: r.error, run_id: r.run_id }) });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-run-now className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run()}>
          {t("rules.runNow")}
        </Button>
        <span className={muted}>{t("rules.runNowHint")}</span>
      </div>
      {result !== null && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
    </div>
  );
}

/** One failure group: its error code and runs, its detail, its draft (cause and fix, or a note) and its filing. */
function ImproveGroup({ g }: { g: ImproveGroupView }) {
  return (
    <li data-improve-group={g.error_code} className="min-w-0 space-y-1 px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm break-all">{g.error_code}</span>
        <span className="text-xs text-text-2 tabular-nums">{t("rules.improveRuns")}: {g.runs}</span>
      </p>
      {g.detail !== null && <p className={`${line} text-text-2`}>{g.detail}</p>}
      <KeyValue
        items={[
          {
            key: "draft",
            term: <span className="font-semibold">{t("rules.improveDraft")}</span>,
            valueProps: { "data-draft": true },
            value: (
              <div className="space-y-0.5">
                {g.draft === null && <p className={muted}>{t("rules.improveNoDraft")}</p>}
                {g.draft?.cause != null && <p className={line}>{t("rules.improveCause", { cause: g.draft.cause })}</p>}
                {g.draft?.fix != null && <p className={line}>{t("rules.improveFix", { fix: g.draft.fix })}</p>}
                {g.draft?.note != null && <p className={line}>{g.draft.note}</p>}
              </div>
            ),
          },
          { key: "filing", term: <span className="font-semibold">{t("rules.improveFiling")}</span>, valueProps: { "data-filing": true }, value: <span className={g.filing === null ? muted : line}>{g.filing ?? t("rules.improveNotFiled")}</span> },
        ]}
      />
    </li>
  );
}

/** The latest improve report and, for a viewer who may run one, Run now. */
function Improve({ view }: { view: ImproveView }) {
  const r = view.report;
  return (
    <div id="improve" data-improve>
      <Card title={t("rules.improveTitle")} count={r?.groups.length}>
        <div className="space-y-2">
          {r === null ? (
            <p className={muted}>{t("rules.improveNone")}</p>
          ) : (
            <>
              <p data-improve-window className={`${muted} tabular-nums`}>
                {t("rules.improveWindow", {
                  start: r.window_start, end: r.window_end, created: r.created_at, groups: r.groups.length, runs: r.runs, patterns: r.patterns,
                })}
              </p>
              {r.groups.length === 0 ? (
                <p className={muted}>{t("rules.improveNoGroup")}</p>
              ) : (
                <ul aria-label={t("rules.improveTitle")} className="divide-y divide-border rounded-control border border-border">
                  {r.groups.map((g, i) => <ImproveGroup key={`${g.error_code}${i}`} g={g} />)}
                </ul>
              )}
            </>
          )}
          {view.run_now && view.csrf_token !== null && <RunNow token={view.csrf_token} />}
        </div>
      </Card>
    </div>
  );
}
