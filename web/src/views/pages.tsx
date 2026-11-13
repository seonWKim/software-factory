import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  API, type FactoryState, type Health, type HostSleepRow, type ItemDetail, type ItemRow, type Items, type Overview, type PauseRow, type PhaseRow, type PausesView, type QueueRow, type RunRow,
  type UnreviewedMerges, type WorkerProcess, type WorkersView, postResume, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { CopyText } from "../components/ui/copy.js";
import { Input } from "../components/ui/input.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { Notice, PageHeader, StatusBadge } from "../components/ui/notice.js";
import { Tooltip } from "../components/ui/menu.js";
import { FOCUS } from "../components/ui/control.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Markdown } from "../components/ui/markdown.js";
import { cn } from "../lib/cn.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { LEVEL_LABELS, ago, detailLevel, isHttpUrl, shortRev, shortSource, tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { ItemsTable, MergeCheckNote, byId, NeedsGroups, needsYou, PersonName, QueueTable, RunningTable, SourceLink, WhyText, WorkerName, useNow, useViewer } from "./common.js";
import { ItemCommands } from "./item-commands.js";
import { FloorNotes } from "./system-banner.js";
import { Thread } from "./thread.js";
import { transcriptPath } from "./transcript.js";
import { HELD, ItemsTree, type TreeFilter, type View, VIEW_KEY, buildTree, defaultExpanded, itemMatches, parentIds, summaryCounts, useExpanded } from "./tree.js";

/** "host slept N min" for a host sleep's gap, at least 1 min (only gaps over 60 s are recorded). */
export const sleptText = (gap_ms: number): string => t("host.slept", { min: Math.max(1, Math.round(gap_ms / 60_000)) });

/** One active claim pause for the banner: what it stops, when it began (model stall) and when it ends or is checked next. */
function pauseLine(p: PauseRow, now: number): string {
  const what = pauseLabel(p.name);
  if (p.name !== "model_stall") return t("pause.line", { name: p.name, what, end: p.ends_at });
  const due = Date.parse(p.ends_at) <= now;
  const vars = { name: p.name, what, end: p.ends_at, since: p.since ?? "" };
  if (p.since) return t(due ? "pause.stallSinceDue" : "pause.stallSinceAt", vars);
  return t(due ? "pause.stallDue" : "pause.stallAt", vars);
}

/** What the factory process is doing, in words: `text` is the status page's sentence, `label` one word for the header indicator. */
interface FactoryView {
  tone: "ok" | "warn" | "bad";
  text: string;
  label: string;
  /** Paused, stopped or failing: the states that get a page Notice. */
  notice: boolean;
}

function factoryView(factory: FactoryState | null, now: number, pauses: readonly PauseRow[]): FactoryView {
  if (factory === null || factory.state === "stopped") return { tone: "bad", text: t("factory.stopped"), label: t("status.stopped"), notice: true };
  const rev = shortRev(factory.rev);
  const target = shortRev(factory.target_rev);
  const updating = (text: string): FactoryView => ({ tone: "warn", text, label: t("status.updating"), notice: false });
  switch (factory.state) {
    case "running":
      if (pauses.length > 0) return { tone: "warn", text: pauses.map((p) => pauseLine(p, now)).join(" "), label: t("status.paused"), notice: true };
      return { tone: "ok", text: t("factory.running", { rev, time: ago(factory.since, now) }), label: t("status.running"), notice: false };
    case "building":
      return updating(t("factory.building", { target, rev }));
    case "draining":
      return updating(t("factory.draining", { target }));
    case "restarting":
      return updating(t("factory.restarting", { target }));
    case "build_failed":
      return { tone: "bad", text: t("factory.buildFailed", { target, rev }), label: t("status.failing"), notice: true };
    case "crashed":
      return { tone: "bad", text: t("factory.crashed", { error: factory.error ?? t("factory.exited") }), label: t("status.failing"), notice: true };
    case "migration_pending":
      return updating(factory.pending.length ? t("factory.migrationPendingList", { target, pending: factory.pending.join(", ") }) : t("factory.migrationPending", { target }));
    case "migration_draining":
      return updating(t("factory.migrationDraining", { target }));
    case "migration_ready":
      return updating(t("factory.migrationReady", { target }));
    default:
      return { tone: "warn", text: t("factory.other", { state: factory.state }), label: factory.state, notice: false };
  }
}

