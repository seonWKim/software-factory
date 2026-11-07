// The status page's Health panel and GET /api/health: the same checks as `factory doctor`, from the one
// implementation (doctorChecks, src/setup.ts), which the composition root passes in as `run`, plus the GitHub sync
// line (syncChecks), a store read. It limits how often the checks run, shares one run between concurrent
// requests, and egress-scans every message before it leaves (design §9). Below it, the latest improve report
// (design §7): its group counts, drafts and filings, every text through the Withholder.

import { syncLeaseName } from "../core/lease.js";
import { readStoredProject } from "../core/project-labels.js";
import type { Clock } from "../interfaces/clock.js";
import type { FailureGroup, ImproveReport } from "../core/types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type Check, type CheckStatus, checkStatus } from "../setup.js";
import { esc } from "./html.js";
import { Withholder } from "./withhold.js";

export const HEALTH_MIN_INTERVAL_MS = 60_000;

/** Below this share of the limit left, the sync line is a warn: optional reads wait for the reset on every replica. */
const LOW_SHARE = 0.1;

/**
 * The GitHub sync line (design 05-coordination, sync lease): the shared budget (`forge_budget`, plugin `plugin`) and
 * the replica holding `sync:github_issue:<project>`, from the store only, no GitHub call. E.g.
 * `GitHub: 812/5000 left, resets 09:12, synced by replica host:42` (reset in UTC). A warn with no live holder or
 * under 10% left. None while neither is stored (no GitHub plugin selected, or nothing synced yet).
 */
export async function syncChecks(
  store: Pick<FactoryStore, "getCursor" | "getForgeBudget" | "getSyncLease">, repo: { owner: string; name: string }, plugin: string, now: Date,
): Promise<Check[]> {
  const project = await readStoredProject(store, repo);
  if (!project) return [];
  const [budget, lease] = [await store.getForgeBudget(project.key, plugin), await store.getSyncLease(syncLeaseName("github_issue", project.key))];
  if (!budget && !lease) return [];
  const holder = lease && Date.parse(lease.expires_at) > now.getTime() ? lease.owner : null;
  const left = budget ? `${budget.remaining}/${budget.limit} left, resets ${budget.reset_at.slice(11, 16)}` : "budget not reported yet";
  const low = budget !== null && Date.parse(budget.reset_at) > now.getTime() && budget.remaining < budget.limit * LOW_SHARE;
  const msg = `GitHub: ${left}, ${holder ? `synced by replica ${holder}` : "no replica holds the sync lease"}`;
  return [{ ok: holder !== null && !low, ...((holder === null || low) && { warn: true }), msg }];
}

/** One finished run, messages as the checks wrote them. Never leaves this module unfiltered. */
interface RawRun {
  started_at: Date;
  checked_at: Date;
  checks: readonly Check[];
}

/** What GET /api/health returns. Every `msg` has passed through the Withholder. */
export interface HealthReport {
  checked_at: string;
  checks: { status: CheckStatus; msg: string }[];
}

/**
 * Runs the checks at most once per `min_interval_ms` per process (measured between run starts), whoever
 * asks: page loads, the refresh link and the API all count. A request during a run waits for that run.
 * In-process state on purpose: it is a per-process rate limit on a read-only probe, not shared state.
 */
export class HealthMonitor {
  private last: RawRun | null = null;
  private inflight: Promise<RawRun> | null = null;

  constructor(
    private readonly run: () => Promise<Check[]>,
    private readonly clock: Clock,
    readonly min_interval_ms = HEALTH_MIN_INTERVAL_MS,
  ) {}

  /** The latest run, starting one only when none is running and the last started `min_interval_ms` ago or more. */
  private latest(): Promise<RawRun> {
    if (this.inflight) return this.inflight;
    const now = this.clock.now();
    if (this.last && now.getTime() - this.last.started_at.getTime() < this.min_interval_ms) return Promise.resolve(this.last);
    const p = this.runOnce(now).then((r) => {
      this.last = r;
      this.inflight = null;
      return r;
    });
    this.inflight = p;
    return p;
  }

  private async runOnce(started_at: Date): Promise<RawRun> {
    let checks: Check[];
    try {
      checks = await this.run();
    } catch (err) {
      // doctor would stop on this error; the page reports it as one FAIL instead (scanned like any message).
      checks = [{ ok: false, msg: `health checks could not finish: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` }];
    }
    return { started_at, checked_at: this.clock.now(), checks };
  }

