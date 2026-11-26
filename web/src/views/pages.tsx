import { ListTodo } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  API, type FactoryState, type GitHubBudget, type Health, type HealthCheck, type HostSleepRow, type ItemDetail, type ItemRow, type Items, type Overview, type PauseRow, type PhaseRow, type PausesView, type QueueRow, type RunRow,
  type RulesView, type UnreviewedMerges, type WorkerProcess, type WorkersView, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { CopyText } from "../components/ui/copy.js";
import { Input } from "../components/ui/input.js";
import { DataTable } from "../components/ui/data-table.js";
import { ErrorNote, Loading, type StoredFlags, useRefetchWhile } from "../components/ui/parts.js";
import { Notice, PageHeader, PageToolbar, EmptyState } from "../components/ui/notice.js";
import { ID_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { FailuresSection, FailuresWindowSwitch, useFailuresWindow } from "./failures.js";
import { SpendSection } from "./spend.js";
import { EfficiencyTab } from "./efficiency.js";
import { Improve } from "./rules-improve.js";
import { Markdown } from "../components/ui/markdown.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { StatTile } from "../components/ui/stat-tile.js";
import { Tabs } from "../components/ui/tabs.js";
import { cn } from "../lib/cn.js";
import { useUrlParam } from "../lib/url-param.js";
import { type MessageKey, en } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { duration, groupedInteger, localClock, localDateTime, relativeTime, runStatusLabel, termLabel, shortItemId, shortRev, tokens } from "../lib/format.js";
import { GROUP_LABELS, ITEM_STATES, STATE_GROUPS, type StateGroup, groupOf, groupStates, isGroup, stateLabel } from "../../../src/shared/states.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { InteractiveBadge, ItemsTable, MergeCheckNote, RawDetails, RawNames, When, byId, QueueTable, RunningTable, WhyText, WorkerName, isInteractiveRun, runKindLabel, runTitle, tryOf, useNow, useViewer } from "./common.js";
import { ItemTable, type ItemTableRow } from "./item-row.js";
import { ItemDecision } from "./decision-card.js";
import { ItemAbout } from "./item-about.js";
import { ClosedStatus, ItemFacts, TIMELINE_ANCHOR, timelineSentence } from "./item-facts.js";
import { type ItemScreenshotReview, type ItemScreenshots, ItemChanges, ItemChangesTab, RecheckButton } from "./item-changes.js";
import { AddModelCredential } from "./model-credential-dialog.js";
import { ResumeNow, type SupervisorActionName, SupervisorActions } from "./system-banner.js";
import { Thread } from "./thread.js";
import { transcriptPath } from "./transcript.js";
import { ItemsTree, type View, VIEW_KEY, useExpanded } from "./tree.js";
import { type TreeFilter, buildTree, defaultExpanded, itemMatches, parentIds } from "./tree-model.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Card, SUB_TITLE } from "../components/ui/card.js";
import { Badge, StatusBadge } from "../components/ui/badge.js";
import { Tooltip } from "../components/ui/menu.js";
import { ChatCard } from "./chat-panel.js";
import { HostSleeps, sleptMinutes } from "./host-sleeps.js";
import { ActivityActorsPage } from "./activity/page.js";

/** The Activity page of the autonomous actors (design 09-dashboard-activity): registered here with the other pages. */
export { ActivityActorsPage };

/** "host slept N min" for a host sleep's gap, on the item timeline. */
export const sleptText = (gap_ms: number): string => t("host.slept", { min: sleptMinutes(gap_ms) });

/** What the factory process is doing, in words: `text` is the status page's sentence. */
interface FactoryView {
  tone: "ok" | "warn" | "bad";
  text: string;
  /** Stopped or failing: the states that get a page Notice. */
  notice: boolean;
}

function factoryView(factory: FactoryState | null, now: number): FactoryView {
  if (factory === null || factory.state === "stopped") return { tone: "bad", text: t("factory.stopped"), notice: true };
  const rev = shortRev(factory.rev);
  const target = shortRev(factory.target_rev);
  const updating = (text: string): FactoryView => ({ tone: "warn", text, notice: false });
  switch (factory.state) {
    case "running":
      return { tone: "ok", text: t("factory.running", { rev, time: relativeTime(factory.since, now) }), notice: false };
    case "building":
      return updating(t("factory.building", { target, rev }));
    case "draining":
      return updating(t("factory.draining", { target }));
    case "restarting":
      return updating(t("factory.restarting", { target }));
    case "build_failed":
      return { tone: "bad", text: t("factory.buildFailed", { target, rev }), notice: true };
    case "crashed":
      return { tone: "bad", text: t("factory.crashed", { error: factory.error ?? t("factory.exited") }), notice: true };
    case "migration_pending":
      return updating(factory.pending.length ? t("factory.migrationPendingList", { target, pending: factory.pending.join(", ") }) : t("factory.migrationPending", { target }));
    case "migration_draining":
      return updating(t("factory.migrationDraining", { target }));
    case "migration_ready":
      return updating(t("factory.migrationReady", { target }));
    default:
      return { tone: "warn", text: t("factory.other", { state: factory.state }), notice: false };
  }
}

/** The Runners page's supervisor banner: what the factory process is doing (the status page's words). */
export function FactoryBanner({ factory, now }: { factory: FactoryState | null | undefined; now: number }) {
  if (factory === undefined) return null;
  const v = factoryView(factory, now);
  // Migrate now while an update waits for its migration; otherwise Start or Restart now (design 08-self-update).
  const actions: SupervisorActionName[] = factory?.state === "migration_pending" ? ["migrate"] : ["start", "restart"];
  return (
    <div data-testid="factory-banner" className="space-y-2">
      <Notice tone={v.tone}>{v.text}</Notice>
      <SupervisorActions actions={actions} />
    </div>
  );
}

/**
 * The running version and how far it is behind the latest code (the code checkout's origin/main, a separate clone,
 * design 08-self-update), so a stuck install shows. Nothing for self-hosting (no `behind`) or with no factory status.
 */
export function CodeRevision({ factory }: { factory: FactoryState | null | undefined }) {
  if (!factory || factory.behind === undefined) return null;
  const { behind } = factory;
  const where = behind === null ? t("code.notChecked") : behind === 0 ? t("code.current") : behind === 1 ? t("code.behindOne") : t("code.behind", { count: behind });
  return (
    <p data-testid="code-revision" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span>{t("code.revision", { rev: shortRev(factory.rev) })}</span>
      <Badge level={behind === null ? undefined : behind === 0 ? "running" : "needs_approval"}>{where}</Badge>
    </p>
  );
}

/** What each claim pause stops (design §5 Restarts). */
const PAUSE_LABELS: Record<string, MessageKey> = {
  rate_limit: "pause.rate_limit",
  forge_auth: "pause.forge_auth",
  preflight_access: "pause.preflight_access",
  model_stall: "pause.model_stall",
  owner: "stop.stopped",
};
const pauseLabel = (name: string): string => {
  const key = PAUSE_LABELS[name];
  return key ? t(key) : name;
};

/** One pause with its "Resume now" button (ResumeNow, shared with the Tasks pause row); a refusal shows next to the button. */
function PauseItem({ pause, token, now }: { pause: PauseRow; token: string | null; now: number }) {
  // The owner pause (Stop all agents) has no end, only when it began.
  const at = pause.ends_at ?? pause.since ?? null;
  return (
    <li data-pause={pause.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="min-w-0 text-pretty text-text-1">{pauseLabel(pause.name)}</span>
      {at !== null && (
        <span className="min-w-0 tabular-nums break-words text-text-2" title={localDateTime(at)}>
          {pause.ends_at === null ? relativeTime(at, now) : t(pause.name === "model_stall" ? "pause.nextProbe" : "pause.ends", { time: localDateTime(at) })}
          {pause.ends_at !== null && Date.parse(at) > now ? ` (${relativeTime(at, now)})` : ""}
        </span>
      )}
      <ResumeNow name={pause.name} token={token} />
    </li>
  );
}

/** The claim pauses in effect, each with "Resume now". */
function PauseList({ view, now }: { view: PausesView; now: number }) {
  return (
    <ul aria-label={t("pause.title")} className="space-y-1">
      {view.pauses.map((p) => <PauseItem key={p.name} pause={p} token={view.csrf_token} now={now} />)}
    </ul>
  );
}

/**
 * The factory's note on the Tasks page under All projects: a Notice only when the factory is stopped or failing. A
 * claim pause is its own Needs-you row in the Check group (design 09-dashboard-tasks), so this note never names one.
 */
export function FloorStatus() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  const o = overview.data;
  const view = o?.factory === undefined ? null : factoryView(o.factory, now);
  return view?.notice ? <Notice tone={view.tone === "bad" ? "bad" : "warn"}>{view.text}</Notice> : null;
}

/** Work's Activity section, below its list: what runs now, the unreviewed-merges line, then the numbers of the last 24 hours. */
export function ActivityPage() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  // The tree's own read (`closed=1`), so under Work's tree this section adds no request.
  const items = useApi<Items>(`${API.items}?closed=1`);
  const runs = useApi<{ runs: RunRow[] }>(API.runs);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0"><Card title={t("running.label")} count={o?.running}>
        {runs.isError ? <ErrorNote error={runs.error} /> : !runs.data ? <Loading rows={2} label="loading.running" onRetry={() => void runs.refetch()} /> : <RunningTable runs={runs.data.runs} items={map} now={now} />}
      </Card></div>
      {o && (o.unreviewed_merges_7d ?? 0) > 0 && (
        <p data-testid="unreviewed-merges-line" className="text-sm">
          {t("activity.unreviewed", { count: o.unreviewed_merges_7d ?? 0 })}{" "}
          <Link href={`${BASE}health`} className={LINK_CLASS}>{t("activity.unreviewedLink")}</Link>
        </p>
      )}
      {o && (
        <div className="min-w-0"><Card title={t("activity.last24h")}>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [t("activity.succeeded"), String(o.last_24h.succeeded)],
              [t("activity.failed"), String(o.last_24h.failed), `${BASE}health?tab=failures&window=24h`],
              [t("col.tokens"), tokens(o.last_24h.tokens)],
              [t("activity.openItems"), String(o.open)],
            ].map(([k, v, href]) => (
              <StatTile key={k} label={k} value={href ? <Link href={href} className={cn("min-w-6", LINK_CLASS)}>{v}</Link> : v} />
            ))}
          </dl>
        </Card></div>
      )}
    </div>
  );
}