const BANNER_TONE = { ok: "bg-pill-ok-bg text-pill-ok-fg", warn: "bg-pill-warn-bg text-pill-warn-fg", bad: "bg-pill-bad-bg text-pill-bad-fg" } as const;

/** The Runners page's supervisor banner: what the factory process is doing (the status page's words). */
export function FactoryBanner({ factory, now, pauses = [] }: { factory: FactoryState | null | undefined; now: number; pauses?: readonly PauseRow[] | undefined }) {
  if (factory === undefined) return null;
  const v = factoryView(factory, now, pauses);
  return (
    <p role="status" data-testid="factory-banner" className={cn("mb-4 rounded-control px-3 py-2 text-sm text-pretty", BANNER_TONE[v.tone])}>
      {v.text}
    </p>
  );
}

/** The Needs-you header's factory status: a dot and one word, the revision (or the full sentence) in a Tooltip. */
function FactoryIndicator({ view, factory, now }: { view: FactoryView; factory: FactoryState | null; now: number }) {
  const tip = factory && view.tone === "ok" ? t("status.revision", { rev: shortRev(factory.rev), time: ago(factory.since, now) }) : view.text;
  return (
    <Tooltip text={tip} placement="bottom">
      <span data-testid="factory-status" tabIndex={0} className={cn("inline-flex rounded-pill", FOCUS)}>
        <StatusBadge level={view.tone === "ok" ? "running" : view.tone === "bad" ? "needs_you" : "needs_approval"} size="sm">{view.label}</StatusBadge>
      </span>
    </Tooltip>
  );
}

/** What each claim pause stops (design §5 Restarts). */
const PAUSE_LABELS: Record<string, MessageKey> = {
  rate_limit: "pause.rate_limit",
  forge_auth: "pause.forge_auth",
  preflight_access: "pause.preflight_access",
  model_stall: "pause.model_stall",
};
const pauseLabel = (name: string): string => {
  const key = PAUSE_LABELS[name];
  return key ? t(key) : name;
};

/** One pause with its "Resume now" button; the endpoint's refusal shows next to the button. */
function PauseItem({ pause, token, now }: { pause: PauseRow; token: string | null; now: number }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postResume(token, pause.name);
      if (!r.ok) setError(r.error);
      else await client.invalidateQueries({ queryKey: [API.pauses] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const ends = Date.parse(pause.ends_at);
  const when = t(pause.name === "model_stall" ? "pause.nextProbe" : "pause.ends", { time: pause.ends_at });
  return (
    <li data-pause={pause.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="font-mono text-xs">{pause.name}</span>
      <span className="min-w-0 text-pretty text-text-1">{pauseLabel(pause.name)}</span>
      <span className="min-w-0 tabular-nums break-words text-text-2" title={pause.ends_at}>
        {when}{ends > now ? ` (${t("format.in", { time: ago(new Date(now).toISOString(), ends) })})` : ""}
      </span>
      {token !== null && (
        <Button variant="secondary" disabled={busy} onClick={() => void resume()}>
          {t("pause.resume")}
        </Button>
      )}
      {error && <span role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error}</span>}
    </li>
  );
}

/** Every claim pause in effect, each with "Resume now". Hidden while there is none. */
export function ClaimPauses({ now }: { now: number }) {
  const q = useApi<PausesView>(API.pauses);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data || q.data.pauses.length === 0) return null;
  return (
    <Section title={t("pause.title")} count={q.data.pauses.length}>
      <ul aria-label={t("pause.title")} className="space-y-1">
        {q.data.pauses.map((p) => <PauseItem key={p.name} pause={p} token={q.data.csrf_token} now={now} />)}
      </ul>
    </Section>
  );
}

/**
 * Needs you: the header (title, count, the factory's status), a Notice only when the factory is paused, stopped or
 * failing, then what waits for the operator in groups, with one line per kind of note; then the claim pauses.
 */
export function NeedsYouPage() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  const items = useApi<Items>(API.items);
  const pauses = useApi<PausesView>(API.pauses);
  const rows = items.data?.items ?? [];
  const titles = useMemo(() => byId(items.data?.items), [items.data]);
  // One row per item that waits on the operator; an item started past a deadlock goes on by itself (decision 1).
  const needs = needsYou(rows);
  const deadlocks = rows.filter((i) => i.why?.code === "deadlock").length;
  const o = overview.data;
  const factory = o?.factory;
  const view = factory === undefined ? null : factoryView(factory, now, pauses.data?.pauses ?? []);
  return (
    <>
      <PageHeader
        title={t("page.needs")}
        description={items.data ? t("needs.count", { count: needs.length }) : undefined}
        actions={view && factory !== undefined && <FactoryIndicator view={view} factory={factory} now={now} />}
      />
      {view?.notice && (
        <div className="mb-4">
          <Notice tone={view.tone === "bad" ? "bad" : "warn"}>{view.text}</Notice>
        </div>
      )}
      {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading /> : <NeedsGroups items={needs} now={now} titles={titles} empty={t("needs.empty")} />}
      <FloorNotes actions={o?.system_actions ?? []} deadlocks={deadlocks} />
      <ClaimPauses now={now} />
    </>
  );
}

