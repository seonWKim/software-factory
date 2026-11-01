// The two status pages. Reads only: every value comes from FactoryStore read methods, and no store method
// that writes is called from here. Free text goes through Withholder; everything else through esc().

import { UNKNOWN_PROJECT_LABEL } from "../core/project.js";
import { readProjectLabel } from "../core/project-labels.js";
import { type ConflictCounts, conflictCounts } from "../core/resolve.js";
import { type Run, type RunKind, type StateChange, type WorkItem, type WorkItemId, outcomeCost, outcomeTokens } from "../core/types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import {
  type FacetCounts, type Filters, RUN_KINDS, STAGES, STATE_OPTIONS, TIERS, applyFilters, facetCounts, isFiltered,
} from "./filters.js";
import { between, duration, esc, facts as factsTable, link, page, table } from "./html.js";
import type { FactoryStatus } from "./factory-status.js";
import type { HealthMonitor } from "./health.js";
import { LIST_LIMIT, type ListRow, listRows } from "./list.js";
import { NEEDS_YOU } from "./priority.js";
import { Withholder } from "./withhold.js";

export { STAGES } from "./filters.js";

export interface UiDeps {
  store: FactoryStore;
  scanner: EgressScanner;
  clock: Clock;
  /** Running runs whose last heartbeat is older than this are highlighted. */
  lease_ms: number;
  /**
   * The forge's URL for PR `n` of the project labelled `label` ("github.com/owner/name", the stored label;
   * design 2026-11-01). Never given a project key.
   */
  prUrl(label: string, n: number): string;
  /** The Health panel and /api/health: doctor's checks, rate-limited and egress-scanned. */
  health: HealthMonitor;
  /** The supervisor's state (null: no status file); absent: the banner is not shown. */
  factoryStatus?: () => Promise<FactoryStatus | null>;
  /** The built app served under /app/; absent: web/dist in this checkout. */
  appDir?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days the cost section covers, today (UTC) included. */
const COST_DAYS = 7;
/** The cost section's columns: every run kind that can run an agent. `manual` is a record, never work. */
const COST_KINDS: readonly RunKind[] = ["triage", "implement", "review", "resolve", "update"];

/**
 * Tokens a run used, the same count the controller adds to token_cost (design §6 Measurement): a succeeded
 * run's data.tokens, a failed run's usage. Null when the run stored none (unfinished, or an older failed row).
 */
export function runTokens(run: Run): number | null {
  if (run.outcome?.status === "succeeded") {
    const t = Number(run.outcome.data.tokens);
    return Number.isFinite(t) && t >= 0 ? t : null;
  }
  return run.outcome?.status === "failed" && run.outcome.usage ? outcomeTokens(run.outcome) : null;
}

class Ctx {
  readonly w: Withholder;
  readonly now: Date;
  private readonly items = new Map<WorkItemId, Promise<WorkItem | null>>();
  private readonly labels = new Map<string, Promise<string>>();

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

  /** The project's stored label (one store read per project per page). Never the key: unknown → a fixed text. */
  label(key: string): Promise<string> {
    let p = this.labels.get(key);
    if (!p) this.labels.set(key, (p = readProjectLabel(this.d.store, key)));
    return p;
  }

  /** The forge URL of the item's PR, or null when it has none or its project has no stored label yet. */
  async prUrl(item: WorkItem): Promise<string | null> {
    if (item.pr_number === null) return null;
    const label = await this.label(item.project);
    return label === UNKNOWN_PROJECT_LABEL ? null : this.d.prUrl(label, item.pr_number);
  }

