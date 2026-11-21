import { useState } from "react";
import { type RulesView, type AppliedRule, useRuleEntry } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Card } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Input } from "../components/ui/input.js";
import { Markdown } from "../components/ui/markdown.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { RetireDialog } from "./rules-verdict.js";
import { muted, ruleName } from "./rules-shared.js";
import type { ReactNode } from "react";

// The Rules page's applied rules group: the promoted rules file in the file's order, one compact row per rule (name
// with its ID in a tooltip, scope, judged date, the "Suggested to retire" badge and Retire) that expands to a
// label/value list, with a search over ID, name, default and scope; it is collapsed while something waits. Suggest
// reads each class's retire suggestions on demand. Scope and the encoded-elsewhere lines render through Markdown.

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
export function Applied({ applied, token, collapsed }: { applied: NonNullable<RulesView["applied"]>; token: string | null; collapsed: boolean }) {
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
