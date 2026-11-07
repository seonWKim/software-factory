import { useMemo, useState } from "react";
import { API, type FactoryState, type Health, type ItemDetail, type ItemRow, type Items, type Overview, type QueueRow, type RunRow, type UnreviewedMerges, useApi } from "../api.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import { LEVEL_LABELS, NEEDS_YOU_LEVELS, ago, shortRev, shortSource, tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { ItemsTable, QueueTable, RunningTable, useNow } from "./common.js";

const byId = (items: readonly ItemRow[] | undefined) => new Map((items ?? []).map((i) => [i.id, i]));

/** The supervisor banner: what the factory process is doing (the status page's words, shorter). */
export function FactoryBanner({ factory, now }: { factory: FactoryState | null | undefined; now: number }) {
  if (factory === undefined) return null;
  const bad = "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100";
  const warn = "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
  const ok = "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
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
        tone = ok;
        text = `Factory running: revision ${rev}, ${factory.workers} workers, since ${ago(factory.since, now)} ago.`;
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
    <p role="status" data-testid="factory-banner" className={cn("mb-4 rounded-md px-3 py-2 text-sm text-pretty", tone)}>
      {text}
    </p>
  );
}

/** The factory floor: what needs the operator, what runs, what waits; then the numbers. */
export function FloorPage() {
  const now = useNow();
  const overview = useApi<Overview>(API.overview);
  const items = useApi<Items>(API.items);
  const runs = useApi<{ runs: RunRow[] }>(API.runs);
  const queue = useApi<{ queue: QueueRow[] }>(API.queue);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const needs = (items.data?.items ?? []).filter((i) => (NEEDS_YOU_LEVELS as readonly string[]).includes(i.level));
  const o = overview.data;
  return (
    <>
      <FactoryBanner factory={o?.factory} now={now} />
      <Section title="Needs you" count={items.data ? needs.length : undefined}>
        {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading /> : (
          <ItemsTable items={needs} now={now} label="Needs you" plugins={o?.plugins} empty="Nothing waits for you. New specs, failed runs and PRs ready to merge show up here." />
        )}
      </Section>
      <Section title="Running now" count={runs.data?.runs.filter((r) => r.status === "running").length}>
        {runs.isError ? <ErrorNote error={runs.error} /> : !runs.data ? <Loading rows={2} /> : <RunningTable runs={runs.data.runs} items={map} now={now} />}
      </Section>
      <Section
        title="Queue"
        count={queue.data?.queue.length}
        action={<Link href={`${BASE}queue`} className={cn("text-sm", LINK_CLASS)}>All queued runs</Link>}
      >
        {queue.isError ? <ErrorNote error={queue.error} /> : !queue.data ? <Loading rows={2} /> : <QueueTable queue={queue.data.queue} items={map} now={now} limit={10} />}
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
              ["Runs failed", String(o.last_24h.failed)],
              ["Tokens", tokens(o.last_24h.tokens)],
              ["Open items", String(Object.entries(o.stages).filter(([s]) => s !== "CLOSED").reduce((n, [, v]) => n + v, 0))],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <dt className="text-xs text-zinc-600 dark:text-zinc-400">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
    </>
  );
}

const STATE_FILTERS = ["needs", "ready_to_merge", "needs_approval", "needs_human", "stuck", "running", "queued", "waiting_on_issue", "closed"] as const;
const FILTER_LABELS: Record<string, string> = { needs: "Needs you", ...LEVEL_LABELS };

