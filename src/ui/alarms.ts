// Open alarms in the status views (design 09-status-page, alarms in Needs you): the alerts the alarm step stored
// (design 05-alarms), shown in Needs you and named in the why-it-waits sentence of each item they affect. An alarm
// is open while its newest alert is younger than the alarm step's dedupe window (ALERT_DEDUPE_MS): a pattern that
// still holds then alerts again, one that stopped is resolved. A failed chat check (chat_eval_failed, design
// 04-chat-agent) has no window: it stays open until the owner dismisses it. One the owner dismissed (`factory alarm dismiss`, POST
// /api/v1/alarms/dismiss) is hidden until its pattern alerts again. Store reads only (listAlerts, listRuns).

import { ALERT_DEDUPE_MS, RESTART_WINDOW_MS } from "../core/alarms.js";
import { MODEL_RUN_KINDS } from "../core/model-choice.js";
import { AUTO_ACTOR } from "../core/policy.js";
import { type Run, type WorkItem, runTokenCount } from "../core/types.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";
import { failureWords } from "./why.js";

/** Most alerts one view reads: far more than the patterns that can alert within one dedupe window. */
const ALERTS_READ = 100;

/** Patterns that stay open until the owner dismisses them, however old: nothing raises them again to keep them open. */
const UNTIL_DISMISSED: ReadonlySet<Alert["pattern"]> = new Set(["chat_eval_failed"]);

/**
 * The open alarms as of `now`, newest first: the newest alert of each pattern key, raised less than the window ago
 * (any time for an UNTIL_DISMISSED pattern) and not dismissed at or after it was raised.
 */
export async function openAlarms(store: Pick<FactoryStore, "listAlerts">, now: Date): Promise<Alert[]> {
  const since = now.getTime() - ALERT_DEDUPE_MS;
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const a of await store.listAlerts({ limit: ALERTS_READ })) {
    if ((Date.parse(a.created_at) <= since && !UNTIL_DISMISSED.has(a.pattern)) || seen.has(a.pattern_key)) continue;
    seen.add(a.pattern_key);
    if (a.dismissed_at === undefined || a.dismissed_at < a.created_at) out.push(a);
  }
  return out;
}

/** When the alarm closes by itself unless its pattern alerts again; null for one that stays until dismissed. */
export function alarmUntil(a: Alert): string | null {
  if (UNTIL_DISMISSED.has(a.pattern)) return null;
  return new Date(Date.parse(a.created_at) + ALERT_DEDUPE_MS).toISOString();
}

/** The alarm in one plain sentence, without its detail or any time (the why-it-waits sentence names it this way; the page shows `auto_stop.at`). */
export function alarmText(a: Alert): string {
  if (a.pattern === "repeated_error") return `Alarm: ${a.count} runs on several items failed the same way (${clause(failureWords(a.error_code))})`;
  if (a.pattern === "zero_tokens") return `Alarm: ${a.count} agent runs in a row used no tokens`;
  if (a.pattern === "auto_stopped") return `Alarm: back to manual: ${AUTO_STOP_TEXT[a.error_code] ?? "a check the factory has no plain words for yet"}`;
  if (a.pattern === "dead_letter") return `Alarm: a message on ${deadLetterTopic(a)} was dead-lettered (${DEAD_LETTER_TEXT[a.error_code] ?? "for a reason the factory has no plain words for yet"})`;
  if (a.pattern === "spend_budget") return `Alarm: spending passed ${spendOf(a).pct}% of the ${spendOf(a).period} budget`;
  if (hostCheckAlert(a)) return `Alarm: a check could not run on this host at \`${redMainSha(a).slice(0, 12)}\` (an environment problem, not a red base); the merge is kept`;
  if (a.pattern === "red_main") return `Alarm: the base branch fails its checks on its own at \`${redMainSha(a).slice(0, 12)}\`; merge-queue changes wait until it moves`;
  if (a.pattern === "skill_draft_limit") return `Alarm: a skill draft limit was reached (${a.error_code} is ${a.count})`;
  if (a.pattern === "skill_version_gate") return `Alarm: version ${a.count} of a skill is held: its eval pass rate fell`;
  if (a.pattern === "coordinator_limit") return "Alarm: the coordinator reached its daily spend limit; its cycles are stopped until you answer or the UTC day ends";
  if (a.pattern === "chat_eval_failed") return "Alarm: the daily chat check failed; chat answers may be broken until the cause is fixed";
  if (a.pattern === "ci_rerun_failed") return "Alarm: an item's cancelled CI jobs could not be rerun; it waits on its checks with no loop counted";
  return `Alarm: the factory restarted ${a.count} times in ${RESTART_WINDOW_MS / 60_000} minutes`;
}

