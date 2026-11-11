// The JSON API under /api/v1 (design §9), for the app under /app/. GET reads only: every value comes
// from FactoryStore read methods, the same ones the HTML page uses, so for the same store both give the same
// rows and numbers. Free text from the store (titles, blocked reasons, state-change values, run errors, owner
// and actor ids) leaves only through the Withholder: clean text as is (JSON, not HTML-escaped), anything with
// an egress finding as `[withheld: <rule>]`. A lease's fencing token is never returned. The Data page's raw
// table reads (/data/tables, data.ts) use the same Withholder and show hidden columns as `[hidden]`.
//
// Request guards (Host, GET/HEAD) run in server.ts before this module is reached. The five write routes, POST
// /api/v1/settings (settings-api.ts), POST /api/v1/items/:id/commands (commands.ts), POST /api/v1/pauses/resume
// (pause-api.ts), POST /api/v1/standing (standing-api.ts) and POST /api/v1/users (users-api.ts), are handled behind
// server.ts's write guards; GET /api/v1/settings, /session, /pauses, /standing and /users are here.

import { readProjectLabel } from "../core/project-labels.js";
import { conflictCounts } from "../core/resolve.js";
import type { HostSleep, Run, RunAttempt, Stage, StateChange, Timestamp, WorkItem, WorkItemId } from "../core/types.js";
import { itemAlarms, openAlarms } from "./alarms.js";
import { actorGrant, itemCommands, itemReplies, mergeReadiness, needsYouCommands, readSession, waitingSpec } from "./commands.js";
import { type DataCtx, type DataResult, dataAutonomy, dataTable, dataTables } from "./data.js";
import { applyFilters, facetCounts, parseFilters } from "./filters.js";
import { LIST_LIMIT, activeRuns, closedFacetRows, latestDecision, listRows, readClaimPauses, readPhases, waitingOn, whyOf } from "./list.js";
import { runTokens } from "./pages.js";
import { needOf } from "./need.js";
import { NEEDS_YOU } from "./priority.js";
import { type PauseDeps, readPauses } from "./pause-api.js";
import { failures } from "./failures.js";
import { readGitHubBudget } from "./github-budget.js";
import { effectiveGlobal, readSettings } from "./settings-api.js";
import { readStanding } from "./standing-api.js";
import { type UsersDeps, readUsers } from "./users-api.js";
import { itemPrefix, runParts, transcript } from "./transcript.js";
import { type SystemDeps, parseRevision, systemActions } from "./system-actions.js";
import { latestWhyAnchor, threadRows } from "./thread.js";
import type { Why } from "./why.js";
import { displayName } from "./names.js";
import { Withholder } from "./withhold.js";
import type { MergeCheck } from "../interfaces/factory-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Host sleeps on /health (design §9): the newest ten. */
export const HEALTH_SLEEPS = 10;
/** Host sleeps on an item's detail: those of its runs, newest first, at most this many. */
const ITEM_SLEEPS = 100;

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

/** The API's dependencies: the pause and users routes' and the overview's system actions'. */
export type ApiDeps = PauseDeps & UsersDeps & SystemDeps;

/** Answers one GET (or HEAD) under /api/v1. */
export async function api(d: ApiDeps, url: URL): Promise<ApiResult> {
  const path = url.pathname.slice("/api/v1".length);
  const c = new ApiCtx(d);
  switch (path) {
    case "/overview":
      return ok(await overview(c, url.searchParams));
    case "/items":
      return items(c, url.searchParams);
    case "/runs":
      return ok(await runs(c));
    case "/queue":
      return ok(await queue(c));
    case "/workers":
      return ok(await workers(c));
    case "/unreviewed-merges":
      return unreviewedMerges(c, url.searchParams);
    case "/health":
      return ok(await health(c));
    case "/failures":
      return failures({ store: d.store, text: (v) => c.text(v, "run_outcome").then((t) => t!), now: c.now }, url.searchParams);
    case "/settings":
      return d.settings ? ok(await readSettings(d, d.settings)) : apiError(404, "Not found.");
    case "/session": {
      const session = readSession(d, c.now);
      return session ? ok(session) : apiError(404, "Not found.");
    }
    case "/data/tables":
      return data(await dataTables(c.data()));
    case "/data/autonomy": // the same collectAutonomy as `factory stats` (design §6)
      return data(await dataAutonomy(c.data()));
    case "/pauses":
      return pauses(d);
    case "/standing":
      return ok(await readStanding(d));
    case "/users":
      return d.users ? ok(await readUsers(d, d.users)) : apiError(404, "Not found.");
  }
  const t = /^\/data\/tables\/([^/]+)$/.exec(path);
  if (t) {
    const [name] = decoded(t.slice(1));
    return name === undefined ? apiError(404, "No such table.") : data(await dataTable(c.data(), name, url.searchParams));
  }
  const tr = /^\/items\/([^/]+)\/runs\/([^/]+)\/transcript$/.exec(path);
  if (tr) {
    const [id, run] = decoded(tr.slice(1));
    if (id === undefined || run === undefined) return apiError(404, "No such run for this work item.");
    const r = await transcript(d, id as WorkItemId, run, url.searchParams);
    return { status: r.status, value: r.value };
  }
  const m = /^\/items\/([^/]+)$/.exec(path);
  if (m) {
    const [id] = decoded(m.slice(1));
    const body = id === undefined ? null : await item(c, id as WorkItemId);
    return body === null ? apiError(404, "No such work item.") : ok(body);
  }
  return apiError(404, "Not found.");
}