/**
 * The Work filter named by the `state` query parameter (the Queue page's old address leads here): a group or one item
 * state; `closed`, from older links, is the Finished group. An unknown value is no filter.
 */
function initialState(): string | null {
  const s = new URLSearchParams(location.search).get("state");
  if (s === "closed") return "finished";
  return s !== null && (isGroup(s) || (ITEM_STATES as readonly string[]).includes(s)) ? s : null;
}

/** The selected filter's group: the group itself, or the group a state is in; null for All. */
const groupOfFilter = (state: string | null): StateGroup | null => (state === null ? null : isGroup(state) ? state : (groupOf(state) ?? null));

const ALL = "all";
const VIEW_OPTIONS: { id: View; label: string }[] = [{ id: "tree", label: t("items.tree") }, { id: "list", label: t("items.list") }];

/** The items a link named (`/app/items?ids=wi_1,wi_2`, from the Failures page); null for no such filter. */
function initialIds(): ReadonlySet<string> | null {
  const ids = new URLSearchParams(location.search).get("ids");
  return ids ? new Set(ids.split(",").filter(Boolean)) : null;
}

/** The saved view: the tree unless the browser chose the list. */
function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree";
  } catch {
    return "tree";
  }
}

/** The queued runs: the one source of Work's Queued list, its filter count and its "N queued" (the same runs as overview.queued). */
function useQueuedRuns() {
  return useApi<{ queue: QueueRow[] }>(API.queue);
}

