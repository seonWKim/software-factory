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
  if (a.pattern === "auto_stopped") return `Alarm: auto mode stopped (${AUTO_STOP_TEXT[a.error_code] ?? a.error_code}); the mode is manual`;
  if (a.pattern === "dead_letter") return `Alarm: a message on ${deadLetterTopic(a)} was dead-lettered (${DEAD_LETTER_TEXT[a.error_code] ?? a.error_code})`;
  if (a.pattern === "spend_budget") return `Alarm: spending passed ${spendOf(a).pct}% of the ${spendOf(a).period} budget`;
  return `Alarm: the factory restarted ${a.count} times in ${RESTART_WINDOW_MS / 60_000} minutes`;
}

/** Each auto-mode stop's cause (the alert's error code, design 03-risk), as the alarm sentence names it. */
const AUTO_STOP_TEXT: Readonly<Record<string, string>> = {
  red_main: "the checks failed on the base branch after a merge",
  failure_alert: "a failure alarm",
  budget_checkpoint: "a budget checkpoint",
};

/** Why the bus dead-lettered a message (its dead letter's error code, RFC 0015 §5.4). */
const DEAD_LETTER_TEXT: Readonly<Record<string, string>> = {
  max_attempts: "it failed on every attempt",
  non_retryable: "it failed in a way a retry cannot fix",
  unhandled: "no handler takes it",
};

/** The topic of a dead_letter alert, from its key `dead_letter:<topic>:<group>:<seq>`. */
function deadLetterTopic(a: Alert): string {
  return a.pattern_key.split(":")[1] ?? "the bus";
}

/** A spend_budget alert's period and threshold, from its error code `<daily|weekly>_<percent>` (design 06-spend). */
function spendOf(a: Alert): { period: string; pct: string } {
  const [period = "spend", pct = "?"] = a.error_code.split("_");
  return { period, pct };
}

/** Where the operator looks into the alarm; no command resolves one (it closes once its pattern stops). */
export function alarmCommand(a: Alert): string {
  if (a.pattern === "spend_budget") return "Spend page (/app/spend)";
  if (a.pattern === "repeated_error") return "Failures page (/app/failures)";
  if (a.pattern === "zero_tokens") return "factory llm-check";
  if (a.pattern === "auto_stopped") return "factory mode auto (after the cause is fixed)";
  if (a.pattern === "dead_letter") return `bus_${deadLetterTopic(a).replace(/\./g, "_")}_dead_letters (replay once the cause is fixed)`;
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
    // A stop of auto mode, a dead letter or a spend alert holds up no item: Needs you shows the alarm.
    if (a.pattern === "auto_stopped" || a.pattern === "dead_letter" || a.pattern === "spend_budget") return false;
    if (last === null || Date.parse(last.finished_at!) < Date.parse(a.created_at) - ALERT_DEDUPE_MS) return false;
    if (a.pattern === "repeated_error") return last.outcome?.status === "failed" && last.outcome.error_code === a.error_code;
    return (MODEL_RUN_KINDS as readonly string[]).includes(last.kind) && runTokenCount(last) === 0;
  });
}

/** alarmsFor with the item's runs read from the store, only while some alarm is open. */
export async function itemAlarms(store: Pick<FactoryStore, "listRuns">, open: readonly Alert[], it: WorkItem): Promise<Alert[]> {
  return open.length === 0 || it.stage === "CLOSED" ? [] : alarmsFor(open, it, await store.listRuns(it.id));
}
