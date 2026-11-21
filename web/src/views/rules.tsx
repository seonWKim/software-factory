import { ScrollText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { API, type AppliedRule, type RetiredRule, type RuleRow, type RuleVerdict, type RulesView, postSettings, useApi } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
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
import { Improve } from "./rules-improve.js";
import { GROUPS, PAGE_WIDTH, STATE_LABEL, STATE_LEVEL, VERDICTS, isClass, line, muted } from "./rules-shared.js";
import { VerdictDialog } from "./rules-verdict.js";
import { ApprovalsSection } from "./standing.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571), under one PageHeader that says what
// the page is for and how many entries wait, at most max-w-3xl wide, with a "How this works" disclosure. Only entries
// the ledger has not judged (judged null) wait: they are counted and shown in two groups, rule candidates (`C-…`) and
// structure proposals (`P-…`), each under one line saying what promoting one does; judged ones collapse into one
// "N decided" line, and with none waiting an EmptyState gives the next step. A card lists its title (an IdDetails: the ID in its tooltip) and a Badge
// (open, pending, held, or the judged decision), with "Why and where" (a Disclosure) opening the entry's detail
// (rules-detail.tsx).
// Promote (first, off with its reason in the row when the draft could not be read), Hold and Reject (danger, last) are the
// items of the row's ⋯ menu; each opens a dialog (rules-verdict.tsx). Only the owner sends.
// With the ledger off the page is an EmptyState whose action is Turn on (stores `integrations`,
// the plugin name only, through POST /api/v1/settings, then loads the rules), and an agents home picker over the
// known homes (AGENTS_HOME when set, ~/.agents) shows the chosen one's check: both CLIs executable, else the missing file.
// Below the cards come the applied rules (rules-applied.tsx) and then a collapsed Retired list.
// One card per entry at every width, so no table turns into cards.
// Approvals (standing.tsx, moved from Settings 2026-11-16) sit under the "How this works" line: the pending standing-approval
// proposals and the standing rules, each part hidden when it has no items and the whole heading when both are empty.
// The improve report (rules-improve.tsx) sits below the rules, and above the EmptyState with the ledger off.

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
      {excerpt !== undefined && <ExcerptBlock excerpt={excerpt} />}
      <Disclosure lazy summary={t("rules.showDetail")}>
        <EntryDetail entry={entry} applied={applied} />
      </Disclosure>
      {entry.judged === null && entry.draft_error !== null && (
        <p data-draft-error className="text-xs text-pretty break-words text-pill-bad-fg">
          {t("rules.draftError", { error: entry.draft_error })}
        </p>
      )}
      {token !== null && entry.judged === null && (
        <div ref={menu} className="pt-1">
          <OverflowMenu
            label={t("rules.actions", { title: entry.title })}
            items={VERDICTS.map((v) => ({
              label: t(v.label), action: v.verdict, danger: v.variant === "danger", disabled: v.verdict === "promote" && noDraft, onSelect: () => setOpen(v.verdict),
            }))}
          />
        </div>
      )}
      {open !== null && token !== null && <VerdictDialog entry={entry} applied={applied} verdict={open} token={token} returnFocusTo={menuButton} onClose={() => setOpen(null)} />}
    </li>
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
                    <RuleCard key={e.id} entry={e} excerpt={(v as RulesView & { excerpts?: Record<string, Excerpt> }).excerpts?.[e.id]} applied={applied} token={token} />
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