/** Activity: what runs now, then the numbers of the last 24 hours. */
export function ActivityPage() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  const items = useApi<Items>(API.items);
  const runs = useApi<{ runs: RunRow[] }>(API.runs);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const o = overview.data;
  return (
    <>
      <Section title={t("running.label")} count={runs.data?.runs.filter((r) => r.status === "running").length}>
        {runs.isError ? <ErrorNote error={runs.error} /> : !runs.data ? <Loading rows={2} /> : <RunningTable runs={runs.data.runs} items={map} now={now} />}
      </Section>
      {o && (o.unreviewed_merges_7d ?? 0) > 0 && (
        <p data-testid="unreviewed-merges-line" className="mb-4 text-sm">
          {t("activity.unreviewed", { count: o.unreviewed_merges_7d ?? 0 })}{" "}
          <Link href={`${BASE}health`} className={LINK_CLASS}>{t("activity.unreviewedLink")}</Link>
        </p>
      )}
      {o && (
        <Section title={t("activity.last24h")}>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [t("activity.succeeded"), String(o.last_24h.succeeded)],
              [t("activity.failed"), String(o.last_24h.failed), `${BASE}failures?window=24h`],
              [t("col.tokens"), tokens(o.last_24h.tokens)],
              [t("activity.openItems"), String(Object.entries(o.stages).filter(([s]) => s !== "CLOSED").reduce((n, [, v]) => n + v, 0))],
            ].map(([k, v, href]) => (
              <div key={k} className="rounded-control border border-border px-3 py-2">
                <dt className="text-xs text-text-2">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {href ? <Link href={href} className={LINK_CLASS}>{v}</Link> : v}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
    </>
  );
}

const STATE_FILTERS = ["needs", "ready_to_merge", "needs_approval", "needs_triage", "stuck", "running", "queued", "blocked_by_task", "closed"] as const;
const FILTER_LABELS: Record<string, string> = { ...LEVEL_LABELS, needs: t("page.needs"), held: t("items.held") };

/** The Work filter named by the `state` query parameter (the Queue page's old address leads here); an unknown value is no filter. */
function initialState(): string | null {
  const s = new URLSearchParams(location.search).get("state");
  return s !== null && (s === HELD || (STATE_FILTERS as readonly string[]).includes(s)) ? s : null;
}

/** The saved view: the tree unless the browser chose the list. */
function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree";
  } catch {
    return "tree";
  }
}

/** "rate limit: ok", or until when the rate limit pause lasts (the pauses read; "–" before it arrives). */
function rateLimitText(pauses: PausesView | undefined): string {
  if (!pauses) return "–";
  const p = pauses.pauses.find((x) => x.name === "rate_limit");
  return p ? t("items.ratePaused", { time: p.ends_at }) : t("items.rateOk");
}

/** The queued runs: the one source of Work's Queued list, its filter count and its "N queued" (the same runs as overview.queued). */
function useQueuedRuns() {
  return useApi<{ queue: QueueRow[] }>(API.queue);
}

