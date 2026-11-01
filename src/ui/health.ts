// The status page's Health panel and GET /api/health: the same checks as `factory doctor`, from the one
// implementation (doctorChecks, src/setup.ts), which the composition root passes in as `run`. This module
// holds no check logic. It limits how often the checks run, shares one run between concurrent requests,
// and egress-scans every message before it leaves (design §9).

import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import { type Check, type CheckStatus, checkStatus } from "../setup.js";
import { esc } from "./html.js";
import { Withholder } from "./withhold.js";

export const HEALTH_MIN_INTERVAL_MS = 60_000;

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
      `<p class="muted">Last run ${esc(r.checked_at.toISOString())}. <a href="/?health=refresh#health">refresh</a>${limited}</p>` +
      `${table}</section>`
    );
  }
}
