import { ScrollText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { API, type AppliedRule, type RetiredRule, type RuleRow, type RuleVerdict, type RulesView, postSettings, useApi } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { Tabs } from "../components/ui/tabs.js";
import { useUrlParam } from "../lib/url-param.js";
import { announceStatus } from "../components/ui/dialog.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { EmptyState, Notice, PageHeader } from "../components/ui/notice.js";
import { ValueBlock } from "../components/ui/key-value.js";
import { t } from "../i18n/index.js";
import { AgentsHomePicker } from "./agents-home-picker.js";
import { Applied } from "./rules-applied.js";
import { EntryDetail } from "./rules-detail.js";
import { GROUPS, PAGE_WIDTH, PROSE, ROW_PAD, STATE_LABEL, STATE_LEVEL, VERDICTS, isClass, muted } from "./rules-shared.js";
import { VerdictDialog } from "./rules-verdict.js";
import { ApprovalsSection } from "./standing.js";

// The Rules page (design 09-dashboard-rules.md, issue #571; tabs since 2026-11-21, wi_d485260a): one PageHeader that
// says what the page is for, with the waiting count as a Badge beside the title, then shared Tabs ("Rules"): Waiting
// (selected on load), Applied and Retired, in a max-w-5xl column (description prose stays max-w-3xl).
// Waiting: a "How this works" disclosure, then only the entries the ledger has not judged (judged null), in two groups,
// rule candidates (`C-…`) and structure proposals (`P-…`), each under one line saying what promoting one does; judged
// ones collapse into one "N decided" line, and with none waiting an EmptyState gives the next step. Each entry is a
// ListRow: its title (an IdDetails: the ID in its tooltip), a details line (its Badge and what it would change), the
// before and after excerpt, "Why and where" (a Disclosure with the entry's detail, rules-detail.tsx), and one ⋯ menu
// holding Promote (off, with its reason in the row, when the draft could not be read), Hold and Reject (danger, last);
// each opens a dialog (rules-verdict.tsx). Only the owner sends. Auto-approve specs (standing.tsx) sits below the
// waiting list. Applied (rules-applied.tsx) and Retired are their own tabs. The improve report is a tab on Health.
// With the ledger off the page is an EmptyState whose action is Turn on (stores `integrations`,
// the plugin name only, through POST /api/v1/settings, then loads the rules), and an agents home picker over the
// known homes (AGENTS_HOME when set, ~/.agents) shows the chosen one's check: both CLIs executable, else the missing file.

/** A proposal's kind and target as one line; a part the ledger did not list reads "not given". */
const proposalLine = (kind: string | undefined, target: string | undefined): string =>
  t("rules.whatProposal", { kind: kind ?? t("rules.notGiven"), target: target === undefined ? t("rules.notGiven") : shortName(target) });

/** A target's file name: its last path segment ("bin/evolve" is "evolve"); the full path stays in the detail. */
const shortName = (target: string): string => target.split("/").filter(Boolean).pop() ?? target;

/** A waiting proposal's first changed lines, by ID, from `GET /api/v1/rules`; a side the ledger did not give is absent. */
type Excerpt = { before?: string; after?: string };

/** A proposal's before and after lines, read without opening anything. */
function ExcerptBlock({ excerpt }: { excerpt: Excerpt }) {
  const sides = ([["before", "rules.before"], ["after", "rules.after"]] as const).filter(([k]) => excerpt[k] !== undefined);
  return (
    <div data-rule-excerpt className="grid gap-2 sm:grid-cols-2">
      {sides.map(([k, label]) => (
        <div key={k} data-excerpt={k} className="min-w-0 space-y-1">
          <h3 className="text-xs font-semibold text-text-2">{t(label)}</h3>
          <ValueBlock>{excerpt[k]}</ValueBlock>
        </div>
      ))}
    </div>
  );
}

function RuleCard({ entry, excerpt, applied, token }: { entry: RuleRow; excerpt?: Excerpt | undefined; applied: AppliedRule[]; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu item that opened a dialog is gone when it closes: focus goes back to the menu's ⋯ button.
  const menuButton = { get current() { return menu.current?.querySelector<HTMLElement>("button[aria-haspopup]") ?? null; } };
  const noDraft = isClass(entry.id) && entry.draft === null;
  const badge = entry.judged !== null ? (
    <span data-judged>
      <Badge level="ready_to_merge">{t("rules.judged", { decision: entry.judged })}</Badge>
    </span>
  ) : (
    <Badge level={STATE_LEVEL[entry.state]}>{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]!) : entry.state}</Badge>
  );
  return (
    <ListRow
      data-rule={entry.id}
      className={ROW_PAD}
      title={
        <p data-rule-title className={`${ROW_TITLE} font-medium`} title={entry.title}>
          <IdDetails label={entry.title} id={entry.id} what="rule ID" />
        </p>
      }
      details={
        <>
          {badge}
          {!isClass(entry.id) && (
            <span data-rule-what className="min-w-0 break-keep">
              {proposalLine(entry.kind, entry.target)}
            </span>
          )}
        </>
      }
      menu={
        token !== null && entry.judged === null && (
          <div ref={menu}>
            <OverflowMenu
              label={t("rules.actions", { title: entry.title })}
              items={VERDICTS.map((v) => ({
                label: t(v.label), action: v.verdict, danger: v.variant === "danger", disabled: v.verdict === "promote" && noDraft, onSelect: () => setOpen(v.verdict),
              }))}
            />
          </div>
        )
      }
    >
      {excerpt !== undefined && <ExcerptBlock excerpt={excerpt} />}
      <Disclosure lazy summary={t("rules.showDetail")}>
        <EntryDetail entry={entry} applied={applied} />
      </Disclosure>
      {entry.judged === null && entry.draft_error !== null && (
        <p data-draft-error className="text-xs text-pretty break-words break-keep text-pill-bad-fg">
          {t("rules.draftError", { error: entry.draft_error })}
        </p>
      )}
      {open !== null && token !== null && <VerdictDialog entry={entry} applied={applied} verdict={open} token={token} returnFocusTo={menuButton} onClose={() => setOpen(null)} />}
    </ListRow>
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
      {view.home !== null && <AgentsHomePicker home={view.home} />}
      {view.judge !== null && <Notice tone="warn">{view.judge}</Notice>}
      {error !== null && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

/** The Retired tab: the ledger's retired classes, newest first, with reason and date; an EmptyState when there are none. */
function Retired({ retired }: { retired: RetiredRule[] }) {
  if (retired.length === 0) return <EmptyState title={t("rules.retiredNone")} />;
  return (
    <Card title={t("rules.groupRetired")} count={retired.length}>
      <ul data-retired aria-label={t("rules.groupRetired")} className="divide-y divide-border rounded-control border border-border">
        {retired.map((r) => (
          <ListRow
            key={r.id}
            data-retired-rule={r.id}
            className={ROW_PAD}
            title={<p className={`${ROW_TITLE} font-medium`}><IdDetails label={t("rules.retiredRule")} id={r.id} what="rule ID" /></p>}
            details={<span className="min-w-0 break-keep">{t("rules.retiredOn", { date: r.date, reason: r.reason })}</span>}
          />
        ))}
      </ul>
    </Card>
  );
}

type RulesTab = "waiting" | "applied" | "retired";
const TABS: readonly { id: RulesTab; label: "rules.tabWaiting" | "rules.tabApplied" | "rules.tabRetired" }[] = [
  { id: "waiting", label: "rules.tabWaiting" },
  { id: "applied", label: "rules.tabApplied" },
  { id: "retired", label: "rules.tabRetired" },
];

export function RulesPage() {
  const rules = useApi<RulesView>(API.rules);
  const [picked, pick] = useUrlParam("tab", (v) => TABS.some((o) => o.id === v));
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
  const tab: RulesTab = (picked as RulesTab | null) ?? "waiting";
  return (
    <div className={`${PAGE_WIDTH} space-y-4`}>
      <PageHeader
        title={title}
        badge={<span data-waiting><Badge level={waiting.length > 0 ? "needs_approval" : undefined}>{t("rules.waiting", { count: waiting.length })}</Badge></span>}
        description={t("rules.pageDescription")}
      />
      <Tabs label={t("rules.tabs")} options={TABS.map((o) => ({ id: o.id, label: t(o.label) }))} value={tab} onChange={pick} />
      {v.judge !== null && <Notice tone="warn">{t("rules.readOnly")}{v.judge}</Notice>}
      {v.error !== null && <Notice tone="bad">{v.error}</Notice>}
      {tab === "waiting" && (
        <div data-tab="waiting">
          {waiting.length === 0 && v.error === null && <EmptyState icon={ScrollText} title={t("rules.emptyTitle")} description={t("rules.empty")} />}
          {GROUPS.map((g) => {
            const entries = waiting.filter((e) => isClass(e.id) === g.classes);
            return (
              entries.length > 0 && (
                <Card key={g.title} title={t(g.title)} count={entries.length}>
                  <p data-group-line className={`mb-2 ${PROSE} ${muted}`}>
                    {t(g.line)}
                  </p>
                  <ul aria-label={t(g.title)} className="divide-y divide-border rounded-control border border-border">
                    {entries.map((e) => (
                      <RuleCard key={e.id} entry={e} excerpt={(v as RulesView & { excerpts?: Record<string, Excerpt> }).excerpts?.[e.id]} applied={applied} token={token} />
                    ))}
                  </ul>
                </Card>
              )
            );
          })}
          {decided.length > 0 && (
            <Disclosure data-decided className="mt-6" summary={t("rules.decided", { count: decided.length })}>
              <p className={`my-2 ${PROSE} ${muted}`}>{t("rules.judgedHint")}</p>
              <ul aria-label={t("rules.decidedList")} className="divide-y divide-border rounded-control border border-border">
                {decided.map((e) => (
                  <RuleCard key={e.id} entry={e} applied={applied} token={token} />
                ))}
              </ul>
            </Disclosure>
          )}
          <div className="mt-6">
            <ApprovalsSection />
          </div>
          <Disclosure data-how className="mt-6" summary={t("rules.how")}>
            <p className={`mt-2 ${PROSE} ${muted}`}>{t("rules.footer")}</p>
          </Disclosure>
        </div>
      )}
      {tab === "applied" && (v.applied !== null && (v.applied.rules.length > 0 || v.applied.elsewhere.length > 0)
        ? <Applied applied={v.applied} token={token} />
        : <EmptyState title={t("rules.appliedEmpty")} />)}
      {tab === "retired" && <Retired retired={v.retired ?? []} />}
    </div>
  );
}
