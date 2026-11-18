// Retiring a scheduled job (design 05-alarms): a job whose target (a project, an item, a pattern) is gone and whose
// newest RETIRE_NOOP_RUNS runs all did nothing gets one retirement proposal, stored as an alert keyed
// `job-retire:<job id>`. The job keeps running until the owner answers: `/approve` disables it, `/reject` keeps it,
// and either way the job is never proposed again. The check is pure; the step reads the jobs and the injected clock
// and writes one conditional alert insert. No model, forge or other remote call.

import type { Logger } from "./log.js";
import type { Timestamp } from "./types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";

/** Runs in a row that did nothing, with the target gone, before a job is proposed for retirement. Not a setting. */
export const RETIRE_NOOP_RUNS = 3;
/** The key prefix of a retirement proposal; the job id follows. */
export const JOB_RETIRE_PREFIX = "job-retire:";
/**
 * A proposal's dedupe: longer than any job lives, so a job is proposed once. A rejected job is then never proposed
 * again with no stored answer, and an unanswered proposal is not repeated.
 */
const PROPOSE_ONCE_MS = 100 * 365 * 86_400_000;

/** One finished run of a scheduled job: whether it did nothing. */
export interface JobRun {
  finished_at: Timestamp;
  noop: boolean;
}

/** A scheduled job as the component that schedules it reports it, read from the store. */
export interface ScheduledJob {
  id: string;
  /** What the job works on, named for the proposal (`project:<key>`, an item or pattern id). */
  target: string;
  target_exists: boolean;
  disabled: boolean;
  /** Its finished runs, newest first. */
  runs: readonly JobRun[];
}

/** The scheduled jobs and the one change the owner's `/approve` makes to them. */
export interface ScheduledJobs {
  list(): Promise<readonly ScheduledJob[]>;
  /** Stops scheduling the job; safe to call twice. */
  disable(id: string): Promise<void>;
}

export interface RetirementDeps {
  store: Pick<FactoryStore, "recordAlert">;
  scanner: EgressScanner;
  clock: Clock;
  log: Logger;
  jobs: ScheduledJobs;
}

export type RetirementVerdict = "approve" | "reject";

/** Whether `job` is due a proposal as of `now`: enabled, its target gone, its newest RETIRE_NOOP_RUNS runs by `now` no-ops. Pure. */
export function dueForRetirement(job: ScheduledJob, now: Date): boolean {
  if (job.disabled || job.target_exists) return false;
  const newest = job.runs.filter((r) => Date.parse(r.finished_at) <= now.getTime()).slice(0, RETIRE_NOOP_RUNS);
  return newest.length === RETIRE_NOOP_RUNS && newest.every((r) => r.noop);
}

/**
 * One retirement step: each job due a proposal stores one alert (pattern `repeated_error`, code `job_noop`, key
 * `job-retire:<id>`, the scanned detail) through the store's conditional insert, once per job: two steps or replicas
 * store one. The job is not disabled. Returns the proposals this call stored.
 */
export async function retirementStep(d: RetirementDeps): Promise<Alert[]> {
  const now = d.clock.now();
  const stored: Alert[] = [];
  for (const job of await d.jobs.list()) {
    if (!dueForRetirement(job, now)) continue;
    const detail = `Scheduled job ${job.id}: its target ${job.target} is gone and its last ${RETIRE_NOOP_RUNS} runs did nothing. /approve retires it, /reject keeps it.`;
    // G5: alerts reach the status page, so the detail is scanned as UI text.
    const scan = await d.scanner.scan("ui", detail);
    const r = await d.store.recordAlert(
      { pattern: "repeated_error", pattern_key: `${JOB_RETIRE_PREFIX}${job.id}`, error_code: "job_noop", count: RETIRE_NOOP_RUNS, detail: scan.clean ? detail : null },
      PROPOSE_ONCE_MS,
    );
    if (!r.created) continue;
    stored.push(r.alert);
    d.log.warn("alarm: a scheduled job does nothing and its target is gone; retirement proposed", { alert_id: r.alert.id, job_id: job.id });
  }
  return stored;
}

/**
 * The owner's answer to a retirement proposal: `approve` disables its job, `reject` keeps it (the proposal never
 * repeats, so nothing is stored). False when `alert` is not a retirement proposal; nothing changes then.
 */
export async function decideRetirement(d: Pick<RetirementDeps, "jobs" | "log">, alert: Pick<Alert, "pattern_key">, verdict: RetirementVerdict): Promise<boolean> {
  if (!alert.pattern_key.startsWith(JOB_RETIRE_PREFIX)) return false;
  const id = alert.pattern_key.slice(JOB_RETIRE_PREFIX.length);
  if (verdict === "approve") await d.jobs.disable(id);
  d.log.info(verdict === "approve" ? "scheduled job retired" : "scheduled job kept", { job_id: id });
  return true;
}
