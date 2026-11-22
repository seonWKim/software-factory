import { type ReactNode, useState } from "react";
import { type AppliedRule, type RuleDetail, type RuleEvidence, type RuleRow, useRuleEntry } from "../api.js";
import { Button } from "../components/ui/button.js";
import { IdDetails } from "../components/ui/copy.js";
import { Markdown } from "../components/ui/markdown.js";
import { Loading } from "../components/ui/parts.js";
import { Notice } from "../components/ui/notice.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { fileLines, isClass, line, muted, proposalLine, quote, ruleName } from "./rules-shared.js";

// The Rules page's entry detail, read on demand through GET /api/v1/rules/entry?id= and never on page load: a
// description, what it would change, before → after, why, the evidence (newest first, 3 shown, the rest behind
// "Show all N"), where it applies and the related applied rules (sharing an incident ID or naming the target file).
// Each part is left out when it has nothing; only "what" says "not given". The card's disclosure, the verdict
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
      <h3 className="text-xs font-semibold text-text-2">{t(label)}</h3>
      {lines}
    </div>
  );
}

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

/** The applied rules that share an incident ID with the entry or name its target file. */
function related(applied: AppliedRule[], ids: ReadonlySet<string>, target: string | undefined): AppliedRule[] {
  return applied.filter(
    (r) => (r.incidents ?? []).some((i) => ids.has(i)) || (target !== undefined && target !== "" && [r.name, r.default, r.exceptions, r.scope, r.raw].some((v) => v?.includes(target))),
  );
}

/**
 * The detail in its order: a description, what it would change (a proposal's kind, target and prose change), before → after, why,
 * the evidence, where it applies, and the related applied rules. A part with nothing to show is left out; only "what"
 * says "not given".
 */
function Detail({ entry, d, applied }: { entry: DetailEntry; d: RuleDetail; applied: AppliedRule[] }) {
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
          {kind === undefined && target === undefined && d.change === undefined
            ? [<p key="none" className={muted}>{t("rules.notGiven")}</p>]
            : [
              kind !== undefined && <p key="kind" className={line}>{t("rules.whatKind", { kind: proposalLine(kind, target) })}</p>,
              target !== undefined && <p key="target" className={`${line} font-mono`}>{t("rules.whatTarget", { target })}</p>,
              d.change !== undefined && <p key="change" data-detail-change className={line}>{d.change}</p>,
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
export function EntryDetail({ entry, applied }: { entry: DetailEntry; applied: AppliedRule[] }) {
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
