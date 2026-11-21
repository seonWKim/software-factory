import { ScrollText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { API, type AppliedRule, type RetiredRule, type RuleRow, type RuleVerdict, type RulesView, type StandingView, postSettings, useApi } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardSection } from "../components/ui/card.js";
import { IdDetails } from "../components/ui/copy.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { announceStatus } from "../components/ui/dialog.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { EmptyState, Notice, PageHeader } from "../components/ui/notice.js";
import { ValueBlock } from "../components/ui/key-value.js";
import { t } from "../i18n/index.js";
import { AgentsHomePicker } from "./agents-home-picker.js";
import { Applied } from "./rules-applied.js";
import { Pushbacks } from "./rules-pushbacks.js";
import { EntryDetail } from "./rules-detail.js";
import { GROUPS, PAGE_WIDTH, PROSE, ROW_PAD, STATE_LABEL, STATE_LEVEL, VERDICTS, isClass, muted, proposalLine } from "./rules-shared.js";
import { VerdictDialog } from "./rules-verdict.js";
import { ApprovalsSection, StandingProposal, StandingRule } from "./standing.js";

// The Rules page (design 09-dashboard-rules.md, issue #571; two sections since 2026-11-22, the owner's choice over
// tabs): one PageHeader that says what the page is for, with the waiting count as a Badge beside the title, then in a
// max-w-5xl column exactly two sections, "In effect" and "Waiting for you", and one "Details" disclosure at the end.
// In effect: each standing rule that is on (standing.tsx), then the ledger's applied rules (rules-applied.tsx), with a
// search and Suggest. Waiting for you: the pending standing proposals (Accept visible, Decline in ⋯), then the entries
// the ledger has not judged (judged null), candidates (`C-…`) before structure proposals (`P-…`); each is a ListRow
// whose title is an IdDetails (the ID in its tooltip), whose details line has its Badge and, for a proposal, its plain
// kind and file count, with Promote visible (off, with its reason in the row, when the draft could not be read); its
// ⋯ menu lists every verdict, Promote, Hold and Reject (danger, last), so all three are in one place; each opens a dialog (rules-verdict.tsx). Its before and after lines,
// why and where sit behind "Why and where" (rules-detail.tsx). With none waiting an EmptyState gives the next step.
// Details: the improve report link (Health's Improve tab), standing rules that are off, decided entries, the pushbacks
// (rules-pushbacks.tsx, when the ledger lists them), Retired, and How this works. Only the owner sends.
// With the ledger off the page is an EmptyState whose action is Turn on, first, above the standing card (stores `integrations`,
// the plugin name only, through POST /api/v1/settings, then loads the rules), and an agents home picker over the
// known homes (AGENTS_HOME when set, ~/.agents) shows the chosen one's check: both CLIs executable, else the missing file.

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
  const promote = useRef<HTMLButtonElement>(null);
  // Where the dialog started: Promote's own button, or the ⋯ button when a menu item opened it (the item is gone when the menu closes).
  const [from, setFrom] = useState<"button" | "menu">("menu");
  const menuButton = { get current() { return from === "button" ? promote.current : (menu.current?.querySelector<HTMLElement>("button[aria-haspopup]") ?? null); } };
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
                label: t(v.label), action: v.verdict, danger: v.variant === "danger", disabled: v.verdict === "promote" && noDraft, onSelect: () => { setFrom("menu"); setOpen(v.verdict); },
              }))}
            />
          </div>
        )
      }
    >
      {token !== null && entry.judged === null && (
        <ButtonRow>
          <Button ref={promote} size="sm" disabled={noDraft} onClick={() => { setFrom("button"); setOpen("promote"); }}>
            {t("rules.promote")}
          </Button>
        </ButtonRow>
      )}
      <Disclosure lazy summary={t("rules.showDetail")}>
        {excerpt !== undefined && <ExcerptBlock excerpt={excerpt} />}
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

/** The retired classes under Details, newest first, with reason and date; a line when there are none. */
function Retired({ retired }: { retired: RetiredRule[] }) {
  if (retired.length === 0) return <p className={muted}>{t("rules.retiredNone")}</p>;
  return (
    <ul data-retired aria-label={t("rules.groupRetired")} className={LIST}>
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
  );
}

const LIST = "divide-y divide-border rounded-control border border-border";

