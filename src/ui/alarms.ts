// Open alarms in the status views (design 09-status-page, alarms in Needs you): the alerts the alarm step stored
// (design 05-alarms), shown in Needs you and named in the why-it-waits sentence of each item they affect. An alarm
// is open while its newest alert is younger than the alarm step's dedupe window (ALERT_DEDUPE_MS): a pattern that
// still holds then alerts again, one that stopped is resolved. Store reads only (listAlerts, listRuns).

import { ALERT_DEDUPE_MS, RESTART_WINDOW_MS } from "../core/alarms.js";
import { MODEL_RUN_KINDS } from "../core/model-choice.js";
import { type Run, type WorkItem, runTokenCount } from "../core/types.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";

/** Most alerts one view reads: far more than the patterns that can alert within one dedupe window. */
const ALERTS_READ = 100;

/** The open alarms as of `now`, newest first: the newest alert of each pattern key, raised less than the window ago. */
export async function openAlarms(store: Pick<FactoryStore, "listAlerts">, now: Date): Promise<Alert[]> {
  const since = now.getTime() - ALERT_DEDUPE_MS;
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const a of await store.listAlerts({ limit: ALERTS_READ })) {
    if (Date.parse(a.created_at) <= since || seen.has(a.pattern_key)) continue;
    seen.add(a.pattern_key);
    out.push(a);
  }
  return out;
}

/** When the alarm closes by itself unless its pattern alerts again. */
export function alarmUntil(a: Alert): string {
  return new Date(Date.parse(a.created_at) + ALERT_DEDUPE_MS).toISOString();
}

/** The alarm in one plain sentence, without its detail (the why-it-waits sentence names it this way). */
export function alarmText(a: Alert): string {
  if (a.pattern === "repeated_error") return `Alarm: ${a.error_code} failed ${a.count} runs on several items`;
  if (a.pattern === "zero_tokens") return `Alarm: ${a.count} agent runs in a row used no tokens`;
  return `Alarm: the factory restarted ${a.count} times in ${RESTART_WINDOW_MS / 60_000} minutes`;
}

/** Where the operator looks into the alarm; no command resolves one (it closes once its pattern stops). */
export function alarmCommand(a: Alert): string {
  if (a.pattern === "repeated_error") return "Failures page (/app/failures)";
  if (a.pattern === "zero_tokens") return "factory llm-check";
  return "factory doctor";
}

/**
 * The open alarms that affect an open item, from its runs. A repeated error: its latest finished run failed with
 * the alarm's code. Zero tokens: its latest finished run is an agent run that used no tokens. Both only for a run
 * that finished inside the dedupe window before the alert or after it. Child restarts: it has a queued or running
 * run, which the crash loop holds up.
 */
export function alarmsFor(open: readonly Alert[], it: WorkItem, runs: readonly Run[]): Alert[] {
  if (open.length === 0 || it.stage === "CLOSED") return [];
  const last = runs.filter((r) => r.finished_at !== null).reduce<Run | null>((a, r) => (a === null || r.finished_at! >= a.finished_at! ? r : a), null);
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  return open.filter((a) => {
    if (a.pattern === "child_restarts") return active;
    if (last === null || Date.parse(last.finished_at!) < Date.parse(a.created_at) - ALERT_DEDUPE_MS) return false;
    if (a.pattern === "repeated_error") return last.outcome?.status === "failed" && last.outcome.error_code === a.error_code;
    return (MODEL_RUN_KINDS as readonly string[]).includes(last.kind) && runTokenCount(last) === 0;
  });
}

/** alarmsFor with the item's runs read from the store, only while some alarm is open. */
export async function itemAlarms(store: Pick<FactoryStore, "listRuns">, open: readonly Alert[], it: WorkItem): Promise<Alert[]> {
  return open.length === 0 || it.stage === "CLOSED" ? [] : alarmsFor(open, it, await store.listRuns(it.id));
}
