// The two status pages. Reads only: every value comes from FactoryStore read methods, and no store method
// that writes is called from here. Free text goes through Withholder; everything else through esc().

import type { Run, Stage, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
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
}

export const STAGES: readonly Stage[] = ["NEW", "READY", "RUNNING", "REVIEW", "CLOSED"];
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

export interface IndexQuery {
  stage: Stage | undefined;
  closed: boolean;
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
  const sections = [
    await waitingSection(c),
    await runningSection(c),
    await queueSection(c),
    await itemsSection(c, q),
    await totalsSection(c),
  ];
  const body =
    `<h1>software-factory</h1><p class="muted">Read-only. Refreshes every 5 s. As of ${esc(c.now.toISOString())}.</p>` +
    sections.join("");
  return page("software-factory status", body);
}

async function waitingSection(c: Ctx): Promise<string> {
  const items = await c.d.store.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, limit: LIST_LIMIT });
  const groups = new Map<string, WorkItem[]>();
  for (const it of items) {
    const key = it.blocked_reason ?? "";
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  let html = "";
  for (const [reason, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    html += `<h3>${await c.w.text(reason, { fallback: "no reason" })}</h3><ul>`;
    for (const it of group) {
      const links = [link(it.source.link, "issue"), c.prLink(it)].filter(Boolean).join(" · ");
      html += `<li>${await c.itemLink(it, it.id)} <span class="muted">${esc(it.source.id)} · ${esc(it.stage)}</span> — ${links}</li>`;
    }
    html += "</ul>";
  }
  return `<section id="waiting"><h2>Waiting for you</h2>${html || `<p class="muted">nothing</p>`}</section>`;
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
