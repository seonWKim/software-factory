import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  API, type FactoryState, type Health, type HostSleepRow, type ItemDetail, type ItemRow, type Items, type Overview, type PauseRow, type PhaseRow, type PausesView, type QueueRow, type RunRow,
  type UnreviewedMerges, type WorkerProcess, type WorkersView, postResume, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Markdown } from "../components/ui/markdown.js";
import { cn } from "../lib/cn.js";
import { LEVEL_LABELS, NEEDS_YOU_LEVELS, ago, isHttpUrl, shortRev, tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { ItemsTable, MergeCheckNote, QueueTable, RunningTable, SourceLink, WhyText, useNow } from "./common.js";
import { ItemCommands } from "./item-commands.js";
import { SystemActions } from "./system-banner.js";
import { Thread } from "./thread.js";
import { transcriptPath } from "./transcript.js";
import { HELD, ItemsTree, type TreeFilter, type View, VIEW_KEY, buildTree, defaultExpanded, itemMatches, parentIds, summaryCounts, useExpanded } from "./tree.js";

/** "host slept N min" for a host sleep's gap, at least 1 min (only gaps over 60 s are recorded). */
export const sleptText = (gap_ms: number): string => `host slept ${Math.max(1, Math.round(gap_ms / 60_000))} min`;

const byId = (items: readonly ItemRow[] | undefined) => new Map((items ?? []).map((i) => [i.id, i]));

/** One active claim pause for the banner: what it stops, when it began (model stall) and when it ends or is checked next. */
function pauseLine(p: PauseRow, now: number): string {
  const what = PAUSE_LABELS[p.name] ?? p.name;
  if (p.name !== "model_stall") return `Paused (${p.name}): ${what}; until ${p.ends_at}.`;
  const began = p.since ? ` since ${p.since}` : "";
  const next = Date.parse(p.ends_at) <= now ? "the next check is due" : `next check at ${p.ends_at}`;
  return `Paused (${p.name}): ${what}${began}; ${next}.`;
}

/** The supervisor banner: what the factory process is doing (the status page's words, shorter). */
export function FactoryBanner({ factory, now, pauses = [] }: { factory: FactoryState | null | undefined; now: number; pauses?: readonly PauseRow[] | undefined }) {
  if (factory === undefined) return null;
  const bad = "bg-pill-bad-bg text-pill-bad-fg";
  const warn = "bg-pill-warn-bg text-pill-warn-fg";
  const ok = "bg-pill-ok-bg text-pill-ok-fg";
  let tone = warn;
  let text: string;
  if (factory === null || factory.state === "stopped") {
    tone = bad;
    text = "Factory stopped. No runs start. Start it with npm run factory -- dev.";
  } else {
    const rev = shortRev(factory.rev);
    const target = shortRev(factory.target_rev);
    switch (factory.state) {
      case "running":
        if (pauses.length > 0) {
          text = pauses.map((p) => pauseLine(p, now)).join(" ");
          break;
        }
        tone = ok;
        text = `Factory running: revision ${rev}, since ${ago(factory.since, now)} ago.`;
        break;
      case "building":
        text = `Building ${target}; runs continue on ${rev} meanwhile.`;
        break;
      case "draining":
        text = `Updating to ${target}: new runs are paused until the running process finishes its in-flight runs.`;
        break;
      case "restarting":
        text = `Starting ${target}. New runs start in a moment.`;
        break;
      case "build_failed":
        tone = bad;
        text = `Revision ${target} failed to build. Still running ${rev}.`;
        break;
      case "crashed":
        tone = bad;
        text = `Factory not running: ${factory.error ?? "the process exited"}.`;
        break;
      case "migration_pending":
        text = `Update to ${target} waits for npm run migrate${factory.pending.length ? ` (pending: ${factory.pending.join(", ")})` : ""}.`;
        break;
      case "migration_draining":
        text = `Migrating to ${target}: new runs are paused.`;
        break;
      case "migration_ready":
        text = `Migrating to ${target}: the steps are being applied.`;
        break;
      default:
        text = `Factory: ${factory.state}.`;
    }
  }
  return (
    <p role="status" data-testid="factory-banner" className={cn("mb-4 rounded-control px-3 py-2 text-sm text-pretty", tone)}>
      {text}
    </p>
  );
}

/** What each claim pause stops (design §5 Restarts). */
const PAUSE_LABELS: Record<string, string> = {
  rate_limit: "Usage or rate limit: no run starts",
  forge_auth: "Forge refused the credentials: no implement or update run starts",
  preflight_access: "Push or PR access check failed: no implement or update run starts",
  model_stall: "Model not answering: no run starts until a probe answers",
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
  const label = pause.name === "model_stall" ? "next probe" : "ends";
  return (
    <li data-pause={pause.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="font-mono text-xs">{pause.name}</span>
      <span className="min-w-0 text-pretty text-text-1">{PAUSE_LABELS[pause.name] ?? pause.name}</span>
      <span className="min-w-0 tabular-nums break-words text-text-2" title={pause.ends_at}>
        {label} at {pause.ends_at}{ends > now ? ` (in ${ago(new Date(now).toISOString(), ends)})` : ""}
      </span>
      {token !== null && (
        <Button variant="outline" className="h-8 w-auto px-2" disabled={busy} onClick={() => void resume()}>
          Resume now
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
    <Section title="Claim pauses" count={q.data.pauses.length}>
      <ul aria-label="Claim pauses" className="space-y-1">
        {q.data.pauses.map((p) => <PauseItem key={p.name} pause={p} token={q.data.csrf_token} now={now} />)}
      </ul>
    </Section>
  );
}

/** Needs you: the factory banner and claim pauses, then what waits for the operator and the system actions. */
export function NeedsYouPage() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  const items = useApi<Items>(API.items);
  const pauses = useApi<PausesView>(API.pauses);
  const needs = (items.data?.items ?? []).filter((i) => (NEEDS_YOU_LEVELS as readonly string[]).includes(i.level));
  const o = overview.data;
  const actions = o?.system_actions ?? [];
  return (
    <>
      <FactoryBanner factory={o?.factory} now={now} pauses={pauses.data?.pauses} />
      <ClaimPauses now={now} />
      <Section title="Needs you" count={items.data ? needs.length + actions.length : undefined}>
        <SystemActions actions={actions} />
        {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading /> : (
          <ItemsTable items={needs} now={now} label="Needs you" plugins={o?.plugins} actions empty="Nothing waits for you. New specs, failed runs and PRs ready to merge show up here." />
        )}
      </Section>
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
      <Section title="Running now" count={runs.data?.runs.filter((r) => r.status === "running").length}>
        {runs.isError ? <ErrorNote error={runs.error} /> : !runs.data ? <Loading rows={2} /> : <RunningTable runs={runs.data.runs} items={map} now={now} />}
      </Section>
      {o && (o.unreviewed_merges_7d ?? 0) > 0 && (
        <p data-testid="unreviewed-merges-line" className="mb-4 text-sm">
          {o.unreviewed_merges_7d} PRs merged without review in the last 7 days.{" "}
          <Link href={`${BASE}health`} className={LINK_CLASS}>See them on Health</Link>
        </p>
      )}
      {o && (
        <Section title="Last 24 hours">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Runs succeeded", String(o.last_24h.succeeded)],
              ["Runs failed", String(o.last_24h.failed), `${BASE}failures?window=24h`],
              ["Tokens", tokens(o.last_24h.tokens)],
              ["Open items", String(Object.entries(o.stages).filter(([s]) => s !== "CLOSED").reduce((n, [, v]) => n + v, 0))],
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
const FILTER_LABELS: Record<string, string> = { ...LEVEL_LABELS, needs: "Needs you", held: "Held" };

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
  return p ? `paused until ${p.ends_at}` : "ok";
}

const buttonClass = (on: boolean) =>
  cn(
    "rounded-control border px-2 py-1 text-xs tabular-nums",
    on ? "border-text-1 bg-text-1 text-bg" : "border-border-strong hover:bg-surface-2",
  );

/** The tree's summary line; each count is a button that sets the matching state filter. */
function Summary({ rows, rateLimit, onFilter }: { rows: readonly ItemRow[]; rateLimit: string; onFilter: (s: string) => void }) {
  const c = summaryCounts(rows);
  const parts: [string, number, string][] = [["running", c.running, "running"], ["queued", c.queued, "queued"], ["held", c.held, HELD], ["needs you", c.needs, "needs"]];
  return (
    <p data-testid="summary" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {parts.map(([label, n, filter]) => (
        <button key={filter} type="button" onClick={() => onFilter(filter)} className={cn("tabular-nums", LINK_CLASS)}>{n} {label}</button>
      ))}
      <span>rate limit: {rateLimit}</span>
    </p>
  );
}

/** Every work item as a tree (the default) or, with the List toggle, the flat list; filterable by state and search. */
export function ItemsPage() {
  const now = useNow();
  const [view, setViewState] = useState<View>(savedView);
  const [state, setState] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const tree = view === "tree";
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
  else {
    if (state) params.set("state", state);
    if (q.trim()) params.set("q", q.trim());
  }
  const query = params.toString();
  const items = useApi<Items>(query ? `${API.items}?${query}` : API.items);
  const overview = useApi<Overview>(API.overview);
  const pauses = useApi<PausesView>(API.pauses);
  const rows = items.data?.items ?? [];
  const filter: TreeFilter = { state, q, showClosed };
  const nodes = useMemo(() => buildTree(rows, filter), [items.data, state, q, showClosed]);
  const [expanded, setExpanded] = useExpanded(defaultExpanded(nodes));
  const counted = (s: string) => (tree ? rows.filter((r) => itemMatches(r, { state: s, q, showClosed })).length : (items.data?.facets.state[s] ?? 0));
  const allCount = tree ? rows.filter((r) => itemMatches(r, { state: null, q, showClosed })).length : (items.data?.facets.allStates ?? "");
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by title or issue number"
          aria-label="Search work items"
          className="w-full max-w-sm rounded-control border border-border-strong bg-transparent px-2 py-1 text-sm"
        />
        <div role="group" aria-label="View" className="flex gap-1.5">
          {(["tree", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={buttonClass(view === v)}>{v === "tree" ? "Tree" : "List"}</button>
          ))}
        </div>
        {tree && (
          <div className="flex gap-1.5">
            <button type="button" aria-pressed={showClosed} onClick={() => setShowClosed(!showClosed)} className={buttonClass(showClosed)}>Show closed</button>
            <button type="button" onClick={() => setExpanded(parentIds(nodes))} className={buttonClass(false)}>Expand all</button>
            <button type="button" onClick={() => setExpanded([])} className={buttonClass(false)}>Collapse all</button>
          </div>
        )}
      </div>
      {tree && items.data && <Summary rows={rows} rateLimit={rateLimitText(pauses.data)} onFilter={setState} />}
      <div role="group" aria-label="Filter by state" className="mb-3 flex flex-wrap gap-1.5">
        {[null, ...(tree ? [HELD] : []), ...STATE_FILTERS].map((s) => (
          <button key={s ?? "all"} type="button" aria-pressed={state === s} onClick={() => setState(s)} className={buttonClass(state === s)}>
            {s === null ? "All" : FILTER_LABELS[s]} {s === null ? allCount : counted(s)}
          </button>
        ))}
      </div>
      {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading rows={6} /> : tree ? (
        nodes.length === 0 ? <Empty>No work item matches this filter.</Empty> : (
          <ItemsTree nodes={nodes} rows={rows} now={now} expanded={expanded} onExpanded={setExpanded} />
        )
      ) : (
        <ItemsTable items={items.data.items} now={now} label="Work items" plugins={overview.data?.plugins} empty="No work item matches this filter." />
      )}
    </>
  );
}

/** One work item: its state, command buttons, thread, runs (with errors) and timeline. */
export function ItemPage({ id }: { id: string }) {
  const now = useNow();
  const q = useApi<ItemDetail>(API.item(id));
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
  return (
    <>
      <p className="mb-1 text-sm">
        <Link href={`${BASE}items`} className={LINK_CLASS}>Work</Link>
        <span className="text-text-3"> / </span>
        <SourceLink source={item.source} className="inline-block align-bottom" />
      </p>
      <h2 className="text-balance text-base font-semibold break-words">{item.title ?? item.source.id}</h2>
      {item.why && (
        <p data-testid="why" className="mt-2 text-sm text-pretty break-words">
          <WhyText why={item.why} />
        </p>
      )}
      {item.parent_id && (
        <p data-testid="parent" className="mt-1 text-sm">
          Phase {item.phase ?? "?"} of <Link href={itemPath(item.parent_id)} className={LINK_CLASS}>its split parent</Link>
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {([
          ["Stage", item.stage + (item.close_reason ? ` (${item.close_reason})` : "")],
          ["Tier", item.tier ?? "–"],
          ["PR", item.change_ref === null ? "–" : <UrlOrText url={item.change_url} text={`#${item.change_ref}`} />],
          ["Spec comment", item.spec_comment_url ? <UrlOrText url={item.spec_comment_url} text="spec comment" /> : "–"],
          ["Review loops", item.loop_count],
          ["Restarts", item.restart_count],
          ["Tokens", tokens(item.token_cost)],
          ["Updated", `${ago(item.updated_at, now)} ago`],
        ] as const).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-text-2">{k}</dt>
            <dd className="truncate tabular-nums">{typeof v === "object" ? v : String(v)}</dd>
          </div>
        ))}
      </dl>
      <ItemCommands id={item.id} commands={q.data.commands ?? []} replies={q.data.replies ?? []} />
      <Thread entries={q.data.thread ?? []} now={now} />
      <Phases phases={item.phases ?? []} />
      {item.merge_check && (
        <Section title="Merge check">
          <p className="text-sm" data-merge-check-detail>
            <MergeCheckNote check={item.merge_check} />
            {item.merge_check.base_sha && item.merge_check.checked_at && (
              <span className="ml-2 text-text-2">
                against base <code className="font-mono text-xs" title={item.merge_check.base_sha}>{item.merge_check.base_sha.slice(0, 12)}</code>, checked {ago(item.merge_check.checked_at, now)} ago
              </span>
            )}
          </p>
          {item.merge_check.conflicts.length > 0 && (
            <ul aria-label="Conflicting files" className="mt-1 list-disc pl-6 font-mono text-xs">
              {item.merge_check.conflicts.map((f) => <li key={f}>{f}</li>)}
            </ul>
          )}
        </Section>
      )}
      <Section title="Runs" count={runs.length}>
        {runs.length === 0 ? <Empty>No run yet.</Empty> : (
          <Table label="Runs" head={["Kind", "Attempt", "Status", "Error", "Worker", "Started", "Took", "Tokens", "Transcript"]}>
            {[...runs].reverse().map((r) => (
              <Tr key={r.id} data-run={r.id}>
                <Td className="min-w-40">
                  {r.kind} <code className="font-mono text-xs break-all text-text-2">{r.id}</code>
                </Td>
                <Td className="tabular-nums">attempt {r.attempt}</Td>
                <Td><Badge level={r.status === "running" ? "running" : r.status === "failed" ? "stuck" : undefined}>{r.status}</Badge></Td>
                <Td className="max-w-md min-w-40 text-xs break-words text-text-1">
                  {r.error ? <><span className="font-medium">{r.error.code}</span>{r.error.detail ? `: ${r.error.detail}` : ""}</> : "–"}
                </Td>
                <Td className="font-mono text-xs whitespace-nowrap">{r.attempts?.at(-1)?.worker_id ?? "–"}</Td>
                <Td className="tabular-nums whitespace-nowrap">{r.started_at ? `${ago(r.started_at, now)} ago` : "–"}</Td>
                <Td className="tabular-nums">{r.started_at && r.finished_at ? ago(r.started_at, Date.parse(r.finished_at)) : "–"}</Td>
                <Td className="tabular-nums">{tokens(r.tokens)}</Td>
                <Td className="whitespace-nowrap">
                  {(transcripts[r.id]?.length ?? 0) > 0 ? (
                    <Link href={transcriptPath(item.id, r.id)} className={LINK_CLASS}>Open</Link>
                  ) : "–"}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Timeline" count={entries.length}>
        <ol className="space-y-1 text-sm">
          {entries.map((e) => {
            if (e.kind === "sleep") return (
              <li key={`sleep:${e.h.worker_id}:${e.h.woke_at}`} className="flex gap-3" data-testid="host-sleep">
                <span className="w-12 shrink-0 text-right text-text-3 tabular-nums">{ago(e.h.woke_at, now)}</span>
                <span className="min-w-0">
                  <span className="font-medium">{sleptText(e.h.gap_ms)}</span>
                  <span className="text-text-3"> on {e.h.worker_id}</span>
                </span>
              </li>
            );
            return <TimelineRow key={e.t.version} entry={e.t} now={now} />;
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
    <Section title="Phases" count={phases.length}>
      <ol aria-label="Phases" className="space-y-1 text-sm">
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
  problem: "Problem",
  scope: "Scope",
  desired_output: "Desired output",
  done_criteria: "Done criteria",
  files_to_change: "Files to change",
  allowed_paths: "Allowed paths",
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

function TimelineRow({ entry: t, now }: { entry: TimelineEntry; now: number }) {
  const [open, setOpen] = useState(false);
  const changes = Object.entries(t.changes);
  const short = changes.filter(([f]) => !(f in SPEC_FIELDS));
  const spec = changes.filter(([f]) => f in SPEC_FIELDS);
  return (
    <li className="flex gap-3">
      <span className="w-12 shrink-0 text-right text-text-3 tabular-nums">{ago(t.at, now)}</span>
      <div className="min-w-0 flex-1 break-words">
        <span className="font-medium">{t.reason ?? "change"}</span>
        <span className="text-text-3"> by {t.actor.kind === "system" ? "the factory" : (t.actor.id ?? t.actor.kind)}</span>
        {short.length > 0 && (
          <span className="text-text-2">
            {" "}— {short.map(([f, c]) => `${f}: ${shortValue(parseValue(c.from))} → ${shortValue(parseValue(c.to))}`).join(", ")}
          </span>
        )}
        {spec.length > 0 && (
          <div className="mt-1">
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("text-xs", LINK_CLASS)}>
              spec written ({open ? "hide" : "show"})
            </button>
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
        <span className="tabular-nums">pid {p.pid}</span>
        <span className="tabular-nums text-text-2">started {ago(p.started_at, now)} ago</span>
        {draining && <Badge level="needs_approval">draining</Badge>}
        <span className="tabular-nums" data-slots>
          {p.busy} busy, {p.idle} idle, {p.slots} slots, max {p.max_slots}
        </span>
      </div>
      {p.runs.length > 0 && (
        <ul aria-label={`Runs of ${p.host} ${p.pid}`} className="mt-1 space-y-0.5 text-xs">
          {p.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-3">
              <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{items.get(r.work_item_id)?.title || r.work_item_id}</Link>
              <span>{r.kind}</span>
              <span className="font-mono">{r.worker_id}</span>
              <span className="tabular-nums">{ago(r.started_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const WORKERS_SOURCE: Record<string, string> = { override: "override", file: "config file", default: "default" };

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
          Worker setting: <span className="font-semibold tabular-nums">{f.workers}</span> ({WORKERS_SOURCE[f.workers_source] ?? f.workers_source})
        </p>
      )}
      <Section title="Worker processes" count={workers.data?.processes ? processes.length : undefined}>
        {workers.isError ? <ErrorNote error={workers.error} /> : !workers.data ? <Loading rows={2} /> : workers.data.processes_error ? (
          <ErrorNote error={new Error(workers.data.processes_error)} />
        ) : processes.length === 0 ? (
          <Empty>No worker process is reporting.</Empty>
        ) : (
          <ul aria-label="Worker processes" className="space-y-2">
            {processes.map((p) => <ProcessRow key={p.process_id} p={p} items={map} now={now} />)}
          </ul>
        )}
      </Section>
      <Section title="Running now">
        {runs.data ? <RunningTable runs={runs.data.runs} items={map} now={now} /> : <Loading rows={2} />}
      </Section>
    </>
  );
}

export function QueuePage() {
  const now = useNow();
  const queue = useApi<{ queue: QueueRow[] }>(API.queue);
  const items = useApi<Items>(API.items);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  return (
    <Section title="Queued runs" count={queue.data?.queue.length}>
      {queue.isError ? <ErrorNote error={queue.error} /> : !queue.data ? <Loading rows={4} /> : <QueueTable queue={queue.data.queue} items={map} now={now} />}
    </Section>
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
      <Section title={`Checks (as of ${ago(health.data.checked_at, now)} ago)`} count={checks.length}>
        <CheckList checks={open} />
        {fine.length > 0 && (
          <details data-testid="ok-checks" className="mt-2 text-sm">
            <summary className="cursor-pointer text-text-2">{fine.length} ok</summary>
            <CheckList checks={fine} />
          </details>
        )}
      </Section>
      <Section title="Host sleeps" count={sleeps.length}>
        {sleeps.length === 0 ? (
          <Empty>No host sleep recorded.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {sleeps.map((h) => (
              <li key={`${h.worker_id}:${h.woke_at}`} className="flex items-baseline gap-3" data-testid="host-sleep">
                <span className="font-medium">{sleptText(h.gap_ms)}</span>
                <span className="tabular-nums text-text-2">{h.woke_at.slice(0, 16).replace("T", " ")} UTC ({ago(h.woke_at, now)} ago)</span>
                <span className="min-w-0 font-mono text-xs break-words text-text-3">{h.worker_id}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div id="unreviewed-merges">
        <Section title="Merged without review" count={merges.data?.merges.length}>
          {merges.isError ? <ErrorNote error={merges.error} /> : !merges.data ? <Loading rows={2} /> : merges.data.merges.length === 0 ? (
            <Empty>No PR has merged without review.</Empty>
          ) : (
            <Table label="Merged without review" head={["PR", "Merged by", "Merge commit", "When"]}>
              {merges.data.merges.map((m) => (
                <Tr key={`${m.project}#${m.change_ref}`}>
                  <Td className="tabular-nums">
                    {m.change_url ? <a href={m.change_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{m.change_ref}</a> : `#${m.change_ref}`}
                  </Td>
                  <Td className="text-xs break-words">{m.merged_by}</Td>
                  <Td className="font-mono text-xs">{m.merge_sha}</Td>
                  <Td className="tabular-nums whitespace-nowrap">{ago(m.recorded_at, now)} ago</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Section>
      </div>
    </>
  );
}