/** Every work item, filterable by state (the API's `state` facet). */
export function ItemsPage() {
  const now = useNow();
  const [state, setState] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  if (q.trim()) params.set("q", q.trim());
  const query = params.toString();
  const items = useApi<Items>(query ? `${API.items}?${query}` : API.items);
  const overview = useApi<Overview>(API.overview);
  const facets = items.data?.facets.state ?? {};
  return (
    <>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by title or issue number"
        aria-label="Search work items"
        className="mb-2 w-full max-w-sm rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
      />
      <div role="group" aria-label="Filter by state" className="mb-3 flex flex-wrap gap-1.5">
        {[null, ...STATE_FILTERS].map((s) => (
          <button
            key={s ?? "all"}
            type="button"
            aria-pressed={state === s}
            onClick={() => setState(s)}
            className={cn(
              "rounded-md border px-2 py-1 text-xs tabular-nums",
              state === s ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800",
            )}
          >
            {s === null ? "All" : FILTER_LABELS[s]} {s === null ? (items.data?.facets.allStates ?? "") : (facets[s] ?? 0)}
          </button>
        ))}
      </div>
      {items.isError ? <ErrorNote error={items.error} /> : !items.data ? <Loading rows={6} /> : (
        <ItemsTable items={items.data.items} now={now} label="Work items" plugins={overview.data?.plugins} empty="No work item matches this filter." />
      )}
    </>
  );
}

