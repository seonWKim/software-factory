// GET /api/health and the app's health reads: the same checks as `factory doctor`, from the one implementation
// (doctorChecks, src/setup.ts), which the composition root passes in as `run`, plus the GitHub sync line
// (syncChecks), a store read. The report shows each check in plain words with its raw text as `detail` (reportRows).
// It limits how often the checks run, shares one run between concurrent requests, and egress-scans every message
// before it leaves (design §9).

import { syncLeaseName } from "../core/lease.js";
import { readStoredProject } from "../core/project-labels.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type Check, type CheckStatus, checkStatus } from "../setup.js";
import { type Activity, BackgroundSnapshot } from "./background-refresh.js";
import { Withholder } from "./withhold.js";

export const HEALTH_MIN_INTERVAL_MS = 60_000;

/** Below this share of the limit left, the sync line is a warn: optional reads wait for the reset on every replica. */
const LOW_SHARE = 0.1;

const grouped = new Intl.NumberFormat("en-US");

/**
 * The GitHub sync line (design 05-coordination, sync lease): the shared budget (`forge_budget`, plugin `plugin`) and
 * the replica holding `sync:github_issue:<project>`, from the store only, no GitHub call. Health shows the plain
 * `GitHub: 812 of 5,000 requests left this hour`; the raw `GitHub: 812/5000 left, resets 09:12, synced by replica
 * host:42` (reset in UTC) goes behind Details. A warn with no live holder or under 10% left. None while neither is
 * stored (no GitHub plugin selected, or nothing synced yet).
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
  const requests = budget ? `GitHub: ${grouped.format(budget.remaining)} of ${grouped.format(budget.limit)} requests left this hour` : "GitHub: requests left not reported yet";
  const plain = holder ? requests : `${requests}; no worker syncs it now`;
  return [{ ok: holder !== null && !low, ...((holder === null || low) && { warn: true }), msg, plain }];
}

/** One finished run, messages as the checks wrote them. Never leaves this module unfiltered. */
interface RawRun {
  started_at: Date;
  checked_at: Date;
  checks: readonly Check[];
}

/**
 * One row of the report: `msg` is the sentence Health shows; `detail`, when the check has one, the raw text behind
 * Details; `since` / `next`, when the check names a time, its ISO instants (the page shows them in local time).
 */
export interface HealthRow {
  status: CheckStatus;
  msg: string;
  detail?: string;
  since?: string;
  next?: string;
}

/** What GET /api/health returns. Every `msg` and `detail` has passed through the Withholder. */
export interface HealthReport {
  checked_at: string;
  checks: HealthRow[];
}

/**
 * An absolute file path in a check's text (after the start, a space or a bracket; not a GitHub API route after its
 * method): Health shows it only behind Details.
 */
const PATH = /(?<=^|[\s(])(?<!(?:GET|POST|PUT|PATCH|DELETE) )~?\/[^\s;,()'"]+/g;

/** A check as a report row: its `plain` sentence, else its text with every path moved behind Details, else its text. */
function row(c: Check): HealthRow {
  const plain = c.plain ?? c.msg.replace(PATH, "(path in Details)");
  const times = { ...(c.since !== undefined && { since: c.since }), ...(c.next !== undefined && { next: c.next }) };
  return plain === c.msg ? { status: checkStatus(c), msg: c.msg, ...times } : { status: checkStatus(c), msg: plain, detail: c.msg, ...times };
}

/**
 * The report's rows, in the checks' order (design 09-health, 2026-11-20): each check in plain words with its raw text as
 * `detail`, and every GitHub status-label check folded into one row where the first stood: "GitHub labels: all present",
 * or one warn "GitHub labels: N missing (run: npm run setup)" for N missing or unchecked, their lines in `detail`.
 */
export function reportRows(checks: readonly Check[]): HealthRow[] {
  const labels = checks.filter((c) => c.label !== undefined);
  const missing = labels.filter((c) => !c.ok);
  const folded: HealthRow = missing.length === 0
    ? { status: "ok", msg: "GitHub labels: all present", detail: labels.map((c) => c.msg).join("\n") }
    : { status: "warn", msg: `GitHub labels: ${missing.length} missing (run: npm run setup)`, detail: missing.map((c) => c.msg).join("\n") };
  return checks.flatMap((c) => (c.label === undefined ? [row(c)] : c === labels[0] ? [folded] : []));
}

/**
 * Runs the checks at most once per `min_interval_ms` per process (measured between run starts), whoever
 * asks: every read of the report counts. A request during a run waits for that run.
 * In-process state on purpose: it is a per-process rate limit on a read-only probe, not shared state.
 */
export class HealthMonitor {
  private last: RawRun | null = null;
  private inflight: Promise<RawRun> | null = null;
  private snapshot: BackgroundSnapshot<RawRun> | null = null;

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
    try {
      return await this.execute(started_at);
    } catch (err) {
      return this.failed(started_at, err);
    }
  }

  private async execute(started_at: Date): Promise<RawRun> {
    const checks = await this.run();
    return { started_at, checked_at: this.clock.now(), checks };
  }

  /** doctor would stop on this error; the report shows it as one FAIL instead (scanned like any message). */
  private failed(started_at: Date, err: unknown): RawRun {
    const checks = [{ ok: false, msg: `health checks could not finish: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` }];
    return { started_at, checked_at: this.clock.now(), checks };
  }

  /**
   * From now on `report` answers from the last run at once and the checks run in the background (design 09-health,
   * 2026-11-19): every `min_interval_ms` while the page is in use, and after `refresh()`. The first report waits for
   * the first run only; a run that throws keeps the last good one. `activity` is shared with the other routes' snapshots,
   * so a read of any of them keeps this one refreshing. Not started: the on-demand behaviour above.
   */
  start(activity?: Activity): void {
    this.snapshot ??= new BackgroundSnapshot(() => this.execute(this.clock.now()), this.clock, this.min_interval_ms, activity);
    this.snapshot.start();
  }

  /** Stops the background runs and goes back to checking on request. */
  stop(): void {
    this.snapshot?.stop();
    this.snapshot = null;
  }

  /** Starts a background run now (after a write); does nothing when not started. */
  refresh(): void {
    this.snapshot?.refreshInBackground();
  }

  private async current(): Promise<RawRun> {
    if (!this.snapshot) return this.latest();
    try {
      return (await this.snapshot.read()).value;
    } catch (err) {
      return this.failed(this.clock.now(), err);
    }
  }

  /** The checks for the API as report rows (`reportRows`), every message and detail through the Withholder. */
  async report(scanner: EgressScanner): Promise<HealthReport> {
    const r = await this.current();
    const w = new Withholder(scanner);
    const checks: HealthRow[] = [];
    for (const c of reportRows(r.checks)) {
      // `since` and `next` are instants the checks computed, never outside text: they pass as they are.
      const { detail, ...rest } = c;
      const msg = (await w.plain(c.msg)).text;
      checks.push(detail === undefined ? { ...rest, msg } : { ...rest, msg, detail: (await w.plain(detail)).text });
    }
    return { checked_at: r.checked_at.toISOString(), checks };
  }
}