/** Each auto-mode stop's cause (the alert's error code, design 03-risk), as the alarm sentence names it. */
const AUTO_STOP_TEXT: Readonly<Record<string, string>> = {
  red_main: "the checks failed on the base branch after a merge",
  failure_alert: "a failure alarm",
  budget_checkpoint: "a budget checkpoint",
};

/** The newest mode changes read to find the last one; far more than the mode changes between two stops. */
const MODE_CHANGES_READ = 200;

/** What a failed check printed, as the red-main check keeps it: the failing tests by name, and the output tail (null: none kept). */
export interface CheckOutput {
  failing_tests: string[];
  output_tail: string | null;
}

/**
 * A red_main alert's detail read back (design 03-risk): the red-main check stores JSON `{ text, failing_tests,
 * output_tail }`; an older alert, or one raised from the merge check, stores the text alone and has no output.
 */
export function redMainDetail(a: Alert): { text: string | null; output: CheckOutput | null } {
  if (a.detail === null || !a.detail.startsWith("{")) return { text: a.detail, output: null };
  try {
    const d = JSON.parse(a.detail) as Record<string, unknown>;
    const failing_tests = Array.isArray(d.failing_tests) ? d.failing_tests.filter((t): t is string => typeof t === "string") : [];
    const output_tail = typeof d.output_tail === "string" && d.output_tail !== "" ? d.output_tail : null;
    return { text: typeof d.text === "string" ? d.text : null, output: { failing_tests, output_tail } };
  } catch {
    return { text: a.detail, output: null };
  }
}

/** A plain-words sentence as a clause inside another: lower case first letter, no closing period. */
const clause = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1).replace(/\.$/, "");

/**
 * A zero-token alert's detail (core/alarms.ts zeroTokens: "the last failed with <code>" or "the last succeeded")
 * in plain words: how the last run ended, its error in words (failureWords), never the code.
 */
function zeroTokensDetail(detail: string): string {
  const failed = /^the last failed with (.+)$/.exec(detail);
  if (failed) return `the last one failed (${clause(failureWords(failed[1]!))})`;
  return detail === "the last succeeded" ? "the last one succeeded" : detail;
}

/** An alarm's sentence with its detail, as Needs you and the alarms API show it. */
export function alarmFullText(a: Alert): string {
  const detail = a.pattern === "red_main" ? redMainDetail(a).text : a.pattern === "zero_tokens" && a.detail !== null ? zeroTokensDetail(a.detail) : a.detail;
  return detail === null ? alarmText(a) : `${alarmText(a)}: ${detail}`;
}

/** The last auto-mode stop while it is still in force, as the Mode toggle and the system banner show it. */
export interface AutoStopNote {
  /** The `auto_stopped` alert: the toggle and the banner link to it. */
  alert_id: string;
  /** When auto mode stopped (the alert's time). */
  at: string;
  /** Its cause, the alert's error code: `red_main`, `budget_checkpoint` or `failure_alert`. */
  cause: string;
  /** A red_main cause: what the red-main check printed, from the newest red_main alert (empty when it kept none). */
  failing_tests?: string[];
  output_tail?: string | null;
}

/**
 * The last auto-mode stop (design 03-risk), or null when none is in force: the newest `mode` change was not the
 * stop's (`system:auto` setting manual), so the owner set the mode since. A red_main stop carries the output of the
 * newest red_main alert raised up to the stop. Store reads only.
 */
export async function lastAutoStop(store: Pick<FactoryStore, "listAlerts" | "listSettingChanges">): Promise<AutoStopNote | null> {
  const last = (await store.listSettingChanges(MODE_CHANGES_READ)).find((c) => c.key === "mode");
  if (!last || last.actor !== AUTO_ACTOR) return null;
  const alerts = await store.listAlerts({ limit: ALERTS_READ });
  const a = alerts.find((x) => x.pattern === "auto_stopped");
  if (!a) return null;
  const note = { alert_id: a.id, at: a.created_at, cause: a.error_code };
  if (a.error_code !== "red_main") return note;
  const red = alerts.find((x) => x.pattern === "red_main" && !hostCheckAlert(x) && x.created_at <= a.created_at);
  const output = red ? redMainDetail(red).output : null;
  return { ...note, failing_tests: output?.failing_tests ?? [], output_tail: output?.output_tail ?? null };
}

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