/** Every work item as a tree (the default) or, with the List toggle, the flat list; filterable by state and search. */
export function ItemsPage() {
  const now = useNow();
  const [view, setViewState] = useState<View>(savedView);
  const [state, setState] = useState<string | null>(initialState);
  const [q, setQ] = useState("");
  const [ids, setIds] = useState<ReadonlySet<string> | null>(initialIds);
  const [showClosed, setShowClosed] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const tree = view === "tree";
  const queuedView = state === "queued";
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage is blocked: the choice lasts until reload.
    }
  };
  // One request per poll: the tree reads every row once and filters in the page, the list asks the server.
  const params = new URLSearchParams();
  if (tree || ids) params.set("closed", "1");
  else if (!queuedView) {
    if (state) params.set("state", state);
    if (q.trim()) params.set("q", q.trim());
  }
  if (showSystem) params.set("system", "1");
  const query = params.toString();
  const items = useApi<Items>(query ? `${API.items}?${query}` : API.items);
  const overview = useApi<Overview>(API.overview);
  const pauses = useApi<PausesView>(API.pauses);
  const queue = useQueuedRuns();
  const rateLimit = pauses.data?.pauses.find((x) => x.name === "rate_limit");
  const rows = items.data?.items ?? [];
  const filter: TreeFilter = { state, q, showClosed, showSystem, ids };
  const nodes = useMemo(() => buildTree(rows, filter), [items.data, state, q, showClosed, showSystem, ids]);
  const [expanded, setExpanded] = useExpanded(defaultExpanded(nodes));
  const itemsById = useMemo(() => byId(items.data?.items), [items.data]);
  // The tree, and a list narrowed to named items, read every row and filter in the page.
  const local = tree || ids !== null;
  // Running, with no search and no named items, is the server's count of runs whose status is running, as Activity's Running now.
  const narrowed = !!q.trim() || ids !== null;
  const counted = (s: string) => (s === "queued" ? (queue.data?.queue.length ?? "…") : s === "running" && !narrowed && items.data ? items.data.counts.running : local ?rows.filter((r) => itemMatches(r, { state: s, q, showClosed, showSystem, ids })).length : (items.data?.facets.state[s] ?? 0));
  const group = groupOfFilter(state);
  // A group or state tab with no rows is hidden, unless it is the one selected.
  const shows = (s: string) => s === state || s === group || counted(s) !== 0;
  // All, with no search, no named items and closed items hidden, is the server's open count (stage not CLOSED), as Activity's Open items.
  const allCount = !narrowed && !showClosed && items.data ? items.data.counts.open : local ? rows.filter((r) => itemMatches(r, { state: null, q, showClosed, showSystem, ids })).length : (items.data?.facets.allStates ?? "");
  return (
    <>
      <PageHeader title={t("page.work")} description={t("work.pageDescription")} />
      <PageToolbar
        tabs={
          <div className="flex min-w-0 flex-col gap-2">
            <Tabs
              label={t("items.filterByState")}
              options={[
                { id: ALL, label: t("items.filterCount", { label: t("items.all"), count: allCount }) },
                ...STATE_GROUPS.filter(shows).map((g) => ({ id: g, label: t("items.filterCount", { label: GROUP_LABELS[g], count: counted(g) }) })),
              ]}
              value={group ?? ALL}
              onChange={(id) => setState(id === ALL ? null : id)}
            />
            {group && (
              <Tabs
                label={t("items.filterGroup", { group: GROUP_LABELS[group] })}
                options={[
                  { id: group, label: t("items.filterCount", { label: t("items.all"), count: counted(group) }) },
                  // `closed` is the Finished group's older link value (src/shared/states.ts inStateFilter): All shows those rows.
                  ...groupStates(group).filter((s) => s !== "closed" && shows(s)).map((s) => ({ id: s, label: t("items.filterCount", { label: stateLabel(s), count: counted(s) }) })),
                ]}
                value={state ?? group}
                onChange={setState}
              />
            )}
          </div>
        }
      >
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("items.searchPlaceholder")}
          aria-label={t("items.searchLabel")}
          className="w-full max-w-sm"
        />
        <SegmentedControl label={t("items.view")} options={VIEW_OPTIONS} value={view} onChange={setView} />
        <ButtonRow>
          {tree && <Button size="sm" aria-pressed={showClosed} onClick={() => setShowClosed(!showClosed)}>{t("items.showClosed")}</Button>}
          <Button size="sm" aria-pressed={showSystem} onClick={() => setShowSystem(!showSystem)}>{t("items.showSystem")}</Button>
          {tree && <Button size="sm" onClick={() => setExpanded(parentIds(nodes))}>{t("items.expandAll")}</Button>}
          {tree && <Button size="sm" onClick={() => setExpanded([])}>{t("items.collapseAll")}</Button>}
        </ButtonRow>
      </PageToolbar>
      <div className="flex flex-col gap-6">
      {ids && (
        <div className="flex flex-wrap items-center gap-2">
          <Notice tone="info">{t("items.idsFilter", { count: ids.size })}</Notice>
          <Button size="sm" onClick={() => setIds(null)}>{t("items.idsClear")}</Button>
        </div>
      )}
      {rateLimit?.ends_at && <Notice tone="warn">{t("items.rateLimit", { state: t("items.ratePaused", { time: rateLimit.ends_at }) })}</Notice>}
      <div className="min-w-0">
      {queuedView ? (
        <Card title={t("queue.title")} count={queue.data?.queue.length}>
          {queue.isError ? <ErrorNote error={queue.error} /> : !queue.data || !items.data ? <Loading rows={4} label="loading.queue" onRetry={() => void Promise.all([queue.refetch(), items.refetch()])} /> : <QueueTable queue={queue.data.queue} items={itemsById} now={now} />}
        </Card>
      ) : (
        <Card>
          {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading rows={6} label="loading.items" onRetry={() => void items.refetch()} /> : rows.length === 0 && !state && !q.trim() && !ids ? (
            <EmptyState icon={ListTodo} title={t("items.emptyTitle")} description={t("items.emptyBody")} action={<Link href={`${BASE}tasks`} className={LINK_CLASS}>{t("items.emptyAction")}</Link>} />
          ) : tree ? (
            nodes.length === 0 ? <EmptyState icon={ListTodo} title={t("items.noMatch")} /> : (
              <ItemsTree nodes={nodes} rows={rows} now={now} expanded={expanded} onExpanded={setExpanded} />
            )
          ) : (
            <ItemsTable items={ids ? rows.filter((r) => itemMatches(r, { ...filter, showClosed: true })) : items.data.items} now={now} label={t("items.label")} plugins={overview.data?.plugins} empty={t("items.noMatch")} />
          )}
        </Card>
      )}
      </div>
      <ActivityPage />
      </div>
    </>
  );
}