/** A titled part of the page's Details disclosure: an h3 and its content, not a section of its own. */
function DetailsPart({ title, children, ...rest }: { title: string; children: ReactNode; [data: `data-${string}`]: string | boolean }) {
  return (
    <div className="space-y-2" {...rest}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function RulesPage() {
  const rules = useApi<RulesView>(API.rules);
  const standing = useApi<StandingView>(API.standing);
  const v = rules.data;
  const title = t("page.rules");
  if (rules.isError) return <><PageHeader title={title} /><ErrorNote error={rules.error} /></>;
  if (!v) return <><PageHeader title={title} /><Loading rows={3} /></>;
  if (!v.enabled) {
    return (
      <>
        <PageHeader title={title} />
        <div className={`${PAGE_WIDTH} space-y-4`}>
          <LedgerOff view={v} />
          <ApprovalsSection />
        </div>
      </>
    );
  }
  const token = v.judge === null ? v.csrf_token : null;
  // Only an entry the ledger has not judged waits; a judged one is decided.
  const waiting = v.entries.filter((e) => e.judged === null);
  const decided = v.entries.filter((e) => e.judged !== null);
  const applied = v.applied?.rules ?? [];
  const sv = standing.data;
  const on = sv?.rules.filter((r) => r.enabled) ?? [];
  const off = sv?.rules.filter((r) => !r.enabled) ?? [];
  const proposals = sv?.proposals ?? [];
  const standingToken = sv?.csrf_token ?? null;
  const waitCount = waiting.length + proposals.length;
  const inEffect = on.length + applied.length;
  const excerpts = (v as RulesView & { excerpts?: Record<string, Excerpt> }).excerpts;
  const onRows = on.map((r) => <StandingRule key={r.rule} rule={r} token={standingToken} />);
  return (
    <div className={`${PAGE_WIDTH} space-y-4`}>
      <PageHeader
        title={title}
        badge={<span data-waiting><Badge level={waitCount > 0 ? "needs_approval" : undefined}>{t("rules.waiting", { count: waitCount })}</Badge></span>}
        description={t("rules.pageDescription")}
      />
      {v.judge !== null && <Notice tone="warn">{t("rules.readOnly")}{v.judge}</Notice>}
      {v.error !== null && <Notice tone="bad">{v.error}</Notice>}
      <Card title={t("rules.inEffect")} count={inEffect}>
        {standing.isError && <ErrorNote error={standing.error} />}
        {v.applied !== null && (v.applied.rules.length > 0 || v.applied.elsewhere.length > 0) ? (
          <Applied applied={v.applied} token={token} before={onRows.length > 0 ? onRows : undefined} />
        ) : onRows.length > 0 ? (
          <ul aria-label={t("rules.inEffect")} className={LIST}>{onRows}</ul>
        ) : (
          <p data-in-effect-empty className={muted}>{t("rules.appliedEmpty")}</p>
        )}
      </Card>
      <Card title={t("rules.waitingForYou")} count={waitCount}>
        {waitCount === 0 && v.error === null && <EmptyState icon={ScrollText} title={t("rules.emptyTitle")} description={t("rules.empty")} />}
        {proposals.length > 0 && (
          <CardSection title={t("rules.turnOnProposals")}>
            <ul aria-label={t("rules.turnOnProposals")} className={LIST}>
              {proposals.map((p) => (
                <StandingProposal key={p.id} proposal={p} token={standingToken} />
              ))}
            </ul>
          </CardSection>
        )}
        {GROUPS.map((g) => {
          const entries = waiting.filter((e) => isClass(e.id) === g.classes);
          return (
            entries.length > 0 && (
              <CardSection key={g.title} title={t(g.title)} count={entries.length}>
                <p data-group-line className={`mb-2 ${PROSE} ${muted}`}>
                  {t(g.line)}
                </p>
                <ul aria-label={t(g.title)} className={LIST}>
                  {entries.map((e) => (
                    <RuleCard key={e.id} entry={e} excerpt={excerpts?.[e.id]} applied={applied} token={token} />
                  ))}
                </ul>
              </CardSection>
            )
          );
        })}
      </Card>
      <Disclosure data-page-details className="mt-6" summary={t("rules.details")}>
        <div className="mt-3 space-y-6">
          {v.improve?.report != null && (
            <p data-improve-link className="text-sm">
              <Link href={`${BASE}health?tab=improve`} className={LINK_CLASS}>{t("rules.improveLink")}</Link>
            </p>
          )}
          {off.length > 0 && (
            <DetailsPart title={t("rules.standingOff")} data-standing-off>
              <ul aria-label={t("rules.standingOff")} className={LIST}>
                {off.map((r) => (
                  <StandingRule key={r.rule} rule={r} token={standingToken} />
                ))}
              </ul>
            </DetailsPart>
          )}
          {decided.length > 0 && (
            <DetailsPart title={t("rules.decided", { count: decided.length })} data-decided>
              <p className={`${PROSE} ${muted}`}>{t("rules.judgedHint")}</p>
              <ul aria-label={t("rules.decidedList")} className={LIST}>
                {decided.map((e) => (
                  <RuleCard key={e.id} entry={e} applied={applied} token={token} />
                ))}
              </ul>
            </DetailsPart>
          )}
          {v.pushbacks != null && <Pushbacks pushbacks={v.pushbacks} token={token} />}
          <DetailsPart title={t("rules.groupRetired")} data-retired-part>
            <Retired retired={v.retired ?? []} />
          </DetailsPart>
          <DetailsPart title={t("rules.how")} data-how>
            <p className={`${PROSE} ${muted}`}>{t("standing.intro")}{standingToken === null && sv !== undefined && t("standing.noWrite")}</p>
            <p className={`${PROSE} ${muted}`}>{t("rules.groupAppliedLine")}</p>
            <p className={`${PROSE} ${muted}`}>{t("rules.footer")}</p>
          </DetailsPart>
        </div>
      </Disclosure>
    </div>
  );
}
