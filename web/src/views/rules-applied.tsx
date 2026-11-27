import { Archive, FileSearch, Pencil } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { type RulesView, type AppliedRule, useRuleEntry } from "../api.js";
import { Dialog } from "../components/ui/dialog.js";
import { Badge } from "../components/ui/badge.js";
import { SUB_TITLE } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Input } from "../components/ui/input.js";
import { KeyValue, type KeyValueItem, ValueBlock } from "../components/ui/key-value.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { Markdown } from "../components/ui/markdown.js";
import { OverflowMenu, Tooltip } from "../components/ui/menu.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { localShortDate } from "../lib/format.js";
import { EntryDetail } from "./rules-detail.js";
import { EditDialog, RetireDialog } from "./rules-verdict.js";
import { LIST, ROW_PAD, STACK_NARROW, muted, ruleName } from "./rules-shared.js";
import type { ReactNode } from "react";


// The Rules page's applied rules, inside its In effect section (since 2026-11-22): the promoted rules file in the file's
// order, one two-line ListRow per rule (its plain sentence, the rule name else its default, with its ID in a tooltip, then one
// muted line "<scope> · Seen N times (Mon D)" with the incident IDs in its tooltip, starting at the row's left edge (no blank switch column, 2026-11-27); the "Suggested to retire" badge; a ⋯ menu with
// Edit, Open evidence and Retire) whose Details hold a label/value list (stacked below `sm`; each default and exception
// line on its own line) with the default, exception and judged date. A search over ID, name, default and scope sits above the
// rows; Suggest sits at the right of the In effect card's title (rules.tsx). An unparsable block's raw text is behind Details too. Scope and the
// encoded-elsewhere lines render through Markdown.

/** One label and its value in an applied rule's details (a KeyValue item); no value reads "not given". */
const part = (key: string, label: MessageKey, value: ReactNode): KeyValueItem => ({
  key,
  term: <span className="font-semibold">{t(label)}</span>,
  value: value ?? <span className="text-sm text-text-2">{t("rules.notGiven")}</span>,
});

/** A text part through Markdown, each of its lines (a repeated 기본값 or 예외 line) on its own line; nothing when the rule has none. */
const md = (value: string | null): ReactNode =>
  value === null || value === "" ? null : (
    <div data-lines className="space-y-1">
      {value.split("\n").map((l, i) => <Markdown key={i} text={l} />)}
    </div>
  );

