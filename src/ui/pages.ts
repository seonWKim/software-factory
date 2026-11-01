// The two status pages. Reads only: every value comes from FactoryStore read methods, and no store method
// that writes is called from here. Free text goes through Withholder; everything else through esc().

import type { Run, RunKind, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import {
  type FacetCounts, type FilterRow, type Filters, RUN_KINDS, STAGES, STATE_OPTIONS, TIERS, applyFilters, facetCounts,
  isFiltered, runKindOf, searchKeys,
} from "./filters.js";
import { between, duration, esc, facts as factsTable, link, page, table } from "./html.js";
import type { HealthMonitor } from "./health.js";
import { type Level, NEEDS_YOU, type PriorityInput, rank } from "./priority.js";
import { Withholder } from "./withhold.js";

export { STAGES } from "./filters.js";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

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

/**
 * `self` is this page's path and query, for the noscript Refresh link. `healthRefresh`: the Health panel's
 * refresh link asked for a fresh run (still at most one a minute).
 */
export async function renderIndex(d: UiDeps, f: Filters, self = "/", healthRefresh = false): Promise<string> {
  const c = new Ctx(d);
  const waiting = await c.d.store.countWorkItemsWhere({ blocked_on: "human", exclude_closed: true });
  const rows = await listRows(c, f);
  const sections = [
    await totalsSection(c),
    filtersSection(f, facetCounts(rows, f)),
    await itemsSection(c, applyFilters(rows, f), f),
    await d.health.section(d.scanner, { refresh: healthRefresh }),
    await runningSection(c),
    await queueSection(c),
  ];
  const body =
    `<h1>Status</h1><p class="muted">Read-only. As of <time>${esc(c.now.toISOString())}</time>.</p>` + sections.join("");
  return page(`(${waiting}) software-factory status`, body, self);
}

/** One ranked row of the list, with what the filters read. */
interface ListRow extends FilterRow {
  item: WorkItem;
  input: PriorityInput;
  badges: string[];
  /** Escaped title HTML (withheld marker when withheld; source id when untitled). */
  titleHtml: string;
  /** The full title as shown, for the title attribute; null when withheld or untitled. */
  titlePlain: string | null;
  runStatus: "queued" | "running" | null;
}

/** Every listed item, ranked (closed items too when the filters may show them). */
async function listRows(c: Ctx, f: Filters): Promise<ListRow[]> {
  const withClosed = f.closed || f.state === "closed" || f.stage === "CLOSED";
  const items = await c.d.store.listWorkItemsWhere({ exclude_closed: !withClosed, limit: LIST_LIMIT });
  const active = new Map<WorkItemId, Run>();
  for (const r of await c.d.store.listRunsByStatus(["queued"], LIST_LIMIT)) if (!active.has(r.work_item_id)) active.set(r.work_item_id, r);
  for (const r of await c.d.store.listRunsByStatus(["running"], LIST_LIMIT)) active.set(r.work_item_id, r); // running wins

  const inputs: (PriorityInput & { item: WorkItem })[] = [];
  for (const it of items) {
    const run = active.get(it.id);
    const blocked = it.blocked_on === "human" || it.blocked_on === "budget";
    inputs.push({
      item: it,
      stage: it.stage,
      blocked_on: it.blocked_on,
      blocked_reason: it.blocked_reason,
      close_reason: it.close_reason,
      tier: it.tier,
      since: blocked && it.stage !== "CLOSED" ? await waitingSince(c, it) : it.updated_at,
      run: run && (run.status === "queued" || run.status === "running") ? { kind: run.kind, status: run.status, heartbeat_at: run.updated_at } : null,
      dependents: 0,
      waiting_on: 0,
    });
  }

  const out: ListRow[] = [];
  for (const r of rank(inputs, c.now, c.d.lease_ms)) {
    const it = r.input.item;
    const t = it.title ? await c.w.shown(it.title, { max: 120 }) : { html: esc(it.source.id), plain: null };
    out.push({
      item: it,
      input: r.input,
      level: r.level,
      badges: r.badges,
      stage: it.stage,
      tier: it.tier,
      kind: runKindOf(it.blocked_reason, r.input.run?.kind ?? null),
      dependents: r.input.dependents,
      search: searchKeys(it.source.id, it.title ? t.plain : null),
      titleHtml: t.html,
      titlePlain: t.plain,
      runStatus: r.input.run?.status ?? null,
    });
  }
  return out;
}

function option(value: string, label: string, n: number, selected: boolean): string {
  return `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(`${label} (${n})`)}</option>`;
}

function select(name: string, label: string, opts: string[]): string {
  return `<label for="f-${esc(name)}">${esc(label)}<select id="f-${esc(name)}" name="${esc(name)}">${opts.join("")}</select></label>`;
}

/** The GET filter form; each option shows how many rows it would give with the other filters kept. */
function filtersSection(f: Filters, n: FacetCounts): string {
  const state = select("state", "State", [
    option("", "All", n.allStates, f.state === undefined),
    ...STATE_OPTIONS.map((o) => option(o.value, o.label, n.state[o.value], f.state === o.value)),
  ]);
  const stage = select("stage", "Stage", [
    option("", "All", n.allStages, f.stage === undefined),
    ...STAGES.map((s) => option(s, s, n.stage[s], f.stage === s)),
  ]);
  const tier = select("tier", "Tier", [
    option("", "All", n.allTiers, f.tier === undefined),
    ...TIERS.map((t) => option(String(t), `Tier ${t}`, n.tier[t], f.tier === t)),
  ]);
  const kind = select("kind", "Run kind", [
    option("", "All", n.allKinds, f.kind === undefined),
    ...RUN_KINDS.map((k: RunKind) => option(k, k, n.kind[k], f.kind === k)),
  ]);
  const check = (name: string, label: string, on: boolean) =>
    `<label class="check" for="f-${name}"><input type="checkbox" id="f-${name}" name="${name}" value="1"${on ? " checked" : ""}>${esc(label)}</label>`;
  return (
    `<section id="filters"><h2>Filters</h2><nav aria-label="Filters"><form class="filters" method="get" action="/">` +
    `<label for="f-q">Search (number or title)<input type="search" id="f-q" name="q" value="${esc(f.q)}" maxlength="200"></label>` +
    state + stage + tier + kind +
    check("unblocks", `Unblocks others (${n.unblocks})`, f.unblocks) +
    check("closed", "Show closed", f.closed) +
    `<input type="submit" value="Apply"> <a href="/">Clear filters</a>` +
    `</form></nav></section>`
  );
}

/** The single prioritised list. Rows that wait for a person say what to do next. */
async function itemsSection(c: Ctx, rows: ListRow[], f: Filters): Promise<string> {
  const out = [];
  for (const r of rows) {
    const it = r.item;
    let next = "";
    if (NEEDS_YOU.includes(r.level)) {
      const need = await needOf(c, it);
      next = `${need.reason} · ${link(need.url, need.label)}${need.command === null ? "" : ` · <code>${esc(need.command)}</code>`}`;
    }
    const title = `<a class="title" href="/items/${esc(encodeURIComponent(it.id))}"${r.titlePlain === null ? "" : ` title="${esc(r.titlePlain)}"`}>${r.titleHtml}</a>`;
    out.push({
      attrs: ` data-key="${esc(it.id)}" data-sig="${esc(`${it.version}:${r.level}:${r.runStatus ?? "none"}`)}"`,
      cells: [
        r.badges.map((b, i) => `<span class="badge${i === 0 ? ` l-${esc(r.level)}` : ""}">${esc(b)}</span>`).join(""),
        link(it.source.link, issueNumber(it.source.id)),
        title,
        esc(it.stage),
        it.tier === null ? "" : esc(it.tier),
        next,
        c.prLink(it),
        c.ago(r.input.since),
      ],
    });
  }
  const empty = isFiltered(f)
    ? `<p>No items match these filters. <a href="/">Clear filters</a></p>`
    : `<p>No open work items. <a href="/?closed=1">Show closed items</a></p>`;
  const body =
    out.length === 0
      ? empty
      : table(["state", "number", "title", "stage", "tier", "next step", "PR", "waiting"], out);
  return `<section id="items"><h2>Work items (${esc(rows.length)})</h2>${body}</section>`;
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

async function totalsSection(c: Ctx): Promise<string> {
  const counts = await c.d.store.countWorkItemsByStage();
  const recent = await c.d.store.listRunsFinishedWithin(DAY_MS);
  const succeeded = recent.filter((r) => r.status === "succeeded");
  const failed = recent.filter((r) => r.status === "failed");
  const tokens = succeeded.reduce((sum, r) => sum + (runTokens(r) ?? 0), 0);
  const row = (k: string, v: number) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return (
    `<section id="totals"><h2>Totals</h2><div class="strip">` +
    `<div><h3>Items per stage</h3><div class="scroll"><table><tbody>${STAGES.map((s) => row(s, counts[s])).join("")}</tbody></table></div></div>` +
    `<div><h3>Last 24 h (by finish time)</h3><div class="scroll"><table><tbody>${row("succeeded", succeeded.length)}${row("failed", failed.length)}${row("tokens", tokens)}</tbody></table></div></div>` +
    `</div></section>`
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
    `<section id="facts">${factsTable(facts)}</section>` +
    `<section id="timeline"><h2>Timeline</h2>${table(["version", "at", "actor", "reason", "changes", "detail"], timeline)}</section>` +
    `<section id="runs"><h2>Runs</h2>${table(
      ["kind", "status", "attempt", "started", "finished", "duration", "tokens", "error"],
      runRows,
      "no runs",
    )}</section>`;
  return page(`${item.source.id} — software-factory`, body, `/items/${encodeURIComponent(item.id)}`);
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
