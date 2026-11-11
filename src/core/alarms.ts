// The alarm step (design 05-alarms): a look across items on each controller poll. A pure detector finds three
// patterns in the store's recently finished runs and the supervisor's restart list: one error repeated on several
// items, agent runs in a row that used no tokens, and a child crash loop. Each pattern is stored as one alert per
// 6 hours through the store's conditional insert. A failed run whose pattern has an open filed item holds its item
// for a person at once. A failure pattern that already alerted or was filed re-raises, at most once an hour, when it
// keeps failing: its items are held and its filed item gets a comment. No forge, LLM or sandbox call; every text is
// scanned first.

import { groupFailures, normalizeDetail, patternKey } from "./improver.js";
import type { Logger } from "./log.js";
import { AGENT_STALLED, MODEL_STALL } from "./policy.js";
import {
  type FailureGroup, type FiledPattern, RECURRING_FAILURE, type Run, type RunKind, type SourceRef, type StateChange, type Timestamp, type WorkItem, type WorkItemId,
  runTokenCount,
} from "./types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { Alert, AlertPattern, FactoryStore } from "../interfaces/factory-store.js";
import type { ChildRestart } from "../interfaces/updater.js";

/** One pattern alerts at most once per this long (the store's dedupe window). */
export const ALERT_DEDUPE_MS = 6 * 3_600_000;
/** Child restarts are counted over this long. */
export const RESTART_WINDOW_MS = 30 * 60_000;
/** A recurring pattern counts its new failures over this long, and re-raises at most once per this long. */
export const RERAISE_WINDOW_MS = 3_600_000;
/**
 * A filed item not in the store yet counts as open this long after its filing. Intake takes a filed item in at its
 * next poll, so one still missing after this never will be: filed without the intake label, refused, or closed
 * before intake read it. Read from the filing's time alone: no forge call.
 */
export const FILED_INTAKE_MS = 3_600_000;
/** The newest alerts a re-raise reads for a pattern's last alert and last re-raise: far more than one hour stores. */
const ALERTS_READ = 100;
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
    .map(([, g]) => ({ pattern: "repeated_error", pattern_key: alertKey(patternKey({ error_code: g.code, detail: g.detail })), error_code: g.code, count: g.runs, detail: g.detail }));
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

/** The repeated-error alert's key of a failure pattern (the improver's pattern key). */
const alertKey = (key: string) => `repeated_error:${key}`;
/** The re-raise's key of a failure pattern: its own dedupe row, one per RERAISE_WINDOW_MS. */
const reraiseKey = (key: string) => `recurring:${key}`;

export interface AlarmDeps {
  store: Pick<
    FactoryStore,
    "listRunsFinishedWithin" | "listRunsFinishedBetween" | "recordAlert" | "listAlerts" | "getFiledPattern" | "pauseClaims" | "getWorkItemBySource" | "listStateChanges"
  >;
  scanner: EgressScanner;
  clock: Clock;
  log: Logger;
  /** The project whose filed patterns a re-raise looks up. */
  project: string;
  /** The supervisor's restart list on this host (design 05-alarms: host-local). Absent: no restart alarm. */
  restarts?: () => Promise<readonly ChildRestart[]>;
  /** Holds the items of a filed or re-raised pattern (`recurring_failure`). Absent: none are held. */
  hold?: (p: HeldPattern) => Promise<void>;
  /** Posts on a filed item through its source, once per marker. Absent: no comment. */
  comment?: (ref: SourceRef, body: string, marker: string) => Promise<void>;
}

/**
 * One alarm step: reads the runs finished inside the window and the restart list, and stores each pattern found
 * unless it alerted within ALERT_DEDUPE_MS. A detail the egress scanner flags is dropped; the code and count stay.
 * A new zero-token alert starts the model_stall pause, first probe after `probe_interval_ms`. Each recurring
 * pattern re-raises first (`reraise`), then each failed run of an open filed pattern holds its item (`holdFiled`). Returns the alerts this call stored. Safe to run twice and on several
 * replicas at once: the store's conditional insert dedupes.
 */