/** A route's path segments, URL-decoded; none when one is malformed (a stray `%`). */
function decoded(parts: readonly (string | undefined)[]): string[] {
  try {
    return parts.map((p) => decodeURIComponent(p!));
  } catch {
    return [];
  }
}

/** GET /api/v1/pauses with, for a model stall, when it began (`since`): one more store read, no forge call. */
async function pauses(d: ApiDeps): Promise<ApiResult> {
  const r = await readPauses(d);
  const body = r.value as { pauses: { name: string }[] };
  const since = await d.store.getClaimPause("model_stall_since");
  return { status: r.status, value: { ...body, pauses: body.pauses.map((p) => (p.name === "model_stall" ? { ...p, since } : p)) } };
}

const data = (r: DataResult): ApiResult => ("error" in r ? apiError(r.status, r.error) : { status: r.status, value: r.value });

class ApiCtx {
  readonly w: Withholder;
  readonly now: Date;

  constructor(readonly d: ApiDeps) {
    this.w = new Withholder(d.scanner);
    this.now = d.clock.now();
  }

  /** The value, or the withheld marker; null stays null. */
  async text(value: string | null | undefined, channel?: "run_outcome"): Promise<string | null> {
    if (value === null || value === undefined) return null;
    return (await this.w.plain(value, channel ? { channel } : {})).text;
  }

  /** The Data page's context: the same store, Withholder and channel as every other route. */
  data(): DataCtx {
    return { store: this.d.store, text: (v) => this.text(v), now: this.now };
  }

  private readonly labels = new Map<string, Promise<string>>();

  /** The stored label of a project key; the unknown-project text when none is stored. */
  projectLabel(key: string): Promise<string> {
    let p = this.labels.get(key);
    if (!p) this.labels.set(key, (p = readProjectLabel(this.d.store, key)));
    return p;
  }

  /** The item's change as the API returns it: the stored change_ref and change_url, each through the Withholder. */
  async change(it: WorkItem) {
    return { change_ref: await this.text(it.change_ref), change_url: await this.text(it.change_url) };
  }

  /** The issue the item came from; null for an adopted PR (its source link is a /pull/ URL) or an id without a number. */
  issue(it: WorkItem): { number: number; url: string } | null {
    if (/\/pull\/\d+/.test(it.source.link)) return null;
    const n = /#(\d+)$/.exec(it.source.id)?.[1];
    return n ? { number: Number(n), url: it.source.link } : null;
  }

  /**
   * `why` as the API returns it: the sentence through the Withholder, the refs as numbers, and `ref_url`, the
   * item's repository issue URL to append a ref to (null when the source link is not an issue or PR URL).
   */
  async why(w: Why, it: WorkItem) {
    const repo = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/(?:issues|pull)\/\d+$/.exec(it.source.link)?.[1];
    return {
      code: w.code,
      text: (await this.text(w.text))!,
      next_actor: w.next_actor,
      refs: w.refs.filter((n) => Number.isSafeInteger(n)),
      ref_url: repo ? await this.text(`${repo}/issues/`) : null,
    };
  }