/** One work item: its state, runs (with errors) and timeline. */
export function ItemPage({ id }: { id: string }) {
  const now = useNow();
  const q = useApi<ItemDetail>(API.item(id));
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={6} />;
  const { item, runs, timeline } = q.data;
  return (
    <>
      <p className="mb-1 text-sm">
        <Link href={`${BASE}items`} className={LINK_CLASS}>Work items</Link>
        <span className="text-zinc-500"> / </span>
        <a href={item.source.link} target="_blank" rel="noreferrer" className={cn("tabular-nums", LINK_CLASS)}>{shortSource(item.source.id)}</a>
      </p>
      <h2 className="text-balance text-base font-semibold">{item.title ?? item.source.id}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {[
          ["Stage", item.stage + (item.close_reason ? ` (${item.close_reason})` : "")],
          ["Blocked on", item.blocked_on === "none" ? "nothing" : `${item.blocked_on}${item.blocked_reason ? `: ${item.blocked_reason}` : ""}`],
          ["Tier", item.tier ?? "–"],
          ["PR", item.pr_number ?? "–"],
          ["Review loops", item.loop_count],
          ["Restarts", item.restart_count],
          ["Tokens", tokens(item.token_cost)],
          ["Updated", `${ago(item.updated_at, now)} ago`],
        ].map(([k, v]) => (
          <div key={String(k)} className="min-w-0">
            <dt className="text-xs text-zinc-600 dark:text-zinc-400">{k}</dt>
            <dd className="truncate tabular-nums">
              {k === "PR" && item.pr_url ? <a href={item.pr_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{item.pr_number}</a> : String(v)}
            </dd>
          </div>
        ))}
      </dl>
      <Section title="Runs" count={runs.length}>
        {runs.length === 0 ? <Empty>No run yet.</Empty> : (
          <Table label="Runs" head={["Run", "Status", "Attempt", "Started", "Took", "Tokens", "Error"]}>
            {[...runs].reverse().map((r) => (
              <tr key={r.id}>
                <Td>{r.kind}</Td>
                <Td><Badge level={r.status === "running" ? "running" : r.status === "failed" ? "needs_human" : undefined}>{r.status}</Badge></Td>
                <Td className="tabular-nums">{r.attempt}</Td>
                <Td className="tabular-nums whitespace-nowrap">{r.started_at ? `${ago(r.started_at, now)} ago` : "–"}</Td>
                <Td className="tabular-nums">{r.started_at && r.finished_at ? ago(r.started_at, Date.parse(r.finished_at)) : "–"}</Td>
                <Td className="tabular-nums">{tokens(r.tokens)}</Td>
                <Td className="max-w-md text-xs break-words text-zinc-700 dark:text-zinc-300">
                  {r.error ? <><span className="font-medium">{r.error.code}</span>{r.error.detail ? `: ${r.error.detail}` : ""}</> : "–"}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Timeline" count={timeline.length}>
        <ol className="space-y-1 text-sm">
          {[...timeline].reverse().map((t) => (
            <li key={t.version} className="flex gap-3">
              <span className="w-12 shrink-0 text-right text-zinc-500 tabular-nums">{ago(t.at, now)}</span>
              <span className="min-w-0">
                <span className="font-medium">{t.reason ?? "change"}</span>
                <span className="text-zinc-500"> by {t.actor.kind === "system" ? "the factory" : (t.actor.id ?? t.actor.kind)}</span>
                {Object.keys(t.changes).length > 0 && (
                  <span className="text-zinc-600 dark:text-zinc-400">
                    {" "}— {Object.entries(t.changes).map(([f, c]) => `${f}: ${c.from} → ${c.to}`).join(", ")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

export function WorkersPage() {
  const now = useNow();
  const workers = useApi<{ workers: { owner: string; running: number }[] }>(API.workers);
  const overview = useApi<Overview>(API.overview);
  const runs = useApi<{ runs: RunRow[] }>(API.runs);
  const items = useApi<Items>(API.items);
  const map = useMemo(() => byId(items.data?.items), [items.data]);
  const f = overview.data?.factory;
  return (
    <>
      <FactoryBanner factory={f} now={now} />
      <Section title="Worker slots with a run" count={workers.data?.workers.length}>
        {workers.isError ? <ErrorNote error={workers.error} /> : !workers.data ? <Loading rows={2} /> : workers.data.workers.length === 0 ? (
          <Empty>No worker holds a run.{f && f.state === "running" ? ` The factory runs ${f.workers} worker slots; they claim queued runs as they come.` : ""}</Empty>
        ) : (
          <Table label="Workers" head={["Worker", "Runs"]}>
            {workers.data.workers.map((w) => (
              <tr key={w.owner}>
                <Td className="font-mono text-xs">{w.owner}</Td>
                <Td className="tabular-nums">{w.running}</Td>
              </tr>
            ))}
          </Table>
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

const HEALTH_TONE: Record<string, string> = { ok: "running", warn: "needs_approval", fail: "needs_human" };

export function HealthPage() {
  const now = useNow();
  // Each read runs the checks: every 30 s, not every 3 s.
  const health = useApi<Health>(API.health, 30_000);
  const merges = useApi<UnreviewedMerges>(API.unreviewedMerges, 30_000);
  if (health.isError) return <ErrorNote error={health.error} />;
  if (!health.data) return <Loading rows={6} />;
  const order = ["fail", "warn", "ok"];
  const checks = [...health.data.checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <>
      <Section title={`Checks (as of ${ago(health.data.checked_at, now)} ago)`} count={checks.length}>
        <ul className="space-y-1 text-sm">
          {checks.map((c, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <Badge level={HEALTH_TONE[c.status]}>{c.status}</Badge>
              <span className="min-w-0 text-pretty break-words">{c.msg}</span>
            </li>
          ))}
        </ul>
      </Section>
      <div id="unreviewed-merges">
        <Section title="Merged without review" count={merges.data?.merges.length}>
          {merges.isError ? <ErrorNote error={merges.error} /> : !merges.data ? <Loading rows={2} /> : merges.data.merges.length === 0 ? (
            <Empty>No PR has merged without review.</Empty>
          ) : (
            <Table label="Merged without review" head={["PR", "Merged by", "Merge commit", "When"]}>
              {merges.data.merges.map((m) => (
                <tr key={`${m.project}#${m.pr_number}`}>
                  <Td className="tabular-nums">
                    {m.pr_url ? <a href={m.pr_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{m.pr_number}</a> : `#${m.pr_number}`}
                  </Td>
                  <Td className="text-xs break-words">{m.merged_by}</Td>
                  <Td className="font-mono text-xs">{m.merge_sha}</Td>
                  <Td className="tabular-nums whitespace-nowrap">{ago(m.recorded_at, now)} ago</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </div>
    </>
  );
}