  async prLink(item: WorkItem): Promise<string> {
    if (item.pr_number === null) return "";
    const url = await this.prUrl(item);
    return url === null ? esc(`PR #${item.pr_number}`) : link(url, `PR #${item.pr_number}`);
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
  const rows = await listRows({ store: d.store, w: c.w, now: c.now, lease_ms: d.lease_ms }, f);
  const sections = [
    await factorySection(c),
    await totalsSection(c),
    await costSection(c),
    filtersSection(f, facetCounts(rows, f)),
    await itemsSection(c, applyFilters(rows, f), f),
    await d.health.section(d.scanner, { refresh: healthRefresh }),
    await runningSection(c),
    await queueSection(c),
  ];
  const body =
    `<h1>Status</h1><p class="muted">Read-only. As of <time>${esc(c.now.toISOString())}</time>.</p>` +
    (await projectsLine(c, rows)) +
    sections.join("");
  return page(`(${waiting}) software-factory status`, body, self);
}

/** The projects of the listed items, by label (design 2026-11-01): never a raw project key. */
async function projectsLine(c: Ctx, rows: readonly ListRow[]): Promise<string> {
  const labels = [...new Set(await Promise.all([...new Set(rows.map((r) => r.item.project))].map((k) => c.label(k))))].sort();
  if (labels.length === 0) return "";
  return `<p id="projects">${labels.length === 1 ? "Project" : "Projects"}: ${labels.map((l) => esc(l)).join(", ")}</p>`;
}

const short = (rev: string | null) => (rev ? rev.slice(0, 7) : "unknown");

/**
 * The banner on top: what the factory process is doing. During an update the old process takes no new runs
 * until its in-flight runs finish, which looks like "my workers setting is ignored"; this says so.
 */
async function factorySection(c: Ctx): Promise<string> {
  if (!c.d.factoryStatus) return "";
  const s = await c.d.factoryStatus();
  const open = (cls: string, text: string) => `<section id="factory"><p class="banner ${cls}"><strong>${text}</strong>`;
  if (s === null || s.state === "stopped") {
    return `${open("bad", "Factory stopped.")} No runs start. Start it with <code>npm run factory -- dev</code>.</p></section>`;
  }
  const since = `${esc(c.ago(s.since))} ago`;
  const pid = s.child_pid;
  const inFlight = pid === null ? 0 : (await c.d.store.listRunsByStatus(["running"], LIST_LIMIT)).filter((r) => r.lease?.owner.includes(`:${pid}:`)).length;
  switch (s.state) {
    case "running":
      return `${open("ok", "Factory running.")} Revision <code>${esc(short(s.rev))}</code>, process ${esc(pid ?? "?")}, ${esc(s.workers)} workers, since ${since}.</p></section>`;
    case "building":
      return `${open("warn", `Building ${esc(short(s.target_rev))}.`)} Runs continue on <code>${esc(short(s.rev))}</code> meanwhile (started ${since}).</p></section>`;
    case "draining":
      return (
        `${open("warn", `Updating to ${esc(short(s.target_rev))}: new runs are paused.`)} ` +
        `The running process (${esc(pid ?? "?")}) takes no new runs until its ${esc(inFlight)} in-flight run${inFlight === 1 ? "" : "s"} finish; ` +
        `then the new revision starts with ${esc(s.workers)} workers. Draining for ${esc(c.ago(s.since))}. ` +
        `Code and settings changes apply when the new revision starts.</p></section>`
      );
    case "restarting":
      return `${open("warn", `Starting ${esc(short(s.target_rev))}.`)} New runs start in a moment (since ${since}).</p></section>`;
    case "crashed":
      return (
        `${open("bad", `Factory not running: revision ${esc(short(s.rev))} exits.`)} ` +
        `${s.error ? `<code>${esc(s.error)}</code>. ` : ""}It is restarted every poll; no runs start until it stays up ` +
        `(failing for ${esc(c.ago(s.since))}).</p></section>`
      );
    case "build_failed":
      return `${open("bad", `Revision ${esc(short(s.target_rev))} failed to build.`)} Still running <code>${esc(short(s.rev))}</code>; its settings stay in effect until main builds.</p></section>`;
  }
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
        await c.prLink(it),
        c.ago(r.input.since),
        conflictsCell(r.conflicts),
      ],
    });
  }
  const empty = isFiltered(f)
    ? `<p>No items match these filters. <a href="/">Clear filters</a></p>`
    : `<p>No open work items. <a href="/?closed=1">Show closed items</a></p>`;
  const body =
    out.length === 0
      ? empty
      : table(["state", "number", "title", "stage", "tier", "next step", "PR", "waiting", "conflicts"], out);
  return `<section id="items"><h2>Work items (${esc(rows.length)})</h2>${body}</section>`;
}