  /**
   * What a Needs-you row says (need.ts): the reason through the Withholder and `anchor`, the item page's anchor of the
   * newest factory thread entry (null when the item has none). Its buttons are the row's `commands`, not need.ts's text.
   */
  async need(it: WorkItem, check: { state: "mergeable" | "checking" | "conflicts"; conflicts: string[] } | null) {
    const n = await needOf(
      { store: this.d.store, text: async (v, o) => (await this.w.plain(v, o)).text },
      it,
      check && { state: check.state, conflicts: check.conflicts.length },
    );
    return { reason: n.reason, anchor: await latestWhyAnchor(this.d.store, it.id) };
  }

  /** Why one item waits, from the same reads and rules as the list (list.ts whyOf). */
  async whyOfItem(it: WorkItem) {
    const s = this.d.store;
    const { active, position } = await activeRuns(s);
    const run = active.get(it.id) ?? null;
    const decision = await latestDecision(s, it.id, run);
    const waiting = waitingOn(it, await readPhases(s, [it]));
    const alarms = await itemAlarms(s, await openAlarms(s, this.now), it);
    return this.why(whyOf(it, run, position.get(run?.id ?? "") ?? null, decision, await readClaimPauses(s), waiting, this.now, alarms), it);
  }
}

/**
 * /api/v1/health: the HealthMonitor's report (exactly what /api/health returns) plus `sleeps`, the newest host
 * sleeps (design §5 Host sleep, §9). The sleeps read is a report, never a gate: when it fails (e.g. a MySQL
 * database without step 0025) the list is empty and the checks still answer.
 */
async function health(c: ApiCtx) {
  const report = await c.d.health.report(c.d.scanner);
  const rows = await c.d.store.listHostSleeps({ limit: HEALTH_SLEEPS }).catch((): HostSleep[] => []);
  return { ...report, sleeps: await sleepRows(c, rows) };
}

/** Host sleeps as the API returns them: ids, a timestamp and a number, never free text. */
async function sleepRows(c: ApiCtx, rows: readonly HostSleep[]) {
  const out = [];
  for (const h of rows) out.push({ worker_id: (await c.text(h.worker_id))!, woke_at: h.woke_at, gap_ms: h.gap_ms, run_id: h.run_id });
  return out;
}

async function overview(c: ApiCtx, params: URLSearchParams) {
  const s = c.d.store;
  const stages: Record<Stage, number> = await s.countWorkItemsByStage();
  const running = await s.listRunsByStatus(["running"], LIST_LIMIT);
  const queued = await s.listRunsByStatus(["queued"], LIST_LIMIT);
  const recent = await s.listRunsFinishedWithin(DAY_MS);
  const succeeded = recent.filter((r) => r.status === "succeeded");
  // The supervisor's status (the HTML page's banner); absent without a status function, null when stopped.
  const status = c.d.factoryStatus ? await c.d.factoryStatus() : undefined;
  // The effective `workers` setting (file, override or default, capped at max_workers), not the file value the status holds.
  const workers = status && c.d.settings ? await effectiveGlobal(c.d, "workers") : status ? { value: status.workers, source: "file" as const } : null;
  const factory = status === undefined ? undefined : status === null ? null : {
    state: status.state,
    rev: status.rev,
    target_rev: status.target_rev,
    child_pid: status.child_pid,
    since: status.since,
    workers: workers!.value,
    workers_source: workers!.source,
    error: await c.text(status.error ?? null),
    pending: status.pending ?? [],
  };
  // System actions (design §9 Status page): store reads and in-process values only, no forge call.
  const actions = await systemActions({ store: s, active: [...running, ...queued], factory: status, deps: c.d, now: c.now, dashboardRev: parseRevision(params.get("rev")) });
  const system_actions = [];
  for (const a of actions) system_actions.push({ ...a, text: (await c.text(a.text))! });
  const token = c.d.lastChecks?.tokenDays() ?? null;
  return {
    as_of: c.now.toISOString(),
    /** The git revision this UI server runs; the app compares it with the one built into it. */
    server_rev: c.d.revision ?? null,
    plugins: c.d.plugins ?? { issues: null },
    ...(factory === undefined ? {} : { factory }),
    stages,
    needs_you: (await s.countWorkItemsWhere({ blocked_on: "human", exclude_closed: true })) + (await s.countWorkItemsWhere({ blocked_on: "budget", exclude_closed: true })) + system_actions.length, // never Blocked by another task
    system_actions,
    /** Days left on the GitHub token from this process's last health run; "unknown" before one; null: no expiry check. */
    github_token_days: token,
    /** The GitHub budget the controller stored after its last poll (remaining, reset, this process's count, wait reason); null: none stored. */
    github_budget: await readGitHubBudget(s, c.now),
    running: running.length,
    queued: queued.length,
    last_24h: {
      succeeded: succeeded.length,
      failed: recent.filter((r) => r.status === "failed").length,
      tokens: succeeded.reduce((sum, r) => sum + (runTokens(r) ?? 0), 0),
    },
    unreviewed_merges_7d: await s.countUnreviewedMergesSince(new Date(c.now.getTime() - 7 * DAY_MS).toISOString() as Timestamp),
  };
}