/** The item page's tabs (design 04-screenshots): its overview, and the Changes tab with the changed files and the screenshots. */
type ItemTab = "overview" | "changes";
/** What the item API adds for the Changes tab (src/ui/item-screenshots.ts). */
type ItemChangesFields = { screenshots?: ItemScreenshots | null; screenshot_review?: ItemScreenshotReview | null };

/**
 * One work item (design 09-dashboard-item): its title, then its decision (the DecisionCard while the owner is next,
 * else its reason and "…" menu), its facts, the current run with its live state, the thread (collapsed after its
 * first message), the runs (with errors) and the timeline. An item with a branch or a screenshot run has the tabs
 * Overview and Changes (item-changes.tsx) in a PageToolbar under the header, kept in `?tab=`; About and the decision
 * (with Merge) stay above both tabs' content.
 */
export function ItemPage({ id }: { id: string }) {
  const now = useNow();
  const q = useApi<ItemDetail & ItemChangesFields>(API.item(id));
  const viewer = useViewer();
  const [picked, pick] = useUrlParam("tab", (v) => v === "changes");
  if (q.isError) return <><PageHeader title={t("app.workItem")} /><ErrorNote error={q.error} /></>;
  if (!q.data) return <><PageHeader title={t("app.workItem")} /><Loading rows={6} label="loading.item" onRetry={() => void q.refetch()} /></>;
  const { item, runs, timeline } = q.data;
  // State changes and host sleeps of the item's runs, newest first.
  const entries: ({ kind: "change"; at: string; t: ItemDetail["timeline"][number] } | { kind: "sleep"; at: string; h: HostSleepRow })[] = [
    ...timeline.map((t) => ({ kind: "change" as const, at: t.at, t })),
    ...(q.data.sleeps ?? []).map((h) => ({ kind: "sleep" as const, at: h.woke_at, h })),
  ];
  entries.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const transcripts = q.data.transcripts ?? {};
  const short = shortItemId(item.id);
  const level = item.item_phase;
  const hasTabs = item.has_changes === true || q.data.screenshots != null;
  const tab: ItemTab = hasTabs && picked === "changes" ? "changes" : "overview";
  const tabs: { id: ItemTab; label: string }[] = [{ id: "overview", label: t("item.tabOverview") }, { id: "changes", label: t("item.tabChanges") }];
  return (
    <>
      <nav aria-label={t("item.breadcrumb")} className="mb-1 text-sm">
        <Link href={`${BASE}items`} className={LINK_CLASS}>{t("page.work")}</Link>
        <span className="text-text-3"> / </span>
        <Link href={itemPath(item.id)} aria-current="page" title={item.id} className={cn("inline-block max-w-[16ch] truncate align-bottom tabular-nums", ID_CLASS)}>{short}</Link>
      </nav>
      <PageHeader title={<span data-raw>{item.title ?? short}</span>} actions={runs.some(isInteractiveRun) ? <InteractiveBadge /> : undefined} />
      {hasTabs && <PageToolbar tabs={<Tabs label={t("item.views")} options={tabs} value={tab} onChange={(v) => pick(v === "overview" ? null : v)} />} />}
      {item.parent_id && (
        <p data-testid="parent" className="mt-1 text-sm">
          {t("item.phase", { phase: item.phase ?? "?" })} <Link href={itemPath(item.parent_id)} className={LINK_CLASS}>{t("item.splitParent")}</Link>
        </p>
      )}
      {/* The page's blocks in one gap-6 column; `*:mt-0` drops each Card's own top margin here, so the gap is not doubled. */}
      <div className="flex flex-col gap-6 *:mt-0">
      <ItemAbout item={item} />
      <ItemDecision
        id={item.id}
        commands={q.data.commands ?? []}
        replies={q.data.replies ?? []}
        reason={item.stage === "CLOSED" ? <ClosedStatus item={item} timeline={timeline} thread={q.data.thread ?? []} now={now} viewer={viewer} /> : item.why ? (
          <p data-testid="why" className="text-sm text-pretty break-words">
            <WhyText why={item.why} />
          </p>
        ) : null}
      />
      {tab === "changes" ? (
        <>
          {item.has_changes && <ItemChangesTab id={item.id} />}
          <ItemChanges itemId={item.id} screenshots={q.data.screenshots ?? null} review={q.data.screenshot_review ?? null} />
        </>
      ) : (
        <>
        {/* The facts are a block of the page like the others: in a Card, so they start on the cards' content edge. */}
        <Card label={t("item.facts")}>
          <ItemFacts item={item} now={now} />
          <Disclosure data-ids className="mt-2" summary={t("ids.summary")}>
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-xs text-text-2">{t("ids.item")}</dt>
              <dd className="min-w-0"><CopyText value={item.id} what="item ID" /></dd>
              <dt className="text-xs text-text-2">{t("ids.source")}</dt>
              <dd className="min-w-0"><CopyText value={item.source.id} what="source ID" /></dd>
            </dl>
          </Disclosure>
        </Card>
        <CurrentRun runs={runs} itemId={item.id} now={now} />
        <Thread entries={q.data.thread ?? []} now={now} />
        <Phases phases={item.phases ?? []} />
        {item.merge_check && (
          <Card title={t("item.mergeCheck")}>
            <p className="text-sm" data-merge-check-detail>
              <MergeCheckNote check={item.merge_check} />
              {item.merge_check.base_sha && item.merge_check.checked_at && (
                <span className="ml-2 text-text-2">
                  {t("item.againstBase")} <code className="font-mono text-xs" title={item.merge_check.base_sha}>{item.merge_check.base_sha.slice(0, 12)}</code>, <When at={item.merge_check.checked_at} now={now} label="item.checkedAgo" />
                </span>
              )}
            </p>
            {item.merge_check.conflicts.length > 0 && (
              <ul aria-label={t("item.conflicting")} className="mt-1 list-disc pl-6 font-mono text-xs">
                {item.merge_check.conflicts.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
            {item.merge_check.recheck && <RecheckButton id={item.id} />}
          </Card>
        )}
        <Card title={t("item.runs")} count={runs.length}>
          <ItemTable label={t("item.runs")} head={RUN_HEAD()} empty={t("item.noRun")} rows={foldRuns(runs).map(({ run, tries }) => runRow(run, tries, item.id, (transcripts[run.id]?.length ?? 0) > 0, now))} />
        </Card>
        <Card id={TIMELINE_ANCHOR} title={t("item.timeline")} count={entries.length}>
          <ol className="space-y-1 text-sm">
            {entries.map((e) => {
              if (e.kind === "sleep") return (
                <li key={`sleep:${e.h.worker_id}:${e.h.woke_at}`} className="flex gap-3" data-testid="host-sleep">
                  <span className="w-16 shrink-0 text-right text-text-3 tabular-nums"><When at={e.h.woke_at} now={now} /></span>
                  <span className="min-w-0">
                    <span className="font-medium">{sleptText(e.h.gap_ms)}</span>
                    <span className="text-text-3">{t("item.on")}</span>
                    <WorkerName id={e.h.worker_id} />
                  </span>
                </li>
              );
              return <TimelineRow key={e.t.version} entry={e.t} now={now} viewer={viewer} />;
            })}
          </ol>
        </Card>
        </>
      )}
      </div>
    </>
  );
}

/** The item page's Runs columns: an ItemRow's slots. */
const RUN_HEAD = () => ({ badge: t("item.status"), title: t("col.run"), why: t("col.detail"), project: t("tasks.project"), worker: t("col.worker"), age: t("item.started"), actions: t("item.transcript") });

/**
 * One run as a compact ItemRow (design 09-dashboard-item): its result, its kind and attempt as the title ("Implement
 * #2"), its folded tries, how long it took and its tokens, its worker, when it started, Open (its transcript, when one
 * is stored) and Copy ID (the run's ID) in "⋯". A failed run's error sentence is its second line, the stored code and
 * full text behind Details. `tries` are the consecutive cancelled tries folded into this row (just the run otherwise).
 */
function runRow(r: ItemDetail["runs"][number], tries: ItemDetail["runs"], itemId: string, transcript: boolean, now: number): ItemTableRow {
  const title = runTitle(r);
  const took = r.started_at && r.finished_at ? t("item.tookTime", { took: duration(Date.parse(r.finished_at) - Date.parse(r.started_at)) }) : null;
  const used = tries.reduce((sum, x) => sum + (x.tokens ?? 0), 0);
  return {
    key: r.id,
    itemId,
    "data-run": r.id,
    badge: <StatusBadge state={r.status}>{runResultLabel(r.status)}</StatusBadge>,
    title,
    why: [tries.length > 1 ? t("item.foldedTries", { count: tries.length }) : null, took, used ? t("item.tokensCount", { tokens: tokens(used) }) : null].filter(Boolean).join(" · ") || undefined,
    worker: <WorkerName id={r.attempts?.at(-1)?.worker_id} />,
    age: <When at={r.started_at} now={now} />,
    action: transcript && <Link href={transcriptPath(itemId, r.id)} className={LINK_CLASS}>{t("item.open")}</Link>,
    menuLabel: t("items.more", { title }),
    copyId: r.id,
    second: r.error && (
      <span className="text-text-1">
        <span className="font-medium">{errorSentence(r.error.code)}</span>
        <RawDetails>
          {r.error.code && <code className="font-mono">{r.error.code}</code>}
          {r.error.detail && <p className="mt-1 whitespace-pre-wrap">{r.error.detail}</p>}
        </RawDetails>
      </span>
    ),
  };
}

/**
 * The item's queued or running run, newest first, with its live state (the item query polls) and a link to its
 * transcript, which shows its output so far while it runs; nothing when none is.
 */
function CurrentRun({ runs, itemId, now }: { runs: ItemDetail["runs"]; itemId: string; now: number }) {
  const run = [...runs].reverse().find((r) => r.status === "running" || r.status === "queued");
  if (!run) return null;
  return (
    <Card title={t("item.currentRun")}>
      <p data-current-run={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{runKindLabel(run.kind)}</span>
        <StatusBadge state={run.status} />
        <span className="tabular-nums">{t("item.attempt", { attempt: tryOf(run.attempt) })}</span>
        <WorkerName id={run.attempts?.at(-1)?.worker_id} />
        {run.started_at && <span className="text-text-2 tabular-nums"><When at={run.started_at} now={now} label="item.startedAgo" /></span>}
        <Link href={transcriptPath(itemId, run.id)} className={LINK_CLASS}>{t("item.transcript")}</Link>
      </p>
    </Card>
  );
}

/** A split parent's phases in merge order, each linking to its own item page. */
function Phases({ phases }: { phases: readonly PhaseRow[] }) {
  if (phases.length === 0) return null;
  return (
    <Card title={t("item.phases")} count={phases.length}>
      <ol aria-label={t("item.phases")} className="space-y-1 text-sm">
        {phases.map((p) => (
          <li key={p.id} data-phase={p.phase} className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-text-3 tabular-nums">{p.phase}.</span>
            <Link href={itemPath(p.id)} data-raw className={cn("min-w-0 break-words", LINK_CLASS)}>{p.title ?? p.source.id}</Link>
            <Badge>{p.stage}</Badge>
          </li>
        ))}
      </ol>
    </Card>
  );
}

type TimelineEntry = ItemDetail["timeline"][number];

/** The spec fields triage writes: shown behind "spec written (show)" and rendered as markdown, never as JSON. */
const SPEC_FIELDS: Record<string, string> = {
  problem: t("spec.problem"),
  scope: t("spec.scope"),
  desired_output: t("spec.desired_output"),
  done_criteria: t("spec.done_criteria"),
  files_to_change: t("spec.files_to_change"),
  allowed_paths: t("spec.allowed_paths"),
};

/** A change value from the API's JSON text; text that is not JSON (a withheld marker) as it is. */
function parseValue(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A short change value as words: strings unquoted, lists joined, none as a dash. */
function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (Array.isArray(v)) return v.map(shortValue).join(", ") || "–";
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${shortValue(x)}`).join("; ");
  return String(v);
}

/** A health check's status word. */
const CHECK_KEYS: Readonly<Record<string, MessageKey>> = { ok: "check.ok", warn: "check.warn", fail: "check.fail" };
const checkLabel = (status: string): string => (CHECK_KEYS[status] ? t(CHECK_KEYS[status]) : status);

/** A spec field's value as markdown: a list becomes a bullet list. */
function specMarkdown(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => `- ${shortValue(x)}`).join("\n");
  return shortValue(v);
}

/** The runs, newest first, with consecutive cancelled tries of one step folded into one row (its newest try, and every folded try). */
function foldRuns(runs: ItemDetail["runs"]): { run: ItemDetail["runs"][number]; tries: ItemDetail["runs"] }[] {
  const rows: { run: ItemDetail["runs"][number]; tries: ItemDetail["runs"] }[] = [];
  for (const run of [...runs].reverse()) {
    const prev = rows.at(-1);
    if (prev && run.status === "canceled" && prev.run.status === "canceled" && prev.run.kind === run.kind) prev.tries.push(run);
    else rows.push({ run, tries: [run] });
  }
  return rows;
}

/** A run's status as the Result column reads it. */
const runResultLabel = (status: string): string => (`item.result.${status}` in en ? t(`item.result.${status}` as MessageKey) : termLabel(status));

/** A run error's one line: the sentence for its code, else "Failed". The code and the full text go behind Details. */
function errorSentence(code: string | null | undefined): string {
  const key = code ? [`item.error.${code}`, `term.${code}`, `failure.${code}.title`].find((k) => k in en) : undefined;
  return t((key ?? "item.errorFailed") as MessageKey);
}

function TimelineRow({ entry, now, viewer }: { entry: TimelineEntry; now: number; viewer: string | null }) {
  const [open, setOpen] = useState(false);
  const changes = Object.entries(entry.changes);
  const short = changes.filter(([f]) => !(f in SPEC_FIELDS));
  const spec = changes.filter(([f]) => f in SPEC_FIELDS);
  return (
    <li className="flex gap-3">
      <span className="w-16 shrink-0 text-right text-text-3 tabular-nums"><When at={entry.at} now={now} /></span>
      <div className="min-w-0 flex-1 break-words">
        <span className="font-medium">{timelineSentence(entry, viewer)}</span>
        <RawDetails className="mt-1">
          <ul className="mt-1 font-mono text-xs break-all">
            {entry.reason && <li><code>{entry.reason}</code></li>}
            <li><code>{entry.actor.id}</code></li>
            {short.map(([f, c]) => <li key={f}><code>{`${f}: ${shortValue(parseValue(c.from))} → ${shortValue(parseValue(c.to))}`}</code></li>)}
          </ul>
        </RawDetails>
        {spec.length > 0 && (
          <div className="mt-1">
            <Button variant="ghost" size="sm" flush aria-expanded={open} onClick={() => setOpen(!open)} className={LINK_CLASS}>
              {open ? t("item.specHide") : t("item.specShow")}
            </Button>
            {open && (
              <div data-spec className="mt-2 space-y-3 rounded-control border border-border p-3">
                {spec.map(([f, c]) => (
                  <div key={f}>
                    <h3 className={cn("mb-1", SUB_TITLE)}>{SPEC_FIELDS[f]}</h3>
                    <Markdown text={specMarkdown(parseValue(c.to))} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * One live worker process: its host ("This Mac" for the factory's own host) and how many tasks it runs of its slots,
 * its start time, and while it drains "Finishing up before it stops". The pid and max slots show in the line's tooltip.
 */
function ProcessRow({ p, local, items, now }: { p: WorkerProcess; local: boolean; items: ReadonlyMap<string, ItemRow>; now: number }) {
  const draining = p.slots === 0;
  const host = local ? t("runners.thisHost") : p.host;
  return (
    <li data-testid="worker-process" className="rounded-control border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <Tooltip text={t("runners.details", { pid: p.pid, max: p.max_slots })}>
          <span data-line tabIndex={0} className="tabular-nums">
            {draining ? t("runners.lineDraining", { host, busy: p.busy }) : t("runners.line", { host, busy: p.busy, slots: p.slots })}
          </span>
        </Tooltip>
        <span className="tabular-nums text-text-2"><When at={p.started_at} now={now} label="runners.started" /></span>
        {draining && <StatusBadge state="draining">{t("runners.draining")}</StatusBadge>}
      </div>
      {p.runs.length > 0 && (
        <ul aria-label={t("runners.runsOf", { host: p.host, pid: p.pid })} className="mt-1 space-y-0.5 text-xs">
          {p.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-3">
              <Link href={itemPath(r.work_item_id)} data-row-title className={LINK_CLASS}>{items.get(r.work_item_id)?.title || r.work_item_id}</Link>
              <span>{runKindLabel(r.kind)}</span>
              <WorkerName id={r.worker_id} />
              <span className="tabular-nums"><When at={r.started_at} now={now} /></span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const WORKERS_SOURCE: Record<FactoryState["workers_source"], MessageKey> = { override: "runners.sourceOverride", file: "runners.sourceFile", default: "runners.sourceDefault" };

/** The effective `workers` setting in words, with where it comes from: "Up to 3 tasks at once (changed in Settings)". */
function workersLine(f: FactoryState): string {
  const key = WORKERS_SOURCE[f.workers_source];
  const source = key ? t(key) : f.workers_source;
  return f.workers === 1 ? t("runners.settingOne", { source }) : t("runners.setting", { count: f.workers, source });
}

/** Health's Runners tab (design 09-health): the worker processes and the effective worker setting. Running now is on Work only. */
export function RunnersTab() {
  const now = useNow();
  const workers = useApi<WorkersView>(API.workers);
  const overview = useApi<Overview>(API.overview);
  const items = useApi<Items>(API.items);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const f = overview.data?.factory;
  const processes = workers.data?.processes ?? [];
  // The factory's own host: the host of the process the supervisor runs (child_pid), where this server runs too.
  const thisHost = processes.find((p) => f?.child_pid != null && p.pid === f.child_pid)?.host;
  return (
    <div className="flex flex-col gap-6">
      <FactoryBanner factory={f} now={now} />
      {f && (
        <p data-testid="effective-workers" className="text-sm tabular-nums">
          {workersLine(f)}
        </p>
      )}
      <Card title={t("runners.processes")} count={workers.data?.processes ? processes.length : undefined}>
        {workers.isError ? <ErrorNote error={workers.error} /> : !workers.data ? <Loading rows={2} label="loading.workers" onRetry={() => void workers.refetch()} /> : workers.data.processes_error ? (
          <ErrorNote error={new Error(workers.data.processes_error)} />
        ) : processes.length === 0 ? (
          <EmptyState title={t("runners.none")} />
        ) : (
          <ul aria-label={t("runners.processes")} className="space-y-2">
            {processes.map((p) => <ProcessRow key={p.process_id} p={p} local={p.host === thisHost} items={map} now={now} />)}
          </ul>
        )}
      </Card>
      <ChatCard />
    </div>
  );
}

const HEALTH_TONE: Record<string, string> = { ok: "running", warn: "needs_approval", fail: "stuck" };

/**
 * A check's row: its sentence, then its times (a probe pause's start and next probe) relative, the local time on hover,
 * then the action the server offers on it (the model credential's opens the Add model credential dialog).
 */
function CheckList({ checks }: { checks: HealthCheck[] }) {
  const now = useNow();
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {checks.map((c, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <Badge level={HEALTH_TONE[c.status]}>{checkLabel(c.status)}</Badge>
          {/* The sentence is plain words, any name it quotes as written in data-raw; the detail is behind RawDetails. */}
          <span className="min-w-0 text-pretty break-words">
            <RawNames text={c.msg} />
            {c.since !== undefined && <span className="text-text-2">{" · "}<When at={c.since} now={now} label="health.checkSince" /></span>}
            {c.next !== undefined && <span className="text-text-2">{" · "}<When at={c.next} now={now} label="health.checkNext" /></span>}
            {c.action === "add_model_credential" && <span className="ml-2 inline-block align-baseline"><AddModelCredential /></span>}
            {c.detail !== undefined && <RawDetails className="mt-1"><code className="font-mono text-xs whitespace-pre-wrap break-all">{c.detail}</code></RawDetails>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Health's four tabs and the sections each holds, in order (design 09-health, 2026-11-24). A section's ID is the tab ID
 * it had before the merge, so an old link (`?tab=sleeps`) still names it: it opens the tab that holds it, scrolled to it.
 */
const HEALTH_TABS = {
  overview: ["pauses", "checks"],
  runs: ["runners", "failures", "sleeps"],
  cost: ["spend", "efficiency", "github"],
  review: ["merges", "improve"],
} as const;
type HealthTab = keyof typeof HEALTH_TABS;
type HealthSection = (typeof HEALTH_TABS)[HealthTab][number];
const TAB_OF = new Map<string, HealthTab>(Object.entries(HEALTH_TABS).flatMap(([tab, sections]) => [[tab, tab as HealthTab], ...sections.map((s): [string, HealthTab] => [s, tab as HealthTab])]));

/** A section's anchor on the Health page. */
const sectionAnchor = (s: HealthSection) => `health-${s}`;

/**
 * The GitHub budget tab (design 09-health, 2026-11-20): what the controller stored after its last poll, so no GitHub
 * call. Remaining of limit grouped by thousands and the reset in the viewer's local time, the requests this factory
 * made (and the share when one is set), a banner while waiting or low, the token's days left when the last health run
 * checked it, and the stored fields (reset time, replica, wait reason) behind Details.
 */
function GitHubBudgetTab({ budget, tokenDays }: { budget: GitHubBudget; tokenDays: Overview["github_token_days"] }) {
  const reset = localClock(budget.reset_at);
  const raw = { reset_at: budget.reset_at, replica_id: budget.replica_id, budget_share: budget.budget_share, wait_reason: budget.wait_reason };
  return (
    <Card title={t("health.githubBudget")}>
      <div data-github-budget className="space-y-2 text-sm">
        {budget.state === "waiting" && <Notice tone="warn">{t("health.budgetWaiting", { reset })}</Notice>}
        {budget.state === "low" && <Notice tone="warn">{t("health.budgetLow")}</Notice>}
        <p className="tabular-nums">{t("health.budgetLeft", { remaining: groupedInteger(budget.remaining), limit: groupedInteger(budget.limit), reset })}</p>
        <p className="tabular-nums text-text-2">{t("health.budgetCounted", { counted: groupedInteger(budget.counted) })}</p>
        {budget.share_limit !== null && <p className="tabular-nums text-text-2">{t("health.budgetShare", { share_limit: groupedInteger(budget.share_limit) })}</p>}
        {tokenDays !== null && tokenDays !== undefined && (
          <p data-token-days className="tabular-nums">{tokenDays === "unknown" ? t("health.tokenUnknown") : t("health.tokenDays", { days: tokenDays })}</p>
        )}
        <RawDetails><code className="font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(raw, null, 1)}</code></RawDetails>
      </div>
    </Card>
  );
}

/** The Checks card's title: all pass, or how many need attention, then when they ran ("All 27 checks pass · 4m ago"). */
function checksTitle(total: number, attention: number, ago: string): string {
  if (total === 0) return t("health.checks");
  if (attention === 0) return t("health.allPass", { count: total, time: ago });
  return t(attention === 1 ? "health.attentionOne" : "health.attentionMany", { count: attention, time: ago });
}

/**
 * When the URL named a section (`?tab=sleeps`), scroll to it once it is drawn; the first section drawn in its tab needs
 * no scroll. The sections above it read their own data and grow when it arrives, so the scroll waits until none of
 * them shows its placeholder (`aria-busy`), at most 3 s. Looks after each render until the section is there, since the
 * sections appear only once the checks have loaded.
 */
function useScrollToSection(section: HealthSection | null) {
  const done = useRef(false);
  const stop = useRef<() => void>(() => undefined);
  useEffect(() => () => stop.current(), []);
  useEffect(() => {
    if (done.current || section === null) return;
    const el = document.getElementById(sectionAnchor(section));
    if (!el) return;
    done.current = true;
    if (!el.previousElementSibling || !el.parentElement) return;
    const box = el.parentElement;
    const loading = () => box.querySelector('[aria-busy="true"]') !== null;
    const observer = new MutationObserver(() => !loading() && go());
    const timer = setTimeout(() => go(), 3_000);
    stop.current = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    const go = () => {
      stop.current();
      el.scrollIntoView?.({ block: "start" });
    };
    if (loading()) observer.observe(box, { subtree: true, childList: true, attributes: true });
    else go();
  });
}

export function HealthPage() {
  const now = useNow();
  // Each read runs the checks: every 30 s, not every 3 s.
  const health = useApi<Health & StoredFlags>(API.health, 30_000);
  // Pending: the server's first run has not ended (design 09-health, 2026-11-19); read again each second meanwhile.
  useRefetchWhile(health.data?.pending === true, health.refetch);
  const merges = useApi<UnreviewedMerges>(API.unreviewedMerges, 30_000);
  const pauses = useApi<PausesView>(API.pauses);
  const overview = useApi<Overview>(API.overview);
  const rules = useApi<RulesView>(API.rules);
  const viewer = useViewer();
  const held = (pauses.data?.pauses.length ?? 0) > 0;
  // `?tab=` takes a tab ID or a section ID (an old tab's link); a section opens its tab and scrolls to it.
  const [picked, pick] = useUrlParam("tab", (v) => TAB_OF.has(v));
  const tab: HealthTab = (picked && TAB_OF.get(picked)) || "overview";
  const section = picked && !(picked in HEALTH_TABS) ? (picked as HealthSection) : null;
  useScrollToSection(section);
  // The Failures window (`?window=`): a page control in the toolbar's second row while the Runs tab is open.
  const [failuresWindow, setFailuresWindow] = useFailuresWindow();
  if (health.isError) return <><PageHeader title={t("page.health")} /><ErrorNote error={health.error} /></>;
  if (!health.data || health.data.pending) return <><PageHeader title={t("page.health")} /><Loading rows={6} label="loading.health" onRetry={() => void health.refetch()} /></>;
  const order = ["fail", "warn", "ok"];
  const checks = [...health.data.checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  // Warn and fail rows stay in view; ok rows fold behind their count ("22 ok"), or behind "Show the checks" when the title already counts them.
  const open = checks.filter((c) => c.status !== "ok");
  const fine = checks.filter((c) => c.status === "ok");
  const failing = checks.some((c) => c.status === "fail");
  const mergeList = merges.data?.merges;
  const budget = overview.data?.github_budget ?? null;
  // The improve report (design 09-dashboard-system, 2026-11-21): from the rules read's `improve`; no section without one.
  const improve = rules.data?.improve ?? null;
  // A count in a tab's label only for what waits on the owner: checks that need attention and held pauses; merges to sample.
  const attention = open.length + (pauses.data?.pauses.length ?? 0);
  const counted = (label: string, n: number | undefined) => (n ? `${label} (${n})` : label);
  const options: { id: HealthTab; label: string }[] = [
    { id: "overview", label: `${counted(t("health.tabOverview"), attention)}${failing ? ` ${t("health.failMark")}` : ""}` },
    { id: "runs", label: t("health.tabRuns") },
    { id: "cost", label: t("health.tabCost") },
    { id: "review", label: counted(t("health.tabReview"), mergeList?.length) },
  ];
  // Each section of the open tab, in order; a section with nothing to show (no pause held, no budget stored, no report) is not drawn.
  const draw: Record<HealthSection, () => ReactNode> = {
    pauses: () => held && pauses.data && (
      <Card title={t("pause.title")} count={pauses.data.pauses.length}>
        <PauseList view={pauses.data} now={now} />
      </Card>
    ),
    checks: () => (
      <Card title={checksTitle(checks.length, open.length, relativeTime(health.data!.checked_at, now))}>
        <CheckList checks={open} />
        {fine.length > 0 && (
          <Disclosure data-testid="ok-checks" className={open.length > 0 ? "mt-2" : undefined} summary={open.length > 0 ? t("health.okCount", { count: fine.length }) : t("health.showChecks")}>
            <CheckList checks={fine} />
          </Disclosure>
        )}
      </Card>
    ),
    runners: () => <RunnersTab />,
    failures: () => <FailuresSection win={failuresWindow} />,
    sleeps: () => <HostSleeps sleeps={health.data!.sleeps ?? []} now={now} />,
    spend: () => <SpendSection />,
    efficiency: () => <EfficiencyTab />,
    github: () => budget && <GitHubBudgetTab budget={budget} tokenDays={overview.data?.github_token_days} />,
    merges: () => (
      <div id="unreviewed-merges">
        <Card title={t("health.merges")} count={mergeList?.length}>
          {merges.isError ? <ErrorNote error={merges.error} /> : !mergeList ? <Loading rows={2} label="loading.merges" onRetry={() => void merges.refetch()} /> : (
            <DataTable
              label={t("health.merges")}
              columns={[
                { key: "pr", header: t("col.pr"), className: "tabular-nums", render: (m) => (m.change_url ? <a href={m.change_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{m.change_ref}</a> : `#${m.change_ref}`) },
                { key: "merged_by", header: t("health.mergedBy"), className: "break-words", render: (m) => (m.merged_by && m.merged_by !== "unknown" ? <span title={m.merged_by}>{m.merged_by === viewer ? t("person.you") : t("person.other")}</span> : t("format.unknown")) },
                { key: "merge_sha", header: t("health.mergeCommit"), className: "font-mono" },
                { key: "recorded_at", header: t("col.when"), className: "tabular-nums whitespace-nowrap", render: (m) => <When at={m.recorded_at} now={now} /> },
              ]}
              rows={mergeList}
              rowKey={(m) => `${m.project}#${m.change_ref}`}
              empty={t("health.noMerges")}
            />
          )}
        </Card>
      </div>
    ),
    improve: () => improve && <Improve view={improve} />,
  };
  return (
    <>
      <PageHeader title={t("page.health")} />
      <PageToolbar tabs={<Tabs label={t("health.tabs")} options={options} value={tab} onChange={pick} />}>
        {tab === "runs" && <FailuresWindowSwitch value={failuresWindow} onChange={setFailuresWindow} />}
      </PageToolbar>
      <div className="flex flex-col gap-6">
        <CodeRevision factory={overview.data?.factory} />
        {HEALTH_TABS[tab].map((s) => {
          const body = draw[s]();
          return body ? <div key={s} id={sectionAnchor(s)} data-health-section={s} className="min-w-0 scroll-mt-4">{body}</div> : null;
        })}
      </div>
    </>
  );
}
