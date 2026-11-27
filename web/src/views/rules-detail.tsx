import { type ReactNode, useState } from "react";
import { type AppliedRule, type RuleDetail, type RuleEvidence, type RuleRow, useRuleEntry } from "../api.js";
import { Clamp } from "../components/ui/clamp.js";
import { Button } from "../components/ui/button.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { SUB_TITLE } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
import { Markdown } from "../components/ui/markdown.js";
import { Loading } from "../components/ui/parts.js";
import { Notice } from "../components/ui/notice.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { fileLines, line, proposalLine, quote, ruleName } from "./rules-shared.js";

// The Rules page's entry detail, read on demand through GET /api/v1/rules/entry?id= and never on page load, in one
// reading order (ReadingOrder, 2026-11-20): what to promote, why (the root reason's first sentence), examples (each
// evidence ID with its date and one line; newest first, 3 shown, the rest behind "Show all N"), the status of what it
// cites (`cited`), where it applies and the related applied rules (sharing an incident ID or naming the target file);
// the long fields in one closed Disclosure. Each part is left out when it has nothing. The card's disclosure, the verdict
// dialogs and an applied rule's Open evidence dialog all show it through EntryDetail, which takes an ID and a title
// (and a waiting entry's kind, target and draft when it has them).

/** What the detail needs of an entry: its ID and title, and a waiting entry's kind, target and draft when it has them. */
export type DetailEntry = Pick<RuleRow, "id" | "title"> & Partial<Pick<RuleRow, "kind" | "target" | "draft">>;

/** One part of the detail: its label, then its lines; nothing at all when it has none. */
function DetailPart({ label, part, children }: { label: MessageKey; part: string; children: ReactNode[] }) {
  const lines = children.filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div data-detail-part={part} className="space-y-1">
      <h3 className={SUB_TITLE}>{t(label)}</h3>
      {lines}
    </div>
  );
}

/** How many examples show before "Show all N". */
const EVIDENCE_SHOWN = 3;

/** An example's one line: the owner's quote, else the agent's proposal, else the root reason (owner answer 2). */
const exampleText = (e: RuleEvidence): string | undefined => e.quote ?? e.proposal ?? e.root_reason;

/** The first sentence of `text` (up to its first `.`, `!`, `?` or `。` followed by a space or the end); all of it when it has none. */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?。](?=\s|$)/.exec(text.trim());
  return m === null ? text.trim() : m[0];
}