const MERGES_DEFAULT = 50;
const MERGES_MAX = 200;

/** PRs that merged with no work item, newest first. The project is its stored label, never its key. */
async function unreviewedMerges(c: ApiCtx, params: URLSearchParams): Promise<ApiResult> {
  let limit = MERGES_DEFAULT;
  const raw = params.get("limit");
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return apiError(400, "limit must be a whole number from 1 to 200.");
    limit = Math.min(Number(raw), MERGES_MAX);
  }
  const out = [];
  for (const m of await c.d.store.listUnreviewedMerges(limit)) {
    const label = await c.projectLabel(m.project);
    // Scan the whole sha, then shorten it: a cut-off secret would no longer match a rule.
    const sha = await c.text(m.merge_sha);
    out.push({
      project: await c.text(label),
      // The store keeps no link for an unreviewed merge yet (UnreviewedMerge carries only the number): text only.
      change_ref: String(m.pr_number),
      change_url: null,
      merge_sha: sha === m.merge_sha ? sha.slice(0, 7) : sha,
      merged_by: m.merger_id === null ? "unknown" : await c.text(m.merger_id),
      merged_by_name: m.merger_id === null ? null : await c.text(await displayName(c.d.displayNames, m.merger_id)),
      recorded_at: m.at,
    });
  }
  return ok({ as_of: c.now.toISOString(), merges: out });
}

async function items(c: ApiCtx, params: URLSearchParams): Promise<ApiResult> {
  const parsed = parseFilters(params);
  if (!parsed.ok) return apiError(400, parsed.error);
  const f = parsed.filters;
  const ctx = { store: c.d.store, w: c.w, now: c.now, lease_ms: c.d.lease_ms };
  const rows = await listRows(ctx, f);
  const shown = applyFilters(rows, f);
  const checks = new Map<string, MergeCheck>();
  for (const m of await c.d.store.listMergeChecks(shown.filter((r) => readyToMerge(r.item)).map((r) => r.item.id))) checks.set(m.work_item_id, m);
  const out = [];
  const [allowed, commandGrant] = [actorGrant(c.d, "approve_merge"), actorGrant(c.d, "approve_spec")]; // each asked once per list
  for (const r of shown) {
    const it = r.item;
    const decision = r.decision; // the current run's only: an earlier run's hold is stale
    const merge_check = await mergeCheckRow(c, it, checks.get(it.id) ?? null);
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
      ...(await c.change(it)),
      issue: c.issue(it),
      since: r.input.since,
      updated_at: it.updated_at,
      version: it.version,
      dependents: r.dependents,
      conflicts: r.conflicts,
      merge_check,
      merge: await mergeReadiness(c.d, it, merge_check, allowed),
      ...(NEEDS_YOU.includes(r.level) ? { need: await c.need(it, merge_check), commands: await needsYouCommands(c.d, it, commandGrant, (v) => c.text(v)) } : {}),
      why: await c.why(r.why, it),
      parent_id: it.parent_id,
      phase: it.phase,
      waiting_on_number: r.input.waiting_on_number ?? null,
      run: r.run && {
        kind: r.run.kind,
        status: r.run.status,
        attempt: r.run.attempt,
        worker_id: r.run.lease ? await c.text(r.run.lease.owner) : null,
        started_at: r.run.started_at,
        position: r.run.status === "queued" ? r.position : null,
      },
      claim: decision && {
        decision: decision.decision,
        holder: await c.text(decision.holder_ref),
        holder_id: decision.holder_work_item_id,
        approved: decision.approved_by !== null,
        cost: decision.cost,
        threshold: decision.threshold,
      },
    });
  }
  // The closed items count in the facets even when the list leaves them out (the Closed option's count).
  const facets = facetCounts([...rows, ...(await closedFacetRows(ctx, f))], f);
  return ok({ as_of: c.now.toISOString(), total: out.length, items: out, facets });
}