/** The conflicts cell: both counts, or empty when the item never had a merge conflict. */
function conflictsCell(n: ConflictCounts): string {
  return n.automatic === 0 && n.person === 0 ? "" : esc(`${n.automatic} automatic · ${n.person} needed a person`);
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

async function needOf(c: Ctx, it: WorkItem): Promise<Need> {
  const issue = { url: it.source.link, label: "issue" };
  const reason = it.blocked_reason ?? "";
  const stored = (url: string | null, label: string) => (url === null ? issue : { url, label });
  if (reason === "spec_pending") {
    return { reason: "spec ready", ...stored(it.spec_comment_url, "spec comment"), command: "/approve or /reject <reason>" };
  }
  if (reason === "merge_pending") {
    const url = await c.prUrl(it);
    const pr = url === null ? issue : { url, label: `PR #${it.pr_number}` };
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
  // Every finished run, failed included: its full count, as in token_cost.
  const tokens = recent.reduce((sum, r) => sum + outcomeTokens(r.outcome), 0);
  const row = (k: string, v: number) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return (
    `<section id="totals"><h2>Totals</h2><div class="strip">` +
    `<div><h3>Items per stage</h3><div class="scroll"><table><tbody>${STAGES.map((s) => row(s, counts[s])).join("")}</tbody></table></div></div>` +
    `<div><h3>Last 24 h (by finish time)</h3><div class="scroll"><table><tbody>${row("succeeded", succeeded.length)}${row("failed", failed.length)}${row("tokens", tokens)}</tbody></table></div></div>` +
    `</div></section>`
  );
}

/**
 * USD per UTC day of `finished_at`, for the last COST_DAYS days, one column per run kind and a total. The cost
 * is the harness's own figure (design §6 Measurement). A run with no cost is counted as unknown, never as 0.
 */
async function costSection(c: Ctx): Promise<string> {
  const today = Date.UTC(c.now.getUTCFullYear(), c.now.getUTCMonth(), c.now.getUTCDate());
  const from = today - (COST_DAYS - 1) * DAY_MS;
  const days = Array.from({ length: COST_DAYS }, (_, i) => new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  type Cell = { usd: number; known: number; unknown: number };
  const cells = new Map<string, Cell>();
  const add = (key: string, cost: number | null) => {
    const cell = cells.get(key) ?? { usd: 0, known: 0, unknown: 0 };
    if (cost === null) cell.unknown++;
    else {
      cell.usd += cost;
      cell.known++;
    }
    cells.set(key, cell);
  };
  for (const r of await c.d.store.listRunsFinishedWithin(c.now.getTime() - from)) {
    if (!r.finished_at || !COST_KINDS.includes(r.kind)) continue;
    const at = Date.parse(r.finished_at);
    if (Number.isNaN(at) || at < from) continue;
    const day = r.finished_at.slice(0, 10);
    const cost = outcomeCost(r.outcome);
    add(`${day}|${r.kind}`, cost);
    add(`${day}|total`, cost);
  }
  const show = (cell: Cell | undefined): string => {
    if (!cell) return "";
    const usd = `$${cell.usd.toFixed(4)}`;
    if (cell.unknown === 0) return esc(usd);
    if (cell.known === 0) return `<span class="muted">${esc(`unknown (${cell.unknown} run${cell.unknown === 1 ? "" : "s"})`)}</span>`;
    return `${esc(usd)} <span class="muted">${esc(`+ ${cell.unknown} unknown`)}</span>`;
  };
  const rows = days.map((day) => ({
    cells: [esc(day), ...[...COST_KINDS, "total"].map((k) => show(cells.get(`${day}|${k}`)))],
  }));
  return (
    `<section id="cost"><h2>Cost (USD, last ${COST_DAYS} days)</h2>` +
    `<p class="muted">The agent harness's own figure per run, by UTC day of finish; not checked against the bill. Runs that reported no cost are counted as unknown.</p>` +
    `${table(["day (UTC)", ...COST_KINDS, "total"], rows)}</section>`
  );
}

/** Null when there is no such item. */
export async function renderItem(d: UiDeps, id: WorkItemId): Promise<string | null> {
  const c = new Ctx(d);
  const item = await d.store.getWorkItem(id);
  if (!item) return null;
  const changes = await d.store.listStateChanges(id);
  const runs = await d.store.listRuns(id);
  const conflicts = conflictCounts(runs, changes);

  const facts: [string, string][] = [
    ["id", esc(item.id)],
    ["project", esc(await c.label(item.project))],
    ["source", link(item.source.link, item.source.id)],
    ["stage", esc(item.stage) + (item.close_reason ? ` (${esc(item.close_reason)})` : "")],
    ["blocked", await c.blocked(item)],
    ["tier", item.tier === null ? "" : esc(item.tier)],
    ["loops / restarts", `${esc(item.loop_count)} / ${esc(item.restart_count)}`],
    ["tokens", esc(item.token_cost)],
    ["merge conflicts", esc(`${conflicts.automatic} resolved automatically, ${conflicts.person} needed a person`)],
    ["PR", await c.prLink(item)],
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