/** The day an incident ID starts with (T-YYYYMMDD…) as a local time, so no time zone shifts it; null for any other ID. */
const incidentDay = (id: string): string | null => {
  const m = /^T-(\d{4})(\d{2})(\d{2})/.exec(id);
  return m === null ? null : `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
};

/**
 * How often the rule was seen: "Seen N times (Mon D)", N its incidents counted once each and the date the latest
 * incident's day; no date when no ID carries one. The incident IDs sit only in the tooltip. Nothing when it lists none.
 */
function seenLabel(incidents: string[] | null): ReactNode {
  if (incidents === null || incidents.length === 0) return null;
  const ids = [...new Set(incidents)];
  const count = ids.length;
  const last = ids.map(incidentDay).filter((d) => d !== null).sort().at(-1);
  const label =
    last === undefined
      ? t(count === 1 ? "rules.seenOne" : "rules.seen", { count })
      : t(count === 1 ? "rules.seenOneOn" : "rules.seenOn", { count, date: localShortDate(last) });
  return (
    <span data-seen className={`[&_button]:text-xs`}>
      <IdDetails label={label} id={ids.join(", ")} what="incident IDs" />
    </span>
  );
}

/** One promoted block: its sentence and parts; an unparsable block says so, its raw text behind Details. */
function AppliedCard({ rule, token, round, applied }: { rule: AppliedRule; token: string | null; round: number; applied: AppliedRule[] }) {
  if (rule.raw !== null || rule.id === null) {
    return (
      <ListRow data-applied-raw className={ROW_PAD} title={<p className={`${ROW_TITLE} font-medium`}>{t("rules.appliedRaw")}</p>}>
        <Disclosure summary={t("rules.appliedDetails")}>
          <ValueBlock>{rule.raw}</ValueBlock>
        </Disclosure>
      </ListRow>
    );
  }
  return <AppliedClass rule={rule} id={rule.id} token={token} round={round} applied={applied} />;
}

/** Open evidence: the waiting entry's detail (why, evidence with each incident's quote, where it applies), read-only, titled with the rule's name. */
function EvidenceDialog({ id, title, applied, returnFocusTo, onClose }: { id: string; title: string; applied: AppliedRule[]; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  return (
    <Dialog title={t("rules.evidenceTitle", { title })} confirmLabel={t("rules.evidenceDone")} onConfirm={onClose} onClose={onClose} returnFocusTo={returnFocusTo}>
      <EntryDetail entry={{ id, title }} applied={applied} />
    </Dialog>
  );
}

/**
 * An applied class as a compact row: ID, name, scope and judged date, the "Suggested to retire" badge with its reasons
 * once Suggest was pressed (`round` > 0), and its ⋯ menu: Edit (the three-field dialog), Open evidence (read-only) and
 * Retire (the reason dialog). Edit and Retire are off for anyone but the owner (no `token`), and the menu says why;
 * its details open under the row as a label/value list.
 */
function AppliedClass({ rule, id, token, round, applied }: { rule: AppliedRule; id: string; token: string | null; round: number; applied: AppliedRule[] }) {
  const [open, setOpen] = useState<"edit" | "evidence" | "retire" | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu item that opened the dialog is gone when it closes: focus goes back to the ⋯ button.
  const menuButton = { get current() { return menu.current?.querySelector<HTMLElement>("button[aria-haspopup]") ?? null; } };
  const suggested = useRuleEntry(id, round > 0, round).data?.retire ?? [];
  const name = ruleName(rule);
  const owner = token !== null;
  const items = [
    { label: t("rules.edit"), icon: Pencil, action: "edit", disabled: !owner, onSelect: () => setOpen("edit") },
    { label: t("rules.openEvidence"), icon: FileSearch, action: "evidence", onSelect: () => setOpen("evidence") },
    { label: t("rules.retire"), icon: Archive, action: "retire", danger: true, disabled: !owner, onSelect: () => setOpen("retire") },
  ];
  // One muted line: "<scope> · Seen 3 times (Oct 17)"; either part alone when the other is missing.
  const scope = rule.scope === null || rule.scope === "" ? null : rule.scope.replace(/\s*\n\s*/g, " ");
  const seen = seenLabel(rule.incidents);
  const meta = scope === null && seen === null ? null : <>{scope}{scope !== null && seen !== null && " · "}{seen}</>;
  const overflow = <OverflowMenu label={t("rules.appliedActions", { name })} items={items} />;
  const close = () => setOpen(null);
  return (
    <ListRow
      data-applied={id}
      className={ROW_PAD}
      title={
        // The name is the rules file's text as written, so it may quote a snake_case name (`data-raw`).
        <p data-raw className={`${ROW_TITLE} font-medium`} title={name}>
          <IdDetails label={name} id={id} what="rule ID" />
        </p>
      }
      details={
        <>
          {meta !== null && <span data-rule-meta className="min-w-0 break-keep">{meta}</span>}
          {suggested.length > 0 && <Badge level="needs_approval">{t("rules.suggested")}</Badge>}
        </>
      }
      menu={
        // For anyone but the owner Edit and Retire are off, and the menu's tooltip says why; Open evidence stays on.
        <div ref={menu}>
          {owner ? overflow : <Tooltip text={t("rules.appliedOwner")} align="end">{overflow}</Tooltip>}
        </div>
      }
    >
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
        <KeyValue
          className={`mt-2 ${STACK_NARROW}`}
          items={[
            part("default", "rules.appliedDefault", md(rule.default)),
            part("exception", "rules.appliedException", md(rule.exceptions)),
            part("judged", "rules.appliedJudged", rule.judged === null ? null : <p className="text-sm">{rule.judged}</p>),
          ]}
        />
      </Disclosure>
      {open === "edit" && token !== null && <EditDialog rule={rule} id={id} token={token} returnFocusTo={menuButton} onClose={close} />}
      {open === "evidence" && <EvidenceDialog id={id} title={name} applied={applied} returnFocusTo={menuButton} onClose={close} />}
      {open === "retire" && token !== null && <RetireDialog id={id} name={name} token={token} returnFocusTo={menuButton} onClose={close} />}
    </ListRow>
  );
}

/** Whether a rule matches the search: its ID, name, default and scope (or its raw text), case-insensitively. */
const matches = (r: AppliedRule, query: string): boolean =>
  [r.id, r.name, r.default, r.scope, r.raw].some((v) => v !== null && v.toLowerCase().includes(query));

/** Whether the applied rules get the search and Suggest: some rule parsed with an ID. */
export const hasAppliedTools = (applied: RulesView["applied"]): boolean => (applied?.rules ?? []).some((r) => r.raw === null && r.id !== null);

/** The search over the applied rules: a page filter, so the Rules page renders it in its PageToolbar's second row. */
export function AppliedSearch({ value, onChange }: { value: string; onChange: (query: string) => void }) {
  return <Input type="search" aria-label={t("rules.appliedSearch")} placeholder={t("rules.appliedSearch")} className="w-full sm:max-w-sm" value={value} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * The applied rules inside In effect: the promoted rules in the file's order (narrowed by `query`, the toolbar's
 * search), then the encoded-elsewhere lines. Nothing when the file has none. `before` (the standing rules' rows) leads
 * the same list. `round` is the page's Suggest count (Suggest sits in the card's title line); each press is a new round of reads.
 */
export function Applied({ applied, token, before, query, round }: { applied: NonNullable<RulesView["applied"]>; token: string | null; before?: ReactNode; query: string; round: number }) {
  const { rules, elsewhere } = applied;
  if (rules.length === 0 && elsewhere.length === 0) return before ? <ul aria-label={t("rules.inEffect")} className={LIST}>{before}</ul> : null;
  const q = query.trim().toLowerCase();
  const shown = rules.filter((r) => matches(r, q));
  return (
    <div className="space-y-2">
      {(before || shown.length > 0) && (
        <ul aria-label={t("rules.inEffect")} className={LIST}>
          {before}
          {shown.map((r, i) => (
            <AppliedCard key={r.id ?? `raw${i}`} rule={r} token={token} round={round} applied={rules} />
          ))}
        </ul>
      )}
      {rules.length > 0 && shown.length === 0 && <p className={muted}>{t("rules.appliedNone")}</p>}
      {elsewhere.length > 0 && (
        <div data-elsewhere className="space-y-1">
          <h3 className={SUB_TITLE}>{t("rules.elsewhere")}</h3>
          <Markdown text={elsewhere.join("\n")} />
        </div>
      )}
    </div>
  );
}