  /** The checks for the API, every message through the Withholder. */
  async report(scanner: EgressScanner): Promise<HealthReport> {
    const r = await this.latest();
    const w = new Withholder(scanner);
    const checks = [];
    for (const c of r.checks) checks.push({ status: checkStatus(c), msg: (await w.plain(c.msg)).text });
    return { checked_at: r.checked_at.toISOString(), checks };
  }

  /** The Health panel: a `<section id="health">`. `refresh`: the refresh link asked for this load. */
  async section(scanner: EgressScanner, opts: { refresh: boolean }): Promise<string> {
    const r = await this.latest();
    const w = new Withholder(scanner);
    const rows = [];
    for (const c of r.checks) {
      const status = checkStatus(c);
      const word = status === "fail" ? "<strong>FAIL</strong>" : esc(status);
      rows.push(`<tr class="health-${esc(status)}"><td>${word}</td><td>${await w.text(c.msg)}</td></tr>`);
    }
    const nextMs = r.started_at.getTime() + this.min_interval_ms - this.clock.now().getTime();
    const limited = opts.refresh && nextMs > 0 ? ` Checks run at most once a minute; next run possible in ${esc(Math.ceil(nextMs / 1000))}s.` : "";
    const table = rows.length === 0
      ? `<p class="muted">no checks ran</p>`
      : `<table><tr><th>result</th><th>check</th></tr>${rows.join("")}</table>`;
    return (
      `<section id="health"><h2>Health</h2>` +
      `<p class="muted">Last run ${esc(r.checked_at.toISOString())}. <a href="/classic?health=refresh#health">refresh</a>${limited}</p>` +
      `${table}</section>`
    );
  }
}

/**
 * The latest improve report as a `<section id="improve">`: its window and counts, then one row per group of two
 * or more runs with its draft and filing; skipped and withheld drafts and filings name their reason or rules.
 * Every text (code, detail, cause, fix, reason) passes the Withholder first.
 */
export async function improveSection(report: ImproveReport | null, scanner: EgressScanner): Promise<string> {
  const head = `<section id="improve"><h2>Improve report</h2>`;
  if (!report) return `${head}<p class="muted">no improve run has reported yet</p></section>`;
  const w = new Withholder(scanner);
  const runs = report.groups.reduce((n, g) => n + g.run_ids.length, 0);
  const rows = [];
  for (const g of report.groups) {
    rows.push(
      `<tr><td>${await w.text(g.error_code)}</td><td>${await w.text(g.detail, { fallback: "none" })}</td><td>${esc(g.run_ids.length)}</td>` +
      `<td>${await draftCell(w, g)}</td><td>${await w.text(filingText(g), { fallback: "not filed yet" })}</td></tr>`,
    );
  }
  const table = rows.length === 0
    ? `<p class="muted">no failure group of two or more runs</p>`
    : `<table><tr><th>error</th><th>detail</th><th>runs</th><th>draft</th><th>filing</th></tr>${rows.join("")}</table>`;
  return (
    head +
    `<p class="muted">Window ${esc(report.window_start)} to ${esc(report.window_end)}, reported ${esc(report.created_at)}. ` +
    `${esc(report.groups.length)} groups (${esc(runs)} runs), ${esc(report.patterns.length)} single-run patterns.</p>` +
    `${table}</section>`
  );
}

async function draftCell(w: Withholder, g: FailureGroup): Promise<string> {
  const d = g.draft;
  if (!d) return `<span class="muted">no draft</span>`;
  switch (d.status) {
    case "drafted":
      return `<strong>cause:</strong> ${await w.text(d.cause)}<br><strong>fix:</strong> ${await w.text(d.fix)}`;
    case "withheld":
      return await w.text(`withheld (${d.rules.join(", ")})`);
    case "failed":
    case "skipped":
      return await w.text(`${d.status} (${d.reason})`);
  }
}

function filingText(g: FailureGroup): string | null {
  const f = g.filing;
  if (!f) return null;
  switch (f.status) {
    case "filed":
    case "linked":
      return `${f.status}: ${f.ref.link || f.ref.id}`;
    case "commented":
      return `commented on ${f.ref.link || f.ref.id}: ${f.run_ids.length} new runs`;
    case "withheld":
      return `withheld (${f.rules.join(", ")})`;
    case "skipped":
    case "failed":
      return `${f.status} (${f.reason})`;
  }
}