/** The tree's summary line; each count is a button that sets the matching state filter. */
function Summary({ rows, queued, rateLimit, onFilter }: { rows: readonly ItemRow[]; queued: number | undefined; rateLimit: string; onFilter: (s: string) => void }) {
  const c = summaryCounts(rows);
  const parts: [string, number | string, string][] = [[t("items.running"), c.running, "running"], [t("items.queued"), queued ?? "…", "queued"], [t("items.heldLower"), c.held, HELD], [t("items.needs"), c.needs, "needs"]];
  return (
    <p data-testid="summary" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {parts.map(([label, n, filter]) => (
        <Button key={filter} variant="ghost" size="sm" onClick={() => onFilter(filter)} className={cn("tabular-nums", LINK_CLASS)}>{t("items.count", { count: n, label })}</Button>
      ))}
      <span>{t("items.rateLimit", { state: rateLimit })}</span>
    </p>
  );
}

/** Every work item as a tree (the default) or, with the List toggle, the flat list; filterable by state and search. */
export function ItemsPage() {
  const now = useNow();
  const [view, setViewState] = useState<View>(savedView);
  const [state, setState] = useState<string | null>(initialState);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const tree = view === "tree";
  const queuedView = state === "queued";
  const setView = (v: View) => {
    setViewState(v);
    if (v === "list" && state === HELD) setState(null);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage is blocked: the choice lasts until reload.
    }
  };
  // One request per poll: the tree reads every row once and filters in the page, the list asks the server.
  const params = new URLSearchParams();
  if (tree) params.set("closed", "1");
  else if (!queuedView) {
    if (state) params.set("state", state);
    if (q.trim()) params.set("q", q.trim());
  }
  const query = params.toString();
  const items = useApi<Items>(query ? `${API.items}?${query}` : API.items);
  const overview = useApi<Overview>(API.overview);
  const pauses = useApi<PausesView>(API.pauses);
  const queue = useQueuedRuns();
  const rows = items.data?.items ?? [];
  const filter: TreeFilter = { state, q, showClosed };
  const nodes = useMemo(() => buildTree(rows, filter), [items.data, state, q, showClosed]);
  const [expanded, setExpanded] = useExpanded(defaultExpanded(nodes));
  const itemsById = useMemo(() => byId(items.data?.items), [items.data]);
  const counted = (s: string) => (s === "queued" ? (queue.data?.queue.length ?? "…") : tree ? rows.filter((r) => itemMatches(r, { state: s, q, showClosed })).length : (items.data?.facets.state[s] ?? 0));
  const allCount = tree ? rows.filter((r) => itemMatches(r, { state: null, q, showClosed })).length : (items.data?.facets.allStates ?? "");
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("items.searchPlaceholder")}
          aria-label={t("items.searchLabel")}
          className="w-full max-w-sm"
        />
        <ButtonRow role="group" aria-label={t("items.view")}>
          {(["tree", "list"] as const).map((v) => (
            <Button key={v} size="sm" aria-pressed={view === v} onClick={() => setView(v)}>{v === "tree" ? t("items.tree") : t("items.list")}</Button>
          ))}
        </ButtonRow>
        {tree && (
          <ButtonRow>
            <Button size="sm" aria-pressed={showClosed} onClick={() => setShowClosed(!showClosed)}>{t("items.showClosed")}</Button>
            <Button size="sm" onClick={() => setExpanded(parentIds(nodes))}>{t("items.expandAll")}</Button>
            <Button size="sm" onClick={() => setExpanded([])}>{t("items.collapseAll")}</Button>
          </ButtonRow>
        )}
      </div>
      {tree && items.data && <Summary rows={rows} queued={queue.data?.queue.length} rateLimit={rateLimitText(pauses.data)} onFilter={setState} />}
      <ButtonRow role="group" aria-label={t("items.filterByState")} className="mb-3">
        {[null, ...(tree ? [HELD] : []), ...STATE_FILTERS].map((s) => (
          <Button key={s ?? "all"} size="sm" aria-pressed={state === s} onClick={() => setState(s)} className="tabular-nums">
            {t("items.filterCount", { label: s === null ? t("items.all") : FILTER_LABELS[s]!, count: s === null ? allCount : counted(s) })}
          </Button>
        ))}
      </ButtonRow>
      {queuedView ? (
        <Section title={t("queue.title")} count={queue.data?.queue.length}>
          {queue.isError ? <ErrorNote error={queue.error} /> : !queue.data || !items.data ? <Loading rows={4} /> : <QueueTable queue={queue.data.queue} items={itemsById} now={now} />}
        </Section>
      ) : items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading rows={6} /> : tree ? (
        nodes.length === 0 ? <Empty>{t("items.noMatch")}</Empty> : (
          <ItemsTree nodes={nodes} rows={rows} now={now} expanded={expanded} onExpanded={setExpanded} />
        )
      ) : (
        <ItemsTable items={items.data.items} now={now} label={t("items.label")} plugins={overview.data?.plugins} empty={t("items.noMatch")} />
      )}
    </>
  );
}

