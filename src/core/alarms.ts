// The alarm step (design 05-alarms): a look across items on each controller poll. A pure detector finds three
// patterns in the store's recently finished runs and the supervisor's restart list: one error repeated on several
// items, agent runs in a row that used no tokens, and a child crash loop. Each pattern is stored as one alert per
// 6 hours through the store's conditional insert. No forge, LLM or sandbox call; the alert's text is scanned first.

import { cyrb53 } from "./hash.js";
import { normalizeDetail } from "./improver.js";
import type { Logger } from "./log.js";
import { MODEL_STALL } from "./policy.js";
import { type Run, type RunKind, type Timestamp, runTokenCount } from "./types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { Alert, AlertPattern, FactoryStore } from "../interfaces/factory-store.js";
import type { ChildRestart } from "../interfaces/updater.js";

/** One pattern alerts at most once per this long (the store's dedupe window). */
export const ALERT_DEDUPE_MS = 6 * 3_600_000;
/** Child restarts are counted over this long. */
export const RESTART_WINDOW_MS = 30 * 60_000;
/** The run kinds whose work is an agent's, so a run with no tokens means the model did nothing. */
const AGENT_RUN_KINDS: readonly RunKind[] = ["triage", "implement", "review", "resolve"];

/** The three alarm settings (settable live). */
export interface AlarmSettings {
  alarm_repeat_count: number;
  alarm_window_minutes: number;
  alarm_restart_count: number;
}

/** A pattern the detector found, before its detail is scanned and stored. */
export interface AlarmFinding {
  pattern: AlertPattern;
  pattern_key: string;
  error_code: string;
  count: number;
  detail: string;
}

/**
 * The patterns in `runs` and `restarts` as of `now`. Pure and deterministic. Repeated error: failed runs inside
 * the window that share an error code and normalized detail, on at least `alarm_repeat_count` distinct items.
 * Zero tokens: the newest `alarm_repeat_count` or more agent runs finished inside the window all used no tokens.
 * Child restarts: at least `alarm_restart_count` restarts within RESTART_WINDOW_MS, with the last exit reason.
 */
export function detectAlarms(input: {
  runs: readonly Run[];
  restarts: readonly ChildRestart[];
  now: Date;
  settings: AlarmSettings;
}): AlarmFinding[] {
  const { settings: s } = input;
  const now = input.now.getTime();
  const since = now - s.alarm_window_minutes * 60_000;
  const finished = input.runs
    .filter((r) => r.finished_at !== null && Date.parse(r.finished_at) >= since && Date.parse(r.finished_at) <= now)
    // Stable: runs finished at the same time keep the store's order (newest first, then insertion).
    .sort((a, b) => cmp(b.finished_at!, a.finished_at!));
  return [...repeatedErrors(finished, s.alarm_repeat_count), ...zeroTokens(finished, s.alarm_repeat_count), ...childRestarts(input.restarts, now, s.alarm_restart_count)];
}

function repeatedErrors(newestFirst: readonly Run[], threshold: number): AlarmFinding[] {
  const groups = new Map<string, { code: string; detail: string; runs: number; items: Set<string> }>();
  for (const r of newestFirst) {
    if (r.kind === "improve" || r.status !== "failed" || r.outcome?.status !== "failed") continue;
    const detail = normalizeDetail(r.outcome.detail ?? "");
    const key = `${r.outcome.error_code}\n${detail}`;
    const g = groups.get(key) ?? { code: r.outcome.error_code, detail, runs: 0, items: new Set<string>() };
    g.runs++;
    g.items.add(r.work_item_id);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.items.size >= threshold)
    .sort(([a], [b]) => cmp(a, b))
    .map(([key, g]) => ({ pattern: "repeated_error", pattern_key: `repeated_error:${cyrb53(key)}`, error_code: g.code, count: g.runs, detail: g.detail }));
}

function zeroTokens(newestFirst: readonly Run[], threshold: number): AlarmFinding[] {
  const agent = newestFirst.filter((r) => AGENT_RUN_KINDS.includes(r.kind) && (r.status === "succeeded" || r.status === "failed"));
  let streak = 0;
  while (streak < agent.length && runTokenCount(agent[streak]!) === 0) streak++;
  if (streak < threshold) return [];
  const last = agent[0]!.outcome;
  const how = last?.status === "failed" ? `the last failed with ${last.error_code}` : "the last succeeded";
  return [{ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: streak, detail: `${streak} agent runs in a row used no tokens; ${how}` }];
}

function childRestarts(restarts: readonly ChildRestart[], now: number, threshold: number): AlarmFinding[] {
  const recent = restarts
    .filter((r) => Date.parse(r.at) >= now - RESTART_WINDOW_MS && Date.parse(r.at) <= now)
    .sort((a, b) => cmp(a.at, b.at));
  if (recent.length < threshold) return [];
  return [{ pattern: "child_restarts", pattern_key: "child_restarts", error_code: "child_restarts", count: recent.length, detail: recent.at(-1)!.reason }];
}

export interface AlarmDeps {
  store: Pick<FactoryStore, "listRunsFinishedWithin" | "recordAlert" | "pauseClaims">;
  scanner: EgressScanner;
  clock: Clock;
  log: Logger;
  /** The supervisor's restart list on this host (design 05-alarms: host-local). Absent: no restart alarm. */
  restarts?: () => Promise<readonly ChildRestart[]>;
}

/**
 * One alarm step: reads the runs finished inside the window and the restart list, and stores each pattern found
 * unless it alerted within ALERT_DEDUPE_MS. A detail the egress scanner flags is dropped; the code and count stay.
 * A new zero-token alert starts the model_stall pause, first probe after `probe_interval_ms`. Returns the alerts
 * this call stored. Safe to run twice and on several replicas at once: the store's conditional insert dedupes.
 */
export async function alarmStep(d: AlarmDeps, settings: AlarmSettings & { probe_interval_ms: number }): Promise<Alert[]> {
  const now = d.clock.now();
  const runs = await d.store.listRunsFinishedWithin(settings.alarm_window_minutes * 60_000);
  const restarts = d.restarts ? await d.restarts() : [];
  const stored: Alert[] = [];
  for (const f of detectAlarms({ runs, restarts, now, settings })) {
    // G5: alerts reach the status page, so the detail is scanned as UI text, never stored unscanned.
    const scan = await d.scanner.scan("ui", f.detail);
    const r = await d.store.recordAlert({ ...f, detail: scan.clean ? f.detail : null }, ALERT_DEDUPE_MS);
    if (!r.created) continue;
    stored.push(r.alert);
    // The code and count only: the detail stays in the store, where the UI reads it.
    d.log.warn(`alarm: ${f.pattern}`, { alert_id: r.alert.id, error_code: f.error_code, count: f.count });
    if (f.pattern === "zero_tokens") {
      const pause = await d.store.pauseClaims(new Date(now.getTime() + settings.probe_interval_ms).toISOString() as Timestamp, MODEL_STALL);
      if (pause.started) d.log.warn(`agent runs use no tokens: all runs paused, first probe at ${pause.resume_at}`, { resume_at: pause.resume_at });
    }
  }
  return stored;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