/** The base sha of a red_main alert, from its key `red_main:<sha>` (a host check alert: `red_main:<sha>:checks_env`). */
function redMainSha(a: Alert): string {
  return a.pattern_key.slice("red_main:".length).split(":")[0]!;
}

/**
 * A red_main alert with error code `checks_env` (design 03-risk): a check on the new base tip could not run on this
 * host (a missing toolchain, or a command that could not start). An environment problem, not a red base: the merge
 * is kept, no fix item is filed and queued changes do not wait on it.
 */
function hostCheckAlert(a: Alert): boolean {
  return a.pattern === "red_main" && a.error_code === "checks_env";
}

/** Where the operator looks into the alarm; it closes once its pattern stops, or when dismissed (`factory alarm dismiss <id>`). */
export function alarmCommand(a: Alert): string {
  if (a.pattern === "spend_budget") return "Spend page (/app/spend)";
  if (a.pattern === "repeated_error") return "Failures page (/app/failures)";
  if (a.pattern === "zero_tokens") return "factory llm-check";
  if (a.pattern === "auto_stopped") return "Turn auto back on in Settings (/app/settings) after the cause is fixed, or factory mode auto";
  if (hostCheckAlert(a)) return "Install or fix the missing tool on this host (its detail names it), then factory doctor; nothing was reverted and the next merge checks again";
  if (a.pattern === "red_main") return `Fix the base branch at ${redMainSha(a)} (a fix item is filed for it); queued changes are checked again once it moves`;
  if (a.pattern === "dead_letter") return `bus_${deadLetterTopic(a).replace(/\./g, "_")}_dead_letters (replay once the cause is fixed)`;
  if (a.pattern === "skill_draft_limit") return `${a.error_code} in factory.config.json`;
  if (a.pattern === "coordinator_limit") return "factory approve <usd> (sets spend.coordinator_daily_usd and resumes cycles) or factory reject (cycles stay stopped until the UTC day ends)";
  if (a.pattern === "chat_eval_failed") return "npm run eval:chat (runs the chat check again; factory llm-check checks the model), then factory alarm dismiss <id>";
  if (a.pattern === "ci_rerun_failed") return "Rerun the cancelled jobs on the PR's checks, or push a new commit; the factory reads the checks again each checks step";
  if (a.pattern === "skill_version_gate") return "Use this version or Keep the current version on the alarm or the skill's Evals page, or factory approve (the newest held version becomes current) or factory reject (the version current before it stays current); factory eval compare shows the held version's gate run against the current version's run";
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
    // A cancelled-jobs rerun that failed names its item in its key (design 05-ci-gate, Cancelled checks).
    if (a.pattern === "ci_rerun_failed") return a.pattern_key.startsWith(`ci_rerun_failed:${it.id}:`);
    // A stop of auto mode, a dead letter, a spend alert, red main, a skill draft limit, a held skill version, the coordinator limit or a failed chat check holds up no run of the item: Needs you shows the alarm.
    if (a.pattern === "auto_stopped" || a.pattern === "dead_letter" || a.pattern === "spend_budget" || a.pattern === "red_main" || a.pattern === "skill_draft_limit" || a.pattern === "skill_version_gate" || a.pattern === "coordinator_limit" || a.pattern === "chat_eval_failed") return false;
    if (last === null || Date.parse(last.finished_at!) < Date.parse(a.created_at) - ALERT_DEDUPE_MS) return false;
    if (a.pattern === "repeated_error") return last.outcome?.status === "failed" && last.outcome.error_code === a.error_code;
    return (MODEL_RUN_KINDS as readonly string[]).includes(last.kind) && runTokenCount(last) === 0;
  });
}

/** alarmsFor with the item's runs read from the store, only while some alarm is open. */
export async function itemAlarms(store: Pick<FactoryStore, "listRuns">, open: readonly Alert[], it: WorkItem): Promise<Alert[]> {
  return open.length === 0 || it.stage === "CLOSED" ? [] : alarmsFor(open, it, await store.listRuns(it.id));
}
