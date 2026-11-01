// The read-only JSON API under /api/v1 (design §9), for the app under /app/. Reads only: every value comes
// from FactoryStore read methods, the same ones the HTML page uses, so for the same store both give the same
// rows and numbers. Free text from the store (titles, blocked reasons, state-change values, run errors, owner
// and actor ids) leaves only through the Withholder: clean text as is (JSON, not HTML-escaped), anything with
// an egress finding as `[withheld: <rule>]`. A lease's fencing token is never returned.
//
// Request guards (Host, GET/HEAD) run in server.ts before this module is reached.

import { conflictCounts } from "../core/resolve.js";
import type { Run, Stage, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import { applyFilters, facetCounts, parseFilters } from "./filters.js";
import { LIST_LIMIT, listRows } from "./list.js";
import { type UiDeps, runTokens } from "./pages.js";
import { Withholder } from "./withhold.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Status and JSON value; server.ts adds the headers. */
export interface ApiResult {
  status: number;
  value: unknown;
}

const ok = (value: unknown): ApiResult => ({ status: 200, value });
export const apiError = (status: number, error: string): ApiResult => ({ status, value: { error } });

/** True for /api/v1 and everything under it. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/** Answers one GET (or HEAD) under /api/v1. */
export async function api(d: UiDeps, url: URL): Promise<ApiResult> {
  const path = url.pathname.slice("/api/v1".length);
  const c = new ApiCtx(d);
  switch (path) {
    case "/overview":
      return ok(await overview(c));
    case "/items":
      return items(c, url.searchParams);
    case "/runs":
      return ok(await runs(c));
    case "/queue":
      return ok(await queue(c));
    case "/workers":
      return ok(await workers(c));
    case "/health":
      return ok(await d.health.report(d.scanner));
  }
  const m = /^\/items\/([^/]+)$/.exec(path);
  if (m) {
    let id: string;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      return apiError(404, "No such work item.");
    }
    const body = await item(c, id as WorkItemId);
    return body === null ? apiError(404, "No such work item.") : ok(body);
  }
  return apiError(404, "Not found.");
}

class ApiCtx {
  readonly w: Withholder;
  readonly now: Date;

  constructor(readonly d: UiDeps) {
    this.w = new Withholder(d.scanner);
    this.now = d.clock.now();
  }

  /** The value, or the withheld marker; null stays null. */
  async text(value: string | null | undefined, channel?: "run_outcome"): Promise<string | null> {
    if (value === null || value === undefined) return null;
    return (await this.w.plain(value, channel ? { channel } : {})).text;
  }

  prUrl(it: WorkItem): string | null {
    return it.pr_number === null ? null : this.d.prUrl(it.project, it.pr_number);
  }
}

async function overview(c: ApiCtx) {
  const s = c.d.store;
  const stages: Record<Stage, number> = await s.countWorkItemsByStage();
  const needs_you = await s.countWorkItemsWhere({ blocked_on: "human", exclude_closed: true });
  const running = await s.listRunsByStatus(["running"], LIST_LIMIT);
  const queued = await s.listRunsByStatus(["queued"], LIST_LIMIT);
  const recent = await s.listRunsFinishedWithin(DAY_MS);
  const succeeded = recent.filter((r) => r.status === "succeeded");
  return {
    as_of: c.now.toISOString(),
    stages,
    needs_you,
    running: running.length,
    queued: queued.length,
    last_24h: {
      succeeded: succeeded.length,
      failed: recent.filter((r) => r.status === "failed").length,
      tokens: succeeded.reduce((sum, r) => sum + (runTokens(r) ?? 0), 0),
    },
  };
}

async function items(c: ApiCtx, params: URLSearchParams): Promise<ApiResult> {
  const parsed = parseFilters(params);
  if (!parsed.ok) return apiError(400, parsed.error);
  const f = parsed.filters;
  const rows = await listRows({ store: c.d.store, w: c.w, now: c.now, lease_ms: c.d.lease_ms }, f);
  const shown = applyFilters(rows, f);
  const out = [];
  for (const r of shown) {
    const it = r.item;
    out.push({
      id: it.id,
      source: { type: it.source.type, id: it.source.id, link: it.source.link },
      title: await c.text(it.title || null),
      level: r.level,
      badges: r.badges,
      stage: it.stage,
      tier: it.tier,
      kind: r.kind,
      blocked_on: it.blocked_on,
      blocked_reason: await c.text(it.blocked_reason),
      close_reason: it.close_reason,
      run_status: r.runStatus,
      pr_number: it.pr_number,
      pr_url: c.prUrl(it),
      since: r.input.since,
      updated_at: it.updated_at,
      version: it.version,
      dependents: r.dependents,
      conflicts: r.conflicts,
    });
  }
  return ok({ as_of: c.now.toISOString(), total: out.length, items: out, facets: facetCounts(rows, f) });
}