async function item(c: ApiCtx, id: WorkItemId) {
  const s = c.d.store;
  const it = await s.getWorkItem(id);
  if (!it) return null;
  const changes = await s.listStateChanges(id);
  const runs = await s.listRuns(id);
  // One record per claim (design §6), listed under its run in attempt order.
  const attemptsOf = new Map<string, RunAttempt[]>();
  for (const a of await s.listRunAttempts(id)) attemptsOf.set(a.run_id, [...(attemptsOf.get(a.run_id) ?? []), a]);
  // Which runs have a stored transcript: one listing of the item's prefix. A storage error only hides the links.
  let stored: string[] = [];
  if (c.d.storage) {
    try {
      stored = await c.d.storage.list(itemPrefix(id));
    } catch {
      stored = [];
    }
  }
  const merge_check = await mergeCheckRow(c, it, readyToMerge(it) ? await s.getMergeCheck(id) : null);
  const timeline = [];
  for (const sc of changes) timeline.push(await stateChange(c, sc));
  const runRows = [];
  for (const r of runs) {
    const attempts = [];
    for (const a of attemptsOf.get(r.id) ?? []) attempts.push(await attemptRow(c, a));
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
      attempts,
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
      ...(await c.change(it)),
      spec_comment_url: await c.text(it.spec_comment_url),
      // A phase of a split spec links to its parent; a split parent lists its phases (the store's listPhases).
      parent_id: it.parent_id,
      phase: it.phase,
      phases: await phaseRows(c, it),
      version: it.version,
      created_at: it.created_at,
      updated_at: it.updated_at,
      conflicts: conflictCounts(runs, changes),
      merge_check,
      merge: await mergeReadiness(c.d, it, merge_check, actorGrant(c.d, "approve_merge")),
      why: await c.whyOfItem(it),
    },
    timeline,
    runs: runRows,
    // Host sleeps recorded during one of this item's runs (design §5 Host sleep), newest first.
    sleeps: await sleepRows(c, await s.listHostSleeps({ limit: ITEM_SLEEPS, work_item_id: id }).catch(() => [])),
    /** Run id → its stored transcript parts ("" is the main step), for runs with a stored transcript only. */
    transcripts: Object.fromEntries(runs.flatMap((r) => {
      const parts = runParts(stored, id, r.id);
      return parts.length > 0 ? [[r.id, parts] as const] : [];
    })),
    /** The item's thread, oldest first (thread.ts): every body through the Withholder. */
    thread: await threadRows(s, it.id, it.source.type, async (v) => (await c.text(v))!),
    commands: await itemCommands(it, runs, await actorGrant(c.d, "approve_spec")(), (v) => c.text(v)), spec: await waitingSpec(it, runs, (v) => c.text(v)), // the viewer's (#453)
    replies: await itemReplies(c.d, it.id, (v) => c.text(v)),
  };
}

/** A split parent's phases in phase order, each with its title through the Withholder; empty for any other item. */
async function phaseRows(c: ApiCtx, it: WorkItem) {
  const out = [];
  for (const p of await c.d.store.listPhases(it.id)) {
    out.push({ id: p.id, phase: p.phase, title: await c.text(p.title || null), stage: p.stage, source: { type: p.source.type, id: p.source.id, link: p.source.link } });
  }
  return out;
}

/** Waiting for a human merge: the only state the local merge check runs on (design §5 Merge check). */
function readyToMerge(it: WorkItem): boolean {
  return it.stage === "REVIEW" && it.blocked_on === "human" && it.blocked_reason === "merge_pending";
}

/**
 * The local merge check of a ready-to-merge item (null for any other item): `mergeable` or `conflicts` from its
 * stored result, or `checking` while it has none, or while the result is for an older head than the one the
 * factory last recorded. File names pass the Withholder, each on its own.
 */
