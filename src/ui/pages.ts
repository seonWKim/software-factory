// The two status pages. Reads only: every value comes from FactoryStore read methods, and no store method
// that writes is called from here. Free text goes through Withholder; everything else through esc().

import type { Run, Stage, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { HealthMonitor } from "./health.js";
import { between, duration, esc, link, page, table } from "./html.js";
import { Withholder } from "./withhold.js";

export interface UiDeps {
  store: FactoryStore;
  scanner: EgressScanner;
  clock: Clock;
  /** Running runs whose last heartbeat is older than this are highlighted. */
  lease_ms: number;
  /** The forge's URL for PR `n` of `project` ("owner/name"). */
  prUrl(project: string, n: number): string;
  /** The Health panel and /api/health: doctor's checks, rate-limited and egress-scanned. */
  health: HealthMonitor;
}

export const STAGES: readonly Stage[] = ["NEW", "READY", "RUNNING", "REVIEW", "CLOSED"];
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

export interface IndexQuery {
  stage: Stage | undefined;
  closed: boolean;
  /** The Health panel's refresh link asked for a fresh run (still at most one a minute). */
  refresh?: boolean;
}

/** Tokens a succeeded run reported (outcome data.tokens), the same source the controller adds to token_cost. */
export function runTokens(run: Run): number | null {
  if (run.outcome?.status !== "succeeded") return null;
  const t = Number(run.outcome.data.tokens);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

class Ctx {
  readonly w: Withholder;
  readonly now: Date;
  private readonly items = new Map<WorkItemId, Promise<WorkItem | null>>();

  constructor(readonly d: UiDeps) {
    this.w = new Withholder(d.scanner);
    this.now = d.clock.now();
  }

  item(id: WorkItemId): Promise<WorkItem | null> {
    let p = this.items.get(id);
    if (!p) this.items.set(id, (p = this.d.store.getWorkItem(id)));
    return p;
  }

  /** Link to the item's page, labelled with its title (source id when it has none). */
  async itemLink(item: WorkItem | null, id: WorkItemId): Promise<string> {
    if (!item) return esc(id);
    const label = item.title ? await this.w.text(item.title, { max: 120 }) : esc(item.source.id);
    return `<a href="/items/${esc(encodeURIComponent(item.id))}">${label}</a>`;
  }

  prLink(item: WorkItem): string {
    return item.pr_number === null ? "" : link(this.d.prUrl(item.project, item.pr_number), `PR #${item.pr_number}`);
  }

  ago(ts: string | null): string {
    return duration(between(ts, this.now));
  }

  async blocked(item: WorkItem): Promise<string> {
    if (item.blocked_on === "none") return `<span class="muted">none</span>`;
    return `${esc(item.blocked_on)}${item.blocked_reason ? ` / ${await this.w.text(item.blocked_reason)}` : ""}`;
  }
}

export async function renderIndex(d: UiDeps, q: IndexQuery): Promise<string> {
  const c = new Ctx(d);
  const needs = await needsSection(c);
  const sections = [
    needs.html,
    await d.health.section(d.scanner, { refresh: q.refresh === true }),
    await runningSection(c),
    await queueSection(c),
    await itemsSection(c, q),
    await totalsSection(c),
  ];
  const body =
    `<h1>software-factory</h1><p class="muted">Read-only. Refreshes every 5 s. As of ${esc(c.now.toISOString())}.</p>` +
    sections.join("");
  return page(`(${needs.count}) software-factory status`, body);
}

/** What a waiting item's row says: the reason in plain words, where to act, and the command to type. */
interface Need {
  /** Escaped HTML. */
  reason: string;
  url: string;
  label: string;
  command: string | null;
}

/** blocked_reason values with no command, in plain words. Anything else unknown is shown with spaces for `_`. */
const PLAIN_REASONS: Record<string, string> = {
  max_loops: "review found bugs too many times",
  merge_conflict_pending: "merge conflict",
};

/**
 * "Needs you (N)": one row per item blocked on a human and not CLOSED, oldest wait first. N is an exact
 * count; the rows are the LIST_LIMIT most recently updated of them.
 */
async function needsSection(c: Ctx): Promise<{ count: number; html: string }> {
  const filter = { blocked_on: "human" as const, exclude_closed: true };
  const count = await c.d.store.countWorkItemsWhere(filter);
  const items = await c.d.store.listWorkItemsWhere({ ...filter, limit: LIST_LIMIT });
  const waiting = await Promise.all(items.map(async (it) => ({ it, since: await waitingSince(c, it) })));
  waiting.sort((a, b) => a.since.localeCompare(b.since) || a.it.created_at.localeCompare(b.it.created_at) || a.it.id.localeCompare(b.it.id));
  const rows = [];
  for (const { it, since } of waiting) {
    const need = await needOf(c, it);
    rows.push({
      cells: [
        esc(issueNumber(it.source.id)),
        await c.itemLink(it, it.id),
        c.ago(since),
        need.reason,
        link(need.url, need.label),
        need.command === null ? "" : `<code>${esc(need.command)}</code>`,
      ],
    });
  }
  const html = `<section id="needs"><h2>Needs you (${esc(count)})</h2>${table(
    ["number", "title", "waiting", "reason", "where", "command"],
    rows,
    "nothing waits for you",
  )}</section>`;
  return { count, html };
}

/**
 * When the item started waiting: the latest state change that set its blocked_on or blocked_reason
 * (created_at if none did).
 */
async function waitingSince(c: Ctx, it: WorkItem): Promise<string> {
  const changes = await c.d.store.listStateChanges(it.id);
  const set = changes.filter((sc) => sc.changes.blocked_on !== undefined || sc.changes.blocked_reason !== undefined).at(-1);
  return set?.at ?? it.created_at;
}

async function needOf(c: Ctx, it: WorkItem): Promise<Need> {
  const issue = { url: it.source.link, label: "issue" };
  const reason = it.blocked_reason ?? "";
  const stored = (url: string | null, label: string) => (url === null ? issue : { url, label });
  if (reason === "spec_pending") {
    return { reason: "spec ready", ...stored(it.spec_comment_url, "spec comment"), command: "/approve or /reject <reason>" };
  }
  if (reason === "merge_pending") {
    const pr = it.pr_number === null ? issue : { url: c.d.prUrl(it.project, it.pr_number), label: `PR #${it.pr_number}` };
    return { reason: "ready to merge", ...pr, command: "merge the PR" };
  }
  const failed = reason.match(/^run_failed:[a-z]+:(.+)$/)?.[1] ?? (reason === "max_attempts" || reason === "max_restart" ? await latestErrorCode(c, it) : null);
  if (failed !== null) {
    const code = await c.w.text(failed, { channel: "run_outcome", max: 80 });
    return { reason: `failed: ${code}`, ...stored(it.failure_comment_url, "failure comment"), command: "/retry" };
  }
  const plain = PLAIN_REASONS[reason] ?? reason.replace(/[_:]+/g, " ");
  return { reason: await c.w.text(plain, { fallback: "no reason" }), ...issue, command: null };
}

/** The error code of the item's latest failed run ("unknown" when it has none). */
async function latestErrorCode(c: Ctx, it: WorkItem): Promise<string> {
  const failed = (await c.d.store.listRuns(it.id)).filter((r) => r.outcome?.status === "failed");
  const last = failed.reduce<Run | null>((a, r) => (a === null || (r.finished_at ?? r.updated_at) >= (a.finished_at ?? a.updated_at) ? r : a), null);
  return last?.outcome?.status === "failed" ? last.outcome.error_code : "unknown";
}

/** "#12" from a source id like "owner/repo#12"; the whole id when it has no number. */
function issueNumber(sourceId: string): string {
  const n = sourceId.match(/#(\d+)$/)?.[1];
  return n ? `#${n}` : sourceId;
}

async function runningSection(c: Ctx): Promise<string> {
  const runs = await c.d.store.listRunsByStatus(["running"], LIST_LIMIT);
  const rows = [];
  for (const r of runs) {
    const sinceBeat = between(r.updated_at, c.now);
    const stale = sinceBeat !== null && sinceBeat > c.d.lease_ms;
    rows.push({
      cls: stale ? "stale" : null,
      cells: [
        esc(r.kind),
        await c.itemLink(await c.item(r.work_item_id), r.work_item_id),
        esc(r.attempt),
        r.lease ? await c.w.text(r.lease.owner) : `<span class="muted">unknown</span>`,
        c.ago(r.started_at),
        esc(c.ago(r.updated_at)) + (stale ? " <strong>(past lease)</strong>" : ""),
      ],
    });
  }
  return `<section id="running"><h2>Running now</h2>${table(
    ["kind", "item", "attempt", "worker", "age", "since heartbeat"],
    rows,
    "no runs in progress",
  )}</section>`;
}

async function queueSection(c: Ctx): Promise<string> {
  const runs = await c.d.store.listRunsByStatus(["queued"], LIST_LIMIT);
  const rows = [];
  for (const [i, r] of runs.entries()) {
    rows.push({
      cells: [
        esc(i + 1),
        esc(r.kind),
        await c.itemLink(await c.item(r.work_item_id), r.work_item_id),
        esc(r.attempt),
        c.ago(r.created_at),
      ],
    });
  }
  return `<section id="queue"><h2>Queue</h2>${table(["#", "kind", "item", "attempts so far", "queued for"], rows, "queue is empty")}</section>`;
}

async function itemsSection(c: Ctx, q: IndexQuery): Promise<string> {
  const items = await c.d.store.listWorkItemsWhere({ stage: q.stage, exclude_closed: !q.closed, limit: LIST_LIMIT });
  const closedParam = q.closed ? "&closed=1" : "";
  const nav =
    `<nav>Stage: ${link(q.closed ? "/?closed=1" : "/", "all")}` +
    STAGES.map((s) => link(`/?stage=${s}${closedParam}`, s)).join("") +
    ` | ${q.closed ? link(q.stage ? `/?stage=${q.stage}` : "/", "hide closed") : link(`/?closed=1${q.stage ? `&stage=${q.stage}` : ""}`, "show closed")}` +
    `</nav>`;
  const rows = [];
  for (const it of items) {
    rows.push({
      cells: [
        link(it.source.link, it.source.id),
        await c.itemLink(it, it.id),
        esc(it.stage),
        await c.blocked(it),
        it.tier === null ? "" : esc(it.tier),
        esc(it.loop_count),
        esc(it.restart_count),
        esc(it.token_cost),
        c.prLink(it),
        esc(it.updated_at),
      ],
    });
  }
  const filter = q.stage ? ` (stage ${esc(q.stage)})` : q.closed ? "" : " (CLOSED hidden)";
  return `<section id="items"><h2>All work items${filter}</h2>${nav}${table(
    ["number", "title", "stage", "blocked", "tier", "loops", "restarts", "tokens", "PR", "updated"],
    rows,
    "no work items",
  )}</section>`;
}

async function totalsSection(c: Ctx): Promise<string> {
  const counts = await c.d.store.countWorkItemsByStage();
  const recent = await c.d.store.listRunsFinishedWithin(DAY_MS);
  const succeeded = recent.filter((r) => r.status === "succeeded");
  const failed = recent.filter((r) => r.status === "failed");
  const tokens = succeeded.reduce((sum, r) => sum + (runTokens(r) ?? 0), 0);
  const row = (k: string, v: number) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return (
    `<section id="totals"><h2>Totals</h2>` +
    `<h3>Items per stage</h3><table>${STAGES.map((s) => row(s, counts[s])).join("")}</table>` +
    `<h3>Last 24 h (by finish time)</h3><table>${row("succeeded", succeeded.length)}${row("failed", failed.length)}${row("tokens", tokens)}</table>` +
    `</section>`
  );
}

/** Null when there is no such item. */
export async function renderItem(d: UiDeps, id: WorkItemId): Promise<string | null> {
  const c = new Ctx(d);
  const item = await d.store.getWorkItem(id);
  if (!item) return null;
  const changes = await d.store.listStateChanges(id);
  const runs = await d.store.listRuns(id);

  const facts: [string, string][] = [
    ["id", esc(item.id)],
    ["source", link(item.source.link, item.source.id)],
    ["stage", esc(item.stage) + (item.close_reason ? ` (${esc(item.close_reason)})` : "")],
    ["blocked", await c.blocked(item)],
    ["tier", item.tier === null ? "" : esc(item.tier)],
    ["loops / restarts", `${esc(item.loop_count)} / ${esc(item.restart_count)}`],
    ["tokens", esc(item.token_cost)],
    ["PR", c.prLink(item)],
    ["created / updated", `${esc(item.created_at)} / ${esc(item.updated_at)}`],
  ];
  const title = item.title ? await c.w.text(item.title) : esc(item.source.id);

  const timeline = [];
  for (const sc of changes) {
    timeline.push({
      cells: [
        esc(sc.version),
        esc(sc.at),
        await c.w.text(sc.actor.id),
        await c.w.text(sc.reason),
        await renderChanges(c, sc),
        await renderDetail(c, sc),
      ],
    });
  }

  const runRows = [];
  for (const r of runs) {
    const tokens = runTokens(r);
    const end = r.finished_at ?? (r.status === "running" ? c.now.toISOString() : null);
    let error = "";
    if (r.outcome?.status === "failed") {
      error =
        `${await c.w.text(r.outcome.error_code, { channel: "run_outcome" })}: ` +
        (await c.w.text(r.outcome.detail, { channel: "run_outcome", max: 500, fallback: "" }));
    }
    runRows.push({
      cells: [
        esc(r.kind),
        esc(r.status),
        esc(r.attempt),
        r.started_at ? esc(r.started_at) : `<span class="muted">unknown</span>`,
        r.finished_at ? esc(r.finished_at) : `<span class="muted">${r.status === "running" || r.status === "queued" ? "" : "unknown"}</span>`,
        duration(between(r.started_at, end)),
        tokens === null ? "" : esc(tokens),
        error,
      ],
    });
  }

  const body =
    `<p>${link("/", "← all items")}</p><h1>${title}</h1>` +
    `<table>${facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>` +
    `<section id="timeline"><h2>Timeline</h2>${table(["version", "at", "actor", "reason", "changes", "detail"], timeline)}</section>` +
    `<section id="runs"><h2>Runs</h2>${table(
      ["kind", "status", "attempt", "started", "finished", "duration", "tokens", "error"],
      runRows,
      "no runs",
    )}</section>`;
  return page(`${item.source.id} — software-factory`, body);
}

async function renderChanges(c: Ctx, sc: StateChange): Promise<string> {
  const parts = [];
  for (const [field, change] of Object.entries(sc.changes)) {
    if (!change) continue;
    const from = await c.w.text(JSON.stringify(change.from ?? null), { max: 160 });
    const to = await c.w.text(JSON.stringify(change.to ?? null), { max: 160 });
    parts.push(`${esc(field)}: ${from} → ${to}`);
  }
  return parts.join("<br>");
}

async function renderDetail(c: Ctx, sc: StateChange): Promise<string> {
  if (!sc.detail) return "";
  const parts = [];
  for (const [k, v] of Object.entries(sc.detail)) parts.push(`${esc(k)}=${await c.w.text(String(v), { max: 160 })}`);
  return parts.join("<br>");
}