/** One work item: its state, command buttons, thread, runs (with errors) and timeline. */
export function ItemPage({ id }: { id: string }) {
  const now = useNow();
  const q = useApi<ItemDetail>(API.item(id));
  const viewer = useViewer();
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={6} />;
  const { item, runs, timeline } = q.data;
  // State changes and host sleeps of the item's runs, newest first.
  const entries: ({ kind: "change"; at: string; t: ItemDetail["timeline"][number] } | { kind: "sleep"; at: string; h: HostSleepRow })[] = [
    ...timeline.map((t) => ({ kind: "change" as const, at: t.at, t })),
    ...(q.data.sleeps ?? []).map((h) => ({ kind: "sleep" as const, at: h.woke_at, h })),
  ];
  entries.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const transcripts = q.data.transcripts ?? {};
  const short = shortSource(item.source.id);
  const level = detailLevel(item);
  return (
    <>
      <nav aria-label={t("item.breadcrumb")} className="mb-1 text-sm">
        <Link href={`${BASE}items`} className={LINK_CLASS}>{t("page.work")}</Link>
        <span className="text-text-3"> / </span>
        <Link href={itemPath(item.id)} aria-current="page" title={item.source.id} className={cn("inline-block max-w-[16ch] truncate align-bottom tabular-nums", LINK_CLASS)}>{short}</Link>
      </nav>
      <h2 className="text-balance text-base font-semibold break-words">{item.title ?? short}</h2>
      {item.parent_id && (
        <p data-testid="parent" className="mt-1 text-sm">
          {t("item.phase", { phase: item.phase ?? "?" })} <Link href={itemPath(item.parent_id)} className={LINK_CLASS}>{t("item.splitParent")}</Link>
        </p>
      )}
      <ItemCommands
        id={item.id}
        commands={q.data.commands ?? []}
        replies={q.data.replies ?? []}
        reason={item.why ? (
          <p data-testid="why" className="text-sm text-pretty break-words">
            <WhyText why={item.why} />
          </p>
        ) : null}
      />
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {([
          [t("col.state"), <StatusBadge level={level} size="sm">{LEVEL_LABELS[level] ?? level}{item.close_reason ? ` (${item.close_reason.replace(/_/g, " ")})` : ""}</StatusBadge>],
          [t("item.source"), isHttpUrl(item.source.link) ? <SourceLink source={item.source} className="inline-block align-bottom" /> : short],
          [t("item.tier"), item.tier ?? "–"],
          [t("col.pr"), item.change_ref === null ? "–" : <UrlOrText url={item.change_url} text={`#${item.change_ref}`} />],
          [t("item.specComment"), item.spec_comment_url ? <UrlOrText url={item.spec_comment_url} text={t("item.specCommentLink")} /> : "–"],
          [t("item.reviewLoops"), item.loop_count],
          [t("item.restarts"), item.restart_count],
          [t("col.tokens"), tokens(item.token_cost)],
          [t("item.updated"), t("time.ago", { time: ago(item.updated_at, now) })],
        ] as const).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-text-2">{k}</dt>
            <dd className="truncate tabular-nums">{typeof v === "object" ? v : String(v)}</dd>
          </div>
        ))}
      </dl>
      <details data-ids className="mt-2 text-sm">
        <summary className="cursor-pointer text-text-2">{t("ids.summary")}</summary>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-xs text-text-2">{t("ids.item")}</dt>
          <dd className="min-w-0"><CopyText value={item.id} what="item ID" /></dd>
          <dt className="text-xs text-text-2">{t("ids.source")}</dt>
          <dd className="min-w-0"><CopyText value={item.source.id} what="source ID" /></dd>
        </dl>
      </details>
      <Thread entries={q.data.thread ?? []} now={now} />
      <Phases phases={item.phases ?? []} />
      {item.merge_check && (
        <Section title={t("item.mergeCheck")}>
          <p className="text-sm" data-merge-check-detail>
            <MergeCheckNote check={item.merge_check} />
            {item.merge_check.base_sha && item.merge_check.checked_at && (
              <span className="ml-2 text-text-2">
                {t("item.againstBase")} <code className="font-mono text-xs" title={item.merge_check.base_sha}>{item.merge_check.base_sha.slice(0, 12)}</code>{t("item.checkedAgo", { time: ago(item.merge_check.checked_at, now) })}
              </span>
            )}
          </p>
          {item.merge_check.conflicts.length > 0 && (
            <ul aria-label={t("item.conflicting")} className="mt-1 list-disc pl-6 font-mono text-xs">
              {item.merge_check.conflicts.map((f) => <li key={f}>{f}</li>)}
            </ul>
          )}
        </Section>
      )}
      <Section title={t("item.runs")} count={runs.length}>
        {runs.length === 0 ? <Empty>{t("item.noRun")}</Empty> : (
          <Table label={t("item.runs")} head={[t("item.kind"), t("col.attempt"), t("item.status"), t("item.error"), t("col.worker"), t("item.started"), t("item.took"), t("col.tokens"), t("item.transcript")]}>
            {[...runs].reverse().map((r) => (
              <Tr key={r.id} data-run={r.id}>
                <Td className="min-w-40">
                  {r.kind} <code className="font-mono text-xs break-all text-text-2">{r.id}</code>
                </Td>
                <Td className="tabular-nums">{t("item.attempt", { attempt: r.attempt })}</Td>
                <Td><Badge level={r.status === "running" ? "running" : r.status === "failed" ? "stuck" : undefined}>{r.status}</Badge></Td>
                <Td className="max-w-md min-w-40 text-xs break-words text-text-1">
                  {r.error ? <><span className="font-medium">{r.error.code}</span>{r.error.detail ? `: ${r.error.detail}` : ""}</> : "–"}
                </Td>
                <Td><WorkerName id={r.attempts?.at(-1)?.worker_id} /></Td>
                <Td className="tabular-nums whitespace-nowrap">{r.started_at ? t("time.ago", { time: ago(r.started_at, now) }) : "–"}</Td>
                <Td className="tabular-nums">{r.started_at && r.finished_at ? ago(r.started_at, Date.parse(r.finished_at)) : "–"}</Td>
                <Td className="tabular-nums">{tokens(r.tokens)}</Td>
                <Td className="whitespace-nowrap">
                  {(transcripts[r.id]?.length ?? 0) > 0 ? (
                    <Link href={transcriptPath(item.id, r.id)} className={LINK_CLASS}>{t("item.open")}</Link>
                  ) : "–"}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title={t("item.timeline")} count={entries.length}>
        <ol className="space-y-1 text-sm">
          {entries.map((e) => {
            if (e.kind === "sleep") return (
              <li key={`sleep:${e.h.worker_id}:${e.h.woke_at}`} className="flex gap-3" data-testid="host-sleep">
                <span className="w-12 shrink-0 text-right text-text-3 tabular-nums">{ago(e.h.woke_at, now)}</span>
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
      </Section>
    </>
  );
}

/** A split parent's phases in merge order, each linking to its own item page. */
function Phases({ phases }: { phases: readonly PhaseRow[] }) {
  if (phases.length === 0) return null;
  return (
    <Section title={t("item.phases")} count={phases.length}>
      <ol aria-label={t("item.phases")} className="space-y-1 text-sm">
        {phases.map((p) => (
          <li key={p.id} data-phase={p.phase} className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-text-3 tabular-nums">{p.phase}.</span>
            <Link href={itemPath(p.id)} className={cn("min-w-0 break-words", LINK_CLASS)}>{p.title ?? p.source.id}</Link>
            <Badge>{p.stage}</Badge>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** A link when the URL is http(s); the text alone otherwise (a withheld marker, a local path, anything else). */
function UrlOrText({ url, text }: { url: string | null | undefined; text: string }) {
  if (isHttpUrl(url)) return <a href={url} target="_blank" rel="noreferrer" className={LINK_CLASS}>{text}</a>;
  return <span>{url && url !== text ? `${text} (${url})` : text}</span>;
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

/** A spec field's value as markdown: a list becomes a bullet list. */
function specMarkdown(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => `- ${shortValue(x)}`).join("\n");
  return shortValue(v);
}

function TimelineRow({ entry, now, viewer }: { entry: TimelineEntry; now: number; viewer: string | null }) {
  const [open, setOpen] = useState(false);
  const changes = Object.entries(entry.changes);
  const short = changes.filter(([f]) => !(f in SPEC_FIELDS));
  const spec = changes.filter(([f]) => f in SPEC_FIELDS);
  return (
    <li className="flex gap-3">
      <span className="w-12 shrink-0 text-right text-text-3 tabular-nums">{ago(entry.at, now)}</span>
      <div className="min-w-0 flex-1 break-words">
        <span className="font-medium">{entry.reason ?? t("item.change")}</span>
        <span className="text-text-3">{t("item.by")}</span>
        <PersonName id={entry.actor.kind === "system" ? null : entry.actor.id} name={entry.actor.name} viewer={viewer} />
        {short.length > 0 && (
          <span className="text-text-2">
            {" "}— {short.map(([f, c]) => `${f}: ${shortValue(parseValue(c.from))} → ${shortValue(parseValue(c.to))}`).join(", ")}
          </span>
        )}
        {spec.length > 0 && (
          <div className="mt-1">
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} className={LINK_CLASS}>
              {open ? t("item.specHide") : t("item.specShow")}
            </Button>
            {open && (
              <div data-spec className="mt-2 space-y-3 rounded-control border border-border p-3">
                {spec.map(([f, c]) => (
                  <div key={f}>
                    <h3 className="mb-1 text-xs font-semibold text-text-2">{SPEC_FIELDS[f]}</h3>
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

/** One live worker process: host, pid, version or start time, and its slots (busy, idle, current, max). */
function ProcessRow({ p, items, now }: { p: WorkerProcess; items: ReadonlyMap<string, ItemRow>; now: number }) {
  const draining = p.slots === 0;
  return (
    <li data-testid="worker-process" className="rounded-control border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-mono text-xs font-semibold">{p.host}</span>
        <span className="tabular-nums">{t("runners.pid", { pid: p.pid })}</span>
        <span className="tabular-nums text-text-2">{t("runners.started", { time: ago(p.started_at, now) })}</span>
        {draining && <Badge level="needs_approval">{t("runners.draining")}</Badge>}
        <span className="tabular-nums" data-slots>
          {t("runners.slots", { busy: p.busy, idle: p.idle, slots: p.slots, max: p.max_slots })}
        </span>
      </div>
      {p.runs.length > 0 && (
        <ul aria-label={t("runners.runsOf", { host: p.host, pid: p.pid })} className="mt-1 space-y-0.5 text-xs">
          {p.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-3">
              <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{items.get(r.work_item_id)?.title || r.work_item_id}</Link>
              <span>{r.kind}</span>
              <WorkerName id={r.worker_id} />
              <span className="tabular-nums">{ago(r.started_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const WORKERS_SOURCE: Record<string, string> = { override: t("runners.sourceOverride"), file: t("runners.sourceFile"), default: t("runners.sourceDefault") };

export function RunnersPage() {
  const now = useNow();
  const workers = useApi<WorkersView>(API.workers);
  const overview = useApi<Overview>(API.overview);
  const runs = useApi<{ runs: RunRow[] }>(API.runs);
  const items = useApi<Items>(API.items);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const f = overview.data?.factory;
  const processes = workers.data?.processes ?? [];
  return (
    <>
      <FactoryBanner factory={f} now={now} />
      {f && (
        <p data-testid="effective-workers" className="mb-4 text-sm">
          {t("runners.setting")} <span className="font-semibold tabular-nums">{f.workers}</span> ({WORKERS_SOURCE[f.workers_source] ?? f.workers_source})
        </p>
      )}
      <Section title={t("runners.processes")} count={workers.data?.processes ? processes.length : undefined}>
        {workers.isError ? <ErrorNote error={workers.error} /> : !workers.data ? <Loading rows={2} /> : workers.data.processes_error ? (
          <ErrorNote error={new Error(workers.data.processes_error)} />
        ) : processes.length === 0 ? (
          <Empty>{t("runners.none")}</Empty>
        ) : (
          <ul aria-label={t("runners.processes")} className="space-y-2">
            {processes.map((p) => <ProcessRow key={p.process_id} p={p} items={map} now={now} />)}
          </ul>
        )}
      </Section>
      <Section title={t("running.label")}>
        {runs.data ? <RunningTable runs={runs.data.runs} items={map} now={now} /> : <Loading rows={2} />}
      </Section>
    </>
  );
}

const HEALTH_TONE: Record<string, string> = { ok: "running", warn: "needs_approval", fail: "stuck" };

function CheckList({ checks }: { checks: Health["checks"] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {checks.map((c, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <Badge level={HEALTH_TONE[c.status]}>{c.status}</Badge>
          <span className="min-w-0 text-pretty break-words">{c.msg}</span>
        </li>
      ))}
    </ul>
  );
}

export function HealthPage() {
  const now = useNow();
  // Each read runs the checks: every 30 s, not every 3 s.
  const health = useApi<Health>(API.health, 30_000);
  const merges = useApi<UnreviewedMerges>(API.unreviewedMerges, 30_000);
  const viewer = useViewer();
  if (health.isError) return <ErrorNote error={health.error} />;
  if (!health.data) return <Loading rows={6} />;
  const order = ["fail", "warn", "ok"];
  const checks = [...health.data.checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  // Warn and fail rows stay in view; ok rows fold behind their count ("22 ok").
  const open = checks.filter((c) => c.status !== "ok");
  const fine = checks.filter((c) => c.status === "ok");
  const sleeps = health.data.sleeps ?? [];
  return (
    <>
      <ClaimPauses now={now} />
      <Section title={t("health.checks", { time: ago(health.data.checked_at, now) })} count={checks.length}>
        <CheckList checks={open} />
        {fine.length > 0 && (
          <details data-testid="ok-checks" className="mt-2 text-sm">
            <summary className="cursor-pointer text-text-2">{t("health.okCount", { count: fine.length })}</summary>
            <CheckList checks={fine} />
          </details>
        )}
      </Section>
      <Section title={t("health.sleeps")} count={sleeps.length}>
        {sleeps.length === 0 ? (
          <Empty>{t("health.noSleep")}</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {sleeps.map((h) => (
              <li key={`${h.worker_id}:${h.woke_at}`} className="flex items-baseline gap-3" data-testid="host-sleep">
                <span className="font-medium">{sleptText(h.gap_ms)}</span>
                <span className="tabular-nums text-text-2">{t("health.sleepWhen", { when: h.woke_at.slice(0, 16).replace("T", " "), time: ago(h.woke_at, now) })}</span>
                <span className="min-w-0 text-text-3"><WorkerName id={h.worker_id} /></span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div id="unreviewed-merges">
        <Section title={t("health.merges")} count={merges.data?.merges.length}>
          {merges.isError ? <ErrorNote error={merges.error} /> : !merges.data ? <Loading rows={2} /> : merges.data.merges.length === 0 ? (
            <Empty>{t("health.noMerges")}</Empty>
          ) : (
            <Table label={t("health.merges")} head={[t("col.pr"), t("health.mergedBy"), t("health.mergeCommit"), t("col.when")]}>
              {merges.data.merges.map((m) => (
                <Tr key={`${m.project}#${m.change_ref}`}>
                  <Td className="tabular-nums">
                    {m.change_url ? <a href={m.change_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{m.change_ref}</a> : `#${m.change_ref}`}
                  </Td>
                  <Td className="text-xs break-words">{m.merged_by && m.merged_by !== "unknown" ? <PersonName id={m.merged_by} viewer={viewer} /> : t("format.unknown")}</Td>
                  <Td className="font-mono text-xs">{m.merge_sha}</Td>
                  <Td className="tabular-nums whitespace-nowrap">{t("time.ago", { time: ago(m.recorded_at, now) })}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Section>
      </div>
    </>
  );
}