async function mergeCheckRow(c: ApiCtx, it: WorkItem, m: MergeCheck | null) {
  if (!readyToMerge(it)) return null;
  const current = m !== null && (it.last_head_sha === null || it.last_head_sha === m.head_sha);
  const conflicts: string[] = [];
  if (current) for (const f of m.conflicts) conflicts.push((await c.text(f))!);
  return {
    state: !current ? ("checking" as const) : m.mergeable ? ("mergeable" as const) : ("conflicts" as const),
    conflicts,
    head_sha: m?.head_sha ?? null,
    base_sha: m?.base_sha ?? null,
    checked_at: m?.checked_at ?? null,
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
  return { version: sc.version, at: sc.at, actor: { kind: sc.actor.kind, id: await c.text(sc.actor.id), name: await c.text(await displayName(c.d.displayNames, sc.actor.id)) }, reason: await c.text(sc.reason), changes, detail };
}

/** One claim of a run: the worker id and error code pass the Withholder; the fencing token is not in the record. */
async function attemptRow(c: ApiCtx, a: RunAttempt) {
  return {
    attempt: a.attempt,
    worker_id: await c.text(a.worker_id),
    status: a.status,
    started_at: a.started_at,
    finished_at: a.finished_at,
    error_code: await c.text(a.error_code, "run_outcome"),
    failure_class: a.failure_class,
    tokens: a.tokens,
  };
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

/** Queued runs, oldest first, each with why its item waits (what the Starts column shows). */
async function queue(c: ApiCtx) {
  const s = c.d.store;
  const runs = await s.listRunsByStatus(["queued"], LIST_LIMIT);
  const { active, position } = await activeRuns(s);
  const items = new Map<WorkItemId, WorkItem | null>();
  for (const r of runs) if (!items.has(r.work_item_id)) items.set(r.work_item_id, await s.getWorkItem(r.work_item_id));
  const phases = await readPhases(s, [...items.values()].filter((it): it is WorkItem => it !== null));
  const pauses = await readClaimPauses(s);
  const open = await openAlarms(s, c.now);
  const out = [];
  for (const [i, r] of runs.entries()) {
    const it = items.get(r.work_item_id) ?? null;
    let why = null;
    if (it) {
      // The item's own active run decides its sentence (a running run wins), as on Items and the item page.
      const run = active.get(it.id) ?? r;
      const decision = await latestDecision(s, it.id, run);
      why = await c.why(whyOf(it, run, position.get(run.id) ?? null, decision, pauses, waitingOn(it, phases), c.now, await itemAlarms(s, open, it)), it);
    }
    out.push({
      position: i + 1,
      id: r.id,
      kind: r.kind,
      work_item_id: r.work_item_id,
      attempt: r.attempt,
      created_at: r.created_at,
      not_before: r.not_before,
      why,
    });
  }
  return { as_of: c.now.toISOString(), queue: out };
}

/**
 * `workers`: each current lease owner of a running run once, by id, with how many runs it holds. `processes`:
 * one entry per live worker process (its store row is at most lease_ms old), idle ones included, with its slot
 * counts and the running runs its worker loops hold (lease owner `<process_id>:<n>`). The processes read is a
 * report, never a gate: when it fails (e.g. a MySQL database without the worker_processes step) the endpoint
 * still answers, with `processes: []` and the error text in `processes_error`.
 */
async function workers(c: ApiCtx) {
  const running = await c.d.store.listRunsByStatus(["running"], LIST_LIMIT);
  const count = new Map<string, number>();
  for (const r of running) {
    if (r.lease) count.set(r.lease.owner, (count.get(r.lease.owner) ?? 0) + 1);
  }
  const out = [];
  for (const [owner, running] of count) out.push({ owner: (await c.text(owner))!, running });
  out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

  let live: Awaited<ReturnType<typeof c.d.store.listWorkerProcesses>>;
  try {
    live = await c.d.store.listWorkerProcesses(c.d.lease_ms);
  } catch (err) {
    const processes_error = await c.text(err instanceof Error ? err.message : String(err));
    return { as_of: c.now.toISOString(), workers: out, processes: [], processes_error };
  }
  const processes = [];
  for (const p of live) {
    const runs = [];
    for (const r of running) {
      const owner = r.lease?.owner;
      if (!owner?.startsWith(`${p.process_id}:`)) continue;
      runs.push({ id: r.id, kind: r.kind, work_item_id: r.work_item_id, worker_id: (await c.text(owner))!, started_at: r.started_at });
    }
    processes.push({
      process_id: (await c.text(p.process_id))!,
      pid: p.pid,
      host: (await c.text(p.host))!,
      slots: p.slots,
      max_slots: p.max_slots,
      busy: p.busy,
      /** Claiming slots with no run now; 0 while draining. */
      idle: Math.max(0, p.slots - p.busy),
      index_base: p.index_base,
      started_at: p.started_at,
      reported_at: p.reported_at,
      runs,
    });
  }
  return { as_of: c.now.toISOString(), workers: out, processes };
}