export async function alarmStep(d: AlarmDeps, settings: AlarmSettings & { probe_interval_ms: number }): Promise<Alert[]> {
  const now = d.clock.now();
  const runs = await d.store.listRunsFinishedWithin(Math.max(settings.alarm_window_minutes * 60_000, RERAISE_WINDOW_MS));
  const restarts = d.restarts ? await d.restarts() : [];
  // Before this step's own alerts, so a pattern's new 6-hour alert never hides the re-raise it is due.
  const stored = await reraise(d, runs, now, settings.alarm_repeat_count);
  await holdFiled(d, runs, now);
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

/** The failure patterns of the runs finished within RERAISE_WINDOW_MS before `now`, as the improver groups them. */
function recentPatterns(runs: readonly Run[], now: Date): FailureGroup[] {
  const since = now.getTime() - RERAISE_WINDOW_MS;
  const { groups, patterns } = groupFailures(runs.filter((r) => r.finished_at !== null && Date.parse(r.finished_at) >= since));
  return [...groups, ...patterns];
}

/**
 * Re-raises each recurring pattern: one that already alerted (its repeated-error alert) or was filed (its filed
 * pattern), and that failed `threshold` more runs within the last hour after its last re-raise (none yet: after it
 * was first known, the earlier of its alert and its filing). The re-raise is an alert (pattern `repeated_error`, key
 * `recurring:<key>`) the store dedupes for RERAISE_WINDOW_MS, so of several replicas or steps exactly one stores it,
 * at most once an hour. That one holds the pattern's items (each not held for it since its run, `unheld`) and comments the
 * count since filing on its filed item.
 * Returns the re-raises it stored.
 */
async function reraise(d: AlarmDeps, runs: readonly Run[], now: Date, threshold: number): Promise<Alert[]> {
  const finished = new Map(runs.map((r) => [r.id, Date.parse(r.finished_at ?? "")]));
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const stored: Alert[] = [];
  // Each pattern key's newest alert, read once and only when some pattern is a candidate.
  let newest: Map<string, number> | null = null;
  for (const g of recentPatterns(runs, now)) {
    if (g.run_ids.length < threshold) continue;
    newest ??= await newestAlerts(d.store);
    const key = patternKey(g);
    const known = await knownSince(d, key, newest);
    if (known === null) continue;
    const { filed } = known;
    // Counted from the last re-raise, else from when the pattern was first known (its alert or its filing).
    const from = newest.get(reraiseKey(key)) ?? known.at;
    const fresh = g.run_ids.filter((id) => (finished.get(id) ?? 0) > from).length;
    if (fresh < threshold) continue;
    const scan = await d.scanner.scan("ui", g.detail);
    const r = await d.store.recordAlert(
      { pattern: "repeated_error", pattern_key: reraiseKey(key), error_code: g.error_code, count: fresh, detail: scan.clean ? g.detail : null },
      RERAISE_WINDOW_MS,
    );
    if (!r.created) continue;
    stored.push(r.alert);
    d.log.warn("alarm: recurring failure", { alert_id: r.alert.id, error_code: g.error_code, count: fresh, items: g.work_item_ids.length });
    if (d.hold) await d.hold({ pattern_key: key, work_item_ids: await unheld(d, g, key, byRun, null) });
    if (filed?.filed_ref && d.comment) await commentFiled(d, { ...filed, filed_ref: filed.filed_ref }, now, fresh, r.alert.id);
  }
  return stored;
}

/**
 * Holds the item of each failed run of the last RERAISE_WINDOW_MS whose pattern has an open filed item and that
 * finished after the filing: from its first matching run, not after `alarm_repeat_count` of them. Open: in the store
 * and not closed, or not in the store yet and filed less than FILED_INTAKE_MS ago. The hold itself is a conditional
 * transition of an item nothing else blocks, so a second step writes nothing.
 */
async function holdFiled(d: AlarmDeps, runs: readonly Run[], now: Date): Promise<void> {
  if (!d.hold) return;
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const g of recentPatterns(runs, now)) {
    const key = patternKey(g);
    const filed = await d.store.getFiledPattern(d.project, key);
    if (!filed?.filed_ref) continue;
    const fix = await d.store.getWorkItemBySource(filed.filed_ref.type, filed.filed_ref.id);
    if (fix ? fix.stage === "CLOSED" : now.getTime() - Date.parse(filed.created_at) >= FILED_INTAKE_MS) continue;
    const items = await unheld(d, g, key, byId, filed.created_at);
    if (items.length > 0) await d.hold({ pattern_key: key, work_item_ids: items });
  }
}

/**
 * The items of `g`'s runs that finished after `after` (null: any) and that no hold of `key` took after the run
 * finished, so a hold a person lifted (`/retry`) or the release cleared is not put back by the same run.
 */
async function unheld(
  d: Pick<AlarmDeps, "store">, g: FailureGroup, key: string, byId: ReadonlyMap<string, Run>, after: Timestamp | null,
): Promise<WorkItemId[]> {
  const items = new Set<WorkItemId>();
  for (const id of g.run_ids) {
    const r = byId.get(id)!;
    if ((after !== null && r.finished_at! <= after) || items.has(r.work_item_id)) continue;
    const held = (await d.store.listStateChanges(r.work_item_id))
      .some((c) => c.reason === RECURRING_FAILURE && c.detail?.pattern_key === key && c.at >= r.finished_at!);
    if (!held) items.add(r.work_item_id);
  }
  return [...items];
}

