// GET /api/health and the app's health reads: the same checks as `factory doctor`, from the one implementation
// (doctorChecks, src/setup.ts), which the composition root passes in as `run`, plus the GitHub sync line
// (syncChecks), a store read. It limits how often the checks run, shares one run between concurrent requests,
// and egress-scans every message before it leaves (design §9).

import { syncLeaseName } from "../core/lease.js";
import { readStoredProject } from "../core/project-labels.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type Check, type CheckStatus, checkStatus } from "../setup.js";
import { BackgroundSnapshot } from "./background-refresh.js";
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
  /** When the reported run finished; null while `pending`. */
  checked_at: string | null;
  checks: { status: CheckStatus; msg: string }[];
  /** No run has finished yet (the server's stored report, design 09-health): no checks, the page keeps its placeholder. */
  pending: boolean;
  /** A run is going: a newer report follows. */
  refreshing: boolean;
}

/**
 * Runs the checks at most once per `min_interval_ms` per process (measured between run starts), whoever
 * asks: every read of the report counts. A request during a run waits for that run. After `serveStored()` (the UI
 * server) a report never waits: it is the stored one, refreshed in the background (design 09-health, 2026-11-19).
 * In-process state on purpose: it is a per-process rate limit on a read-only probe, not shared state.
 */
export class HealthMonitor {
  private last: RawRun | null = null;
  private inflight: Promise<RawRun> | null = null;
  private stored: BackgroundSnapshot<RawRun> | null = null;

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
      return this.failed(started_at, this.clock.now(), err);
    }
  }

  private async execute(started_at: Date): Promise<RawRun> {
    const checks = await this.run();
    return { started_at, checked_at: this.clock.now(), checks };
  }

  /** doctor would stop on this error; the report shows it as one FAIL instead (scanned like any message). */
  private failed(started_at: Date, checked_at: Date, err: unknown): RawRun {
    const checks = [{ ok: false, msg: `health checks could not finish: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` }];
    return { started_at, checked_at, checks };
  }

  /**
   * From now on `report` answers from the stored run at once (design 09-health, 2026-11-19): `pending` before the
   * first run ends, and a read starts a background run only when the stored one is `min_interval_ms` old or
   * `refreshNow()` marked it stale. No timer. A run that throws keeps the last good one. A second call does nothing.
   */
  serveStored(): void {
    this.stored ??= new BackgroundSnapshot(() => this.execute(this.clock.now()), this.clock, this.min_interval_ms);
  }

  /** After a write: marks the stored run stale and starts the next run now. Does nothing before `serveStored()`. */
  refreshNow(): void {
    this.stored?.markStale();
    this.stored?.refreshInBackground();
  }

  private async current(): Promise<{ run: RawRun | null; refreshing: boolean }> {
    if (!this.stored) return { run: await this.latest(), refreshing: false };
    const r = this.stored.read();
    if (r.state === "ready") return { run: r.value, refreshing: r.refreshing };
    if (r.state === "failed") return { run: this.failed(r.at, r.at, r.error), refreshing: false };
    return { run: null, refreshing: true };
  }

  /** The checks for the API, every message through the Withholder. */
  async report(scanner: EgressScanner): Promise<HealthReport> {
    const { run, refreshing } = await this.current();
    if (!run) return { checked_at: null, checks: [], pending: true, refreshing };
    const w = new Withholder(scanner);
    const checks = [];
    for (const c of run.checks) checks.push({ status: checkStatus(c), msg: (await w.plain(c.msg)).text });
    return { checked_at: run.checked_at.toISOString(), checks, pending: false, refreshing };
  }
}