async function item(c: ApiCtx, id: WorkItemId) {
  const s = c.d.store;
  const it = await s.getWorkItem(id);
  if (!it) return null;
  const changes = await s.listStateChanges(id);
  const runs = await s.listRuns(id);
  const timeline = [];
  for (const sc of changes) timeline.push(await stateChange(c, sc));
  const runRows = [];
  for (const r of runs) {
    runRows.push({
      id: r.id,
      kind: r.kind,
      status: r.status,
      attempt: r.attempt,
      started_at: r.started_at,
      finished_at: r.finished_at,
      created_at: r.created_at,
      tokens: runTokens(r),
      error:
        r.outcome?.status === "failed"
          ? { code: await c.text(r.outcome.error_code, "run_outcome"), detail: await c.text(r.outcome.detail, "run_outcome") }
          : null,
    });
  }
  return {
    as_of: c.now.toISOString(),
    item: {
      id: it.id,
      source: { type: it.source.type, id: it.source.id, link: it.source.link },
      title: await c.text(it.title || null),
      stage: it.stage,
      close_reason: it.close_reason,
      blocked_on: it.blocked_on,
      blocked_reason: await c.text(it.blocked_reason),
      tier: it.tier,
      loop_count: it.loop_count,
      restart_count: it.restart_count,
      token_cost: it.token_cost,
      pr_number: it.pr_number,
      pr_url: c.prUrl(it),
      version: it.version,
      created_at: it.created_at,
      updated_at: it.updated_at,
      conflicts: conflictCounts(runs, changes),
    },
    timeline,
    runs: runRows,
  };
}

/** A state change as the page's timeline shows it: from/to as JSON text, each value withheld on its own. */
async function stateChange(c: ApiCtx, sc: StateChange) {
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const [field, change] of Object.entries(sc.changes)) {
    if (!change) continue;
    changes[field] = { from: await c.text(JSON.stringify(change.from ?? null)), to: await c.text(JSON.stringify(change.to ?? null)) };
  }
  let detail: Record<string, string | null> | null = null;
  if (sc.detail) {
    detail = {};
    for (const [k, v] of Object.entries(sc.detail)) detail[k] = await c.text(String(v));
  }
  return { version: sc.version, at: sc.at, actor: { kind: sc.actor.kind, id: await c.text(sc.actor.id) }, reason: await c.text(sc.reason), changes, detail };
}

/** A run for /runs: who holds it and until when, never its fencing token. */
async function runRow(c: ApiCtx, r: Run) {
  return {
    id: r.id,
    status: r.status,
    kind: r.kind,
    work_item_id: r.work_item_id,
    attempt: r.attempt,
    owner: r.lease ? await c.text(r.lease.owner) : null,
    /** A running run's updated_at is its last heartbeat (or its claim). */
    heartbeat_at: r.status === "running" ? r.updated_at : null,
    started_at: r.started_at,
    lease_expires_at: r.lease ? r.lease.expires_at : null,
    created_at: r.created_at,
  };
}

async function runs(c: ApiCtx) {
  const out = [];
  for (const r of await c.d.store.listRunsByStatus(["running"], LIST_LIMIT)) out.push(await runRow(c, r));
  for (const r of await c.d.store.listRunsByStatus(["queued"], LIST_LIMIT)) out.push(await runRow(c, r));
  return { as_of: c.now.toISOString(), runs: out };
}

async function queue(c: ApiCtx) {
  const runs = await c.d.store.listRunsByStatus(["queued"], LIST_LIMIT);
  return {
    as_of: c.now.toISOString(),
    queue: runs.map((r, i) => ({
      position: i + 1,
      id: r.id,
      kind: r.kind,
      work_item_id: r.work_item_id,
      attempt: r.attempt,
      created_at: r.created_at,
      not_before: r.not_before,
    })),
  };
}

/** Each current lease owner of a running run once, by id, with how many runs it holds. */
async function workers(c: ApiCtx) {
  const count = new Map<string, number>();
  for (const r of await c.d.store.listRunsByStatus(["running"], LIST_LIMIT)) {
    if (r.lease) count.set(r.lease.owner, (count.get(r.lease.owner) ?? 0) + 1);
  }
  const out = [];
  for (const [owner, running] of count) out.push({ owner: (await c.text(owner))!, running });
  out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return { as_of: c.now.toISOString(), workers: out };
}