/** One comment on the pattern's filed item: its failed runs since filing and in the last hour; scanned, else none. */
async function commentFiled(d: AlarmDeps, filed: FiledPattern & { filed_ref: SourceRef }, now: Date, fresh: number, alert_id: string): Promise<void> {
  const { groups, patterns } = groupFailures(await d.store.listRunsFinishedBetween(filed.created_at, new Date(now.getTime() + 1).toISOString() as Timestamp));
  const all = [...groups, ...patterns].find((g) => patternKey(g) === filed.pattern_key);
  const body = [
    `This failure keeps coming back: ${all?.run_ids.length ?? fresh} failed runs since this item was filed (${filed.created_at}), ${fresh} of them in the last hour.`,
    "",
    "The work items it hit are held (`recurring_failure`) until this fix merges; then they are retried.",
  ].join("\n");
  const scan = await d.scanner.scan("comment", body);
  if (!scan.clean) return;
  await d.comment!(filed.filed_ref, body, `<!-- factory:recurring:${filed.pattern_key}:${alert_id} -->`);
}

/** Each pattern key's newest alert time, from the newest ALERTS_READ alerts. */
async function newestAlerts(store: Pick<FactoryStore, "listAlerts">): Promise<Map<string, number>> {
  return new Map((await store.listAlerts({ limit: ALERTS_READ })).reverse().map((a) => [a.pattern_key, Date.parse(a.created_at)]));
}

/** When a failure pattern was first known (the earlier of its alert and its filing) and its filing; null: neither. */
async function knownSince(
  d: Pick<AlarmDeps, "store" | "project">, key: string, newest: ReadonlyMap<string, number>,
): Promise<{ at: number; filed: FiledPattern | null } | null> {
  const filed = await d.store.getFiledPattern(d.project, key);
  const known = [newest.get(alertKey(key)), filed ? Date.parse(filed.created_at) : undefined].filter((m): m is number => m !== undefined);
  return known.length === 0 ? null : { at: Math.min(...known), filed };
}

/**
 * The recurring stall patterns of the last hour, whose items are held once the model answers (design 05-restarts):
 * failed runs with `agent_stalled` sharing a normalized detail, two or more of them (a group, as the improver files
 * them), of a pattern already known by its alert or its filing. The model answered, so the stall is the pattern's.
 */
export async function recurringStalls(d: Pick<AlarmDeps, "store" | "project" | "clock">): Promise<HeldPattern[]> {
  const out: HeldPattern[] = [];
  let newest: Map<string, number> | null = null;
  for (const g of recentPatterns(await d.store.listRunsFinishedWithin(RERAISE_WINDOW_MS), d.clock.now())) {
    if (g.error_code !== AGENT_STALLED || g.run_ids.length < 2) continue;
    newest ??= await newestAlerts(d.store);
    if (await knownSince(d, patternKey(g), newest)) out.push({ pattern_key: patternKey(g), work_item_ids: g.work_item_ids });
  }
  return out;
}

/** A recurring pattern and the items it hit, which it holds. */
export interface HeldPattern {
  pattern_key: string;
  work_item_ids: readonly WorkItemId[];
}

/** The open held items, by reason: any `blocked_on`, so holds stored as `upstream` (before 2026-11-11) are found too. */
export const HELD_ITEMS = { blocked_reason: RECURRING_FAILURE, exclude_closed: true } as const;

/** The state change reason of a held item's release (design 05-alarms); its hold's is `recurring_failure`. */
const RELEASED = "recurring_failure_released";

/** The hold of an item a recurring pattern hit, for a person, or null: closed, or something else blocks it. */
export function holdPatch(it: Pick<WorkItem, "stage" | "blocked_on">, pattern_key: string) {
  if (it.stage === "CLOSED" || it.blocked_on !== "none") return null;
  return { patch: { blocked_on: "human" as const, blocked_reason: RECURRING_FAILURE }, reason: RECURRING_FAILURE, detail: { pattern_key } };
}

/** The pattern key a held item waits on (its last hold's), or null when it is not held; `changes` read only when held. */
export async function heldKey(
  it: Pick<WorkItem, "blocked_reason">, changes: () => Promise<readonly Pick<StateChange, "reason" | "detail">[]>,
): Promise<string | null> {
  if (it.blocked_reason !== RECURRING_FAILURE) return null;
  const key = (await changes()).filter((c) => c.reason === RECURRING_FAILURE).at(-1)?.detail?.pattern_key;
  return typeof key === "string" ? key : null;
}

/** The release of a held item once `fix` merged (closed with a merge sha), or null: still waiting, or not held. */
export function releasePatch(it: Pick<WorkItem, "blocked_reason">, pattern_key: string, fix: Pick<WorkItem, "id" | "stage" | "merge_sha"> | null) {
  if (it.blocked_reason !== RECURRING_FAILURE || !fix || fix.stage !== "CLOSED" || !fix.merge_sha) return null;
  return { patch: { blocked_on: "none" as const, blocked_reason: null }, reason: RELEASED, detail: { pattern_key, fix_work_item_id: fix.id } };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