/** The examples, newest first, each with its ID, date and one line: the first EVIDENCE_SHOWN, the rest behind "Show all N". */
function Examples({ items }: { items: RuleEvidence[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, EVIDENCE_SHOWN);
  return (
    <DetailPart label="rules.detailExamples" part="examples">
      {[
        <ol key="list" className="space-y-2">
          {shown.map((e, i) => {
            const said = exampleText(e);
            return (
              <li key={`${e.ref ?? ""}${i}`} data-evidence={e.ref ?? ""} className="min-w-0 space-y-0.5">
                {(e.ref !== undefined || e.date !== undefined) && (
                  <p className="flex flex-wrap gap-x-2 text-xs text-text-2">
                    {e.ref !== undefined && <span className="font-mono break-all">{e.ref}</span>}
                    {e.date !== undefined && <span data-evidence-date className="tabular-nums">{e.date}</span>}
                  </p>
                )}
                {said !== undefined && (
                  <Clamp data-example-text className={quote}>
                    {said}
                  </Clamp>
                )}
              </li>
            );
          })}
        </ol>,
        !all && items.length > EVIDENCE_SHOWN && (
          <Button key="all" variant="ghost" size="sm" flush onClick={() => setAll(true)}>
            {t("rules.showAll", { count: items.length })}
          </Button>
        ),
      ]}
    </DetailPart>
  );
}

/** The applied rules that share an incident ID with the entry or name its target file. */
function related(applied: AppliedRule[], ids: ReadonlySet<string>, target: string | undefined): AppliedRule[] {
  return applied.filter(
    (r) => (r.incidents ?? []).some((i) => ids.has(i)) || (target !== undefined && target !== "" && [r.name, r.default, r.exceptions, r.scope, r.raw].some((v) => v?.includes(target))),
  );
}

/**
 * One entry's reading order, shared by the card and the verdict dialog (2026-11-20): 1 what to promote (the change in
 * one or two lines, a proposal's prose change, a class's rule, and the files it touches), 2 why (how often, and the
 * root reason's first sentence), 3 examples, 4 the status of what it cites (`cited`: each evidence ID's ledger verdict,
 * none when unrecorded); then where it applies and the related applied rules. A part with nothing to show is left out.
 * The long fields (the whole rationale and a proposal's Now and Proposed lines) sit in one Disclosure under them.
 */
function ReadingOrder({ entry, d, cited, applied }: { entry: DetailEntry; d: RuleDetail; cited: Record<string, string>; applied: AppliedRule[] }) {
  const kind = d.kind ?? entry.kind;
  const target = d.target ?? entry.target;
  const rule = d.default ?? entry.draft?.default;
  const exception = d.exceptions ?? entry.draft?.exception;
  const evidence = d.evidence ?? [];
  const refs = [...new Set(evidence.flatMap((e) => (e.ref === undefined ? [] : [e.ref])))];
  const ids = new Set([...refs, ...(entry.draft?.incidents ?? [])]);
  const overlaps = related(applied, ids, target);
  const statuses = refs.filter((r) => cited[r] !== undefined);
  const why = d.root_reason === undefined ? undefined : firstSentence(d.root_reason);
  const longReason = d.root_reason !== undefined && d.root_reason.trim() !== why;
  return (
    <div data-rule-detail className="min-w-0 space-y-3 rounded-control bg-surface-2 p-3">
      <DetailPart label="rules.detailWhat" part="what">
        {[
          d.description !== undefined && <Clamp key="desc" data-detail-description className={line}>{d.description}</Clamp>,
          d.change !== undefined && <p key="change" data-detail-change className={line}>{d.change}</p>,
          rule !== undefined && <p key="rule" className={line}>{t("rules.whatRule", { rule })}</p>,
          exception !== undefined && <p key="except" className={line}>{t("rules.whatExcept", { exceptions: exception })}</p>,
          kind !== undefined && <p key="kind" className={line}>{proposalLine(kind, target)}</p>,
          target !== undefined && <p key="target" className={`${line} font-mono`}>{t("rules.whatTarget", { target })}</p>,
        ]}
      </DetailPart>
      <DetailPart label="rules.detailWhy" part="why">
        {[
          d.incidents !== undefined && <p key="count" className={line}>{d.incidents === 1 ? t("rules.detailOnce") : t("rules.detailCount", { count: d.incidents })}</p>,
          why !== undefined && <p key="root" className={line}>{t("rules.detailRoot", { reason: why })}</p>,
        ]}
      </DetailPart>
      {evidence.length > 0 && <Examples items={evidence} />}
      <DetailPart label="rules.detailStatus" part="status">
        {[
          statuses.length > 0 && (
            <ul key="list" className="space-y-0.5">
              {statuses.map((r) => (
                <li key={r} data-cited={r} className={line}>{t("rules.citedVerdict", { id: r, decision: cited[r]! })}</li>
              ))}
            </ul>
          ),
        ]}
      </DetailPart>
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
      {(longReason || d.current !== undefined || d.proposed !== undefined) && (
        <Disclosure data-detail-long summary={t("rules.detailLong")}>
          <div className="mt-2 space-y-1">
            {longReason && <p data-rationale className={line}>{t("rules.detailRationale", { reason: d.root_reason! })}</p>}
            {d.current !== undefined && <p className="text-xs text-text-2">{t("rules.changeNow")}</p>}
            {d.current !== undefined && <pre data-change="current" className={fileLines}>{d.current}</pre>}
            {d.proposed !== undefined && <p className="text-xs text-text-2">{t("rules.changeProposed")}</p>}
            {d.proposed !== undefined && <pre data-change="proposed" className={fileLines}>{d.proposed}</pre>}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** The detail, read once when the card opens; "could not be read" when the ledger gave none or failed. */
export function EntryDetail({ entry, applied }: { entry: DetailEntry; applied: AppliedRule[] }) {
  const q = useRuleEntry(entry.id, true);
  if (q.isPending) return <Loading rows={2} label="loading.ruleDetail" onRetry={() => void q.refetch()} />;
  const d = q.data?.detail ?? null;
  if (d !== null) return <ReadingOrder entry={entry} d={d} cited={q.data?.cited ?? {}} applied={applied} />;
  return (
    <div data-rule-detail>
      <Notice tone="info">{t("rules.detailUnread")}</Notice>
    </div>
  );
}
