// The alarm step (design 05-alarms): a look across items on each controller poll. A pure detector finds three
// patterns in the store's recently finished runs and the supervisor's restart list: one error repeated on several
// items, agent runs in a row that used no tokens, and a child crash loop. Each pattern is stored as one alert per
// 6 hours through the store's conditional insert. A new repeated-error alert holds the items it hit for a person, and
// only a crash loop stops auto mode (design 03-risk). A failed run whose pattern has an open filed item holds its item
// for a person at once. A failure pattern that already alerted or was filed re-raises, at most once an hour, when it
// keeps failing: its items are held and its filed item gets a comment. A stall (`agent_stalled`) is an infra failure
// its own item's retry rules handle (design 05-restarts): its pattern alerts, with the stall rate, and holds no item
// through any of these paths. None of these repeated-error paths counts a stall run that followed a recorded host sleep
// or an interactive run the owner abandoned: neither is a failure a person must act on. The same step checks the spend budgets
// (design 06-spend): 80% and 100% of a daily or weekly budget alert once each per period, and never stop, pause or
// hold anything. A run the pack grant check refused holds its item for a person at once and alerts once an hour, so
// an unattended run that could not reach its tools is never a silent no-op. A pattern the owner dismissed counts only
// the runs (and restarts) that finished after the dismissal, so a failure that goes on brings its alarm back; a
// dismissed spend threshold does not alert again in its period. No forge, LLM or sandbox call; every text is scanned
// first.

import { groupFailures, normalizeDetail, patternKey, sleptRuns } from "./improver.js";
import type { Logger } from "./log.js";
import { AGENT_STALLED, INTERACTIVE, MODEL_STALL, SESSION_ABANDONED } from "./policy.js";
import { COORDINATOR_LIMIT_KEY, DAY_MS, coordinatorLimitKey, dayStart, spendTotals, usd, utcDay, weekStart } from "./spend.js";
import {
  type FailureGroup, type FiledPattern, RECURRING_FAILURE, type Run, type RunId, type RunKind, type RunOutcome, type SourceRef, type StateChange, type Timestamp, type UserId, type WorkItem, type WorkItemId,
  runTokenCount,
} from "./types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { Alert, AlertPattern, FactoryStore, NewAlert } from "../interfaces/factory-store.js";
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
/**
 * The error code of a run the pack grant check refused (the worker's PACK_TOOL_REFUSED, src/packs/pack-grants.ts).
 * Named here because src/core imports nothing outside it.
 */
const PACK_TOOL_REFUSED = "pack_tool_refused";
/** The key prefix of a grant refusal's alert; the improver's pattern key follows. */
export const GRANT_REFUSED_PREFIX = "grant_refused:";
/** The run kinds whose work is an agent's, so a run with no tokens means the model did nothing. */
const AGENT_RUN_KINDS: readonly RunKind[] = ["triage", "implement", "review", "resolve"];

/** The three alarm settings (settable live). */
export interface AlarmSettings {
  alarm_repeat_count: number;
  alarm_window_minutes: number;
  alarm_restart_count: number;
}

/** The spend budgets in dollars (design 06-spend); null: no budget, no alert. */
export interface SpendBudgets {
  daily_usd: number | null;
  weekly_usd: number | null;
}
/** The shares of a budget, in percent, that alert once each per period. */
export const SPEND_THRESHOLDS = [80, 100] as const;
/** Longer than the longest period: the key names its period, so the dedupe only has to outlast it. */
const SPEND_DEDUPE_MS = 8 * DAY_MS;

/** A pattern the detector found, before its detail is scanned and stored. */
export interface AlarmFinding {
  pattern: AlertPattern;
  pattern_key: string;
  error_code: string;
  count: number;
  detail: string;
  /** A repeated error's pattern and its failed runs, whose items its new alert holds (none for stalls); never stored with the alert. */
  held?: { pattern_key: string; runs: readonly Run[] };
}

/**
 * The patterns in `runs` and `restarts` as of `now`. Pure and deterministic. Repeated error: failed runs inside
 * the window that share an error code and normalized detail, on at least `alarm_repeat_count` distinct items, leaving out
 * the runs in `skip` (stalls that followed a host sleep, `sleptStalls`) and abandoned interactive runs (`abandoned`); a
 * stall pattern's detail adds the stall rate (`stallRate`, which counts every stall) and it holds no item.
 * Zero tokens: the newest `alarm_repeat_count` or more agent runs finished inside the window all used no tokens.
 * Child restarts: at least `alarm_restart_count` restarts within RESTART_WINDOW_MS, with the last exit reason.
 * Each pattern counts only what finished (or restarted) after its key's dismissal in `dismissed`.
 */
export function detectAlarms(input: {
  runs: readonly Run[];
  restarts: readonly ChildRestart[];
  now: Date;
  settings: AlarmSettings;
  /** Failed runs the repeated-error check leaves out; absent: none. */
  skip?: ReadonlySet<RunId>;
  /** Each dismissed pattern key's dismissal time in ms (design 05-alarms); absent: none. */
  dismissed?: ReadonlyMap<string, number>;
}): AlarmFinding[] {
  const { settings: s } = input;
  const now = input.now.getTime();
  const since = now - s.alarm_window_minutes * 60_000;
  const finished = input.runs
    .filter((r) => r.finished_at !== null && Date.parse(r.finished_at) >= since && Date.parse(r.finished_at) <= now)
    // Stable: runs finished at the same time keep the store's order (newest first, then insertion).
    .sort((a, b) => cmp(b.finished_at!, a.finished_at!));
  const after = afterDismissal(input.dismissed ?? new Map());
  return [
    ...repeatedErrors(finished, input.skip ?? new Set(), after, s.alarm_repeat_count, s.alarm_window_minutes),
    ...zeroTokens(finished.filter((r) => after("zero_tokens", r.finished_at!)), s.alarm_repeat_count),
    ...childRestarts(input.restarts.filter((r) => after("child_restarts", r.at)), now, s.alarm_restart_count),
  ];
}

/** Whether a time is after the dismissal of a pattern key (none: always). */
type After = (pattern_key: string, at: string) => boolean;
const afterDismissal = (dismissed: ReadonlyMap<string, number>): After => (key, at) => Date.parse(at) > (dismissed.get(key) ?? -Infinity);

function repeatedErrors(newestFirst: readonly Run[], skip: ReadonlySet<RunId>, after: After, threshold: number, windowMinutes: number): AlarmFinding[] {
  const groups = new Map<string, { code: string; detail: string; runs: Run[]; items: Set<WorkItemId> }>();
  for (const r of newestFirst) {
    if (r.kind === "improve" || r.status !== "failed" || r.outcome?.status !== "failed" || abandoned(r) || skip.has(r.id)) continue;
    const detail = normalizeDetail(r.outcome.detail ?? "");
    if (!after(alertKey(patternKey({ error_code: r.outcome.error_code, detail })), r.finished_at!)) continue;
    const key = `${r.outcome.error_code}\n${detail}`;
    const g = groups.get(key) ?? { code: r.outcome.error_code, detail, runs: [], items: new Set<WorkItemId>() };
    g.runs.push(r);
    g.items.add(r.work_item_id);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.items.size >= threshold)
    .sort(([a], [b]) => cmp(a, b))
    .map(([, g]) => {
      const key = patternKey({ error_code: g.code, detail: g.detail });
      const finding = { pattern: "repeated_error" as const, pattern_key: alertKey(key), error_code: g.code, count: g.runs.length };
      if (g.code === AGENT_STALLED) return { ...finding, detail: `${g.detail}; ${stallRate(newestFirst, windowMinutes)}` };
      return { ...finding, detail: g.detail, held: { pattern_key: key, runs: g.runs } };
    });
}

/** The stall rate of the window's runs: every stall in it, of the agent runs finished in it. */
function stallRate(inWindow: readonly Run[], windowMinutes: number): string {
  const agent = inWindow.filter(isAgentRun);
  const stalls = agent.filter(isStall).length;
  return `stall rate: ${stalls} of ${agent.length} agent runs in the last ${windowMinutes} minutes stalled`;
}

// A screenshot review with no image starts no agent (design 04-screenshots): never part of a zero-token streak.
const noImage = (r: Run) => r.input?.screenshot_review === true && (r.input.screenshots?.captures.length ?? 0) === 0;
const isAgentRun = (r: Run) => AGENT_RUN_KINDS.includes(r.kind) && (r.status === "succeeded" || r.status === "failed") && !noImage(r);
const isStall = (r: Run) => r.outcome?.status === "failed" && r.outcome.error_code === AGENT_STALLED;
/** An interactive run the owner abandoned (design 05-alarms, 2026-11-23): the owner's choice, not a failure to act on. */
const abandoned = (r: Run) => r.kind === INTERACTIVE && r.outcome?.status === "failed" && r.outcome.error_code === SESSION_ABANDONED;

/**
 * The stall runs of `runs` that followed a recorded host sleep (`sleptRuns`, the improver's rule), which the repeated-error
 * check leaves out. Host sleeps are read only for a stall pattern with at least `threshold` runs, so a poll with no such
 * pattern reads none.
 */
async function sleptStalls(store: Pick<FactoryStore, "listHostSleeps">, runs: readonly Run[], threshold: number): Promise<Set<RunId>> {
  const slept = new Set<RunId>();
  const { groups, patterns } = groupFailures(runs);
  for (const g of [...groups, ...patterns]) {
    if (g.error_code !== AGENT_STALLED || g.run_ids.length < threshold) continue;
    for (const id of await sleptRuns(store, g)) slept.add(id);
  }
  return slept;
}

function zeroTokens(newestFirst: readonly Run[], threshold: number): AlarmFinding[] {
  const agent = newestFirst.filter(isAgentRun);
  let streak = 0;
  while (streak < agent.length && runTokenCount(agent[streak]!) === 0) streak++;
  if (streak < threshold) return [];
  const last = agent[0]!.outcome;
  // How the last run ended only: the alarm's sentence (alarmText in src/ui/alarms.ts) already says the streak. The
  // stored detail keeps the code; alarmFullText there reads this exact form and words the code for the owner.
  const detail = last?.status === "failed" ? `the last failed with ${last.error_code}` : "the last succeeded";
  return [{ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: streak, detail }];
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
    | "listHostSleeps" | "listAlertDismissals"
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
 * A new zero-token alert starts the model_stall pause, first probe after `probe_interval_ms`; a new repeated-error
 * alert holds the items it hit (`hold`), so the failing items wait for a person and auto mode goes on. Each recurring
 * pattern re-raises first (`reraise`), then each failed run of an open filed pattern holds its item (`holdFiled`), then
 * each pack grant refusal holds its item and alerts (`holdRefused`). The new alert, the re-raise and the filed-pattern
 * hold leave out stalls that followed a host sleep (`sleptStalls`) and abandoned interactive runs. Returns the alerts this call stored. Safe to run
 * twice and on several replicas at once: the store's conditional insert dedupes.
 */
export async function alarmStep(d: AlarmDeps, settings: AlarmSettings & { probe_interval_ms: number; spend?: SpendBudgets }): Promise<Alert[]> {
  const now = d.clock.now();
  const span = Math.max(settings.alarm_window_minutes * 60_000, RERAISE_WINDOW_MS);
  const runs = await d.store.listRunsFinishedWithin(span);
  const restarts = d.restarts ? await d.restarts() : [];
  // A dismissal older than every run read here (and every restart, RESTART_WINDOW_MS) leaves out none of them.
  const dismissed = await dismissalsSince(d.store, now.getTime() - span);
  const skip = await sleptStalls(d.store, runs, settings.alarm_repeat_count);
  const counted = runs.filter((r) => !skip.has(r.id) && !abandoned(r));
  // Before this step's own alerts, so a pattern's new 6-hour alert never hides the re-raise it is due.
  const stored = await reraise(d, counted, now, settings.alarm_repeat_count, dismissed);
  await holdFiled(d, counted, now);
  stored.push(...(await holdRefused(d, runs, now, dismissed)));
  for (const { held, ...f } of detectAlarms({ runs, restarts, now, settings, skip, dismissed })) {
    // G5: alerts reach the status page, so the detail is scanned as UI text, never stored unscanned.
    const scan = await d.scanner.scan("ui", f.detail);
    const r = await d.store.recordAlert({ ...f, detail: scan.clean ? f.detail : null }, ALERT_DEDUPE_MS);
    if (!r.created) continue;
    stored.push(r.alert);
    // The code and count only: the detail stays in the store, where the UI reads it.
    d.log.warn(`alarm: ${f.pattern}`, { alert_id: r.alert.id, error_code: f.error_code, count: f.count });
    // Only the replica whose insert created the alert holds; the hold is a conditional transition besides.
    if (held && d.hold) await d.hold({ pattern_key: held.pattern_key, work_item_ids: await unheld(d, held.runs, held.pattern_key, null) });
    if (f.pattern === "zero_tokens") {
      const pause = await d.store.pauseClaims(new Date(now.getTime() + settings.probe_interval_ms).toISOString() as Timestamp, MODEL_STALL);
      if (pause.started) d.log.warn(`agent runs use no tokens: all runs paused, first probe at ${pause.resume_at}`, { resume_at: pause.resume_at });
    }
  }
  if (settings.spend) stored.push(...(await spendStep(d, settings.spend)));
  return stored;
}

/** Each pattern key dismissed at or after `since` (ms), with its dismissal time in ms. */
async function dismissalsSince(store: Pick<FactoryStore, "listAlertDismissals">, since: number): Promise<Map<string, number>> {
  const rows = await store.listAlertDismissals(new Date(since).toISOString() as Timestamp);
  return new Map(rows.map((r) => [r.pattern_key, Date.parse(r.dismissed_at)]));
}

/** A dismissed alert pattern (design 05-alarms): when, and by whom as an ID, never a display name. */
export interface AlertDismissal {
  pattern_key: string;
  dismissed_at: Timestamp;
  dismissed_by: UserId;
}

/** The store's alarm dismissals (FactoryStore; the SQL store's alerts.ts). */
export interface AlertDismissalStore {
  /**
   * Dismisses the pattern of alert `alert_id` at the store clock's now, by `actor`. Conditional: a pattern already
   * dismissed since its last alert keeps that dismissal (`dismissed: false`). Lifts no hold. Null: no such alert.
   */
  dismissAlert(alert_id: string, actor: UserId): Promise<{ pattern_key: string; dismissed: boolean; dismissed_at: Timestamp } | null>;
  /** The patterns dismissed at or after `since`, newest first. Read-only. */
  listAlertDismissals(since: Timestamp): Promise<AlertDismissal[]>;
}

/**
 * Whether an alert the alarm step stored stops auto mode (design 03-risk): only a child crash loop, which is the
 * factory itself. A repeated error (any code) or a zero-token streak is about agent runs: it holds its items, or the
 * model_stall pause holds every claim, and auto mode goes on. A spend alert only alerts.
 */
export const stopsAuto = (a: Pick<Alert, "pattern">): boolean => a.pattern === "child_restarts";

/**
 * The spend budget check (design 06-spend): the known cost of the runs finished in the current UTC day and ISO
 * week (from Monday) against each budget set. Each threshold passed stores one `spend_budget` alert whose key
 * names the period, its start and the threshold (`spend:daily:2026-11-13:80`), so repeated steps, replicas and a
 * restarted controller store it once. Runs with no stored cost add nothing and are named in the detail. It only
 * alerts: no pause, hold or stop. Returns the alerts this call stored.
 */
export async function spendStep(d: Pick<AlarmDeps, "store" | "scanner" | "clock" | "log">, budgets: SpendBudgets): Promise<Alert[]> {
  const now = d.clock.now().getTime();
  const periods = [
    { name: "daily", budget: budgets.daily_usd, start: dayStart(now) },
    { name: "weekly", budget: budgets.weekly_usd, start: weekStart(now) },
  ].filter((p): p is { name: string; budget: number; start: number } => p.budget !== null);
  if (periods.length === 0) return [];
  const since = Math.min(...periods.map((p) => p.start));
  const runs = await d.store.listRunsFinishedBetween(new Date(since).toISOString() as Timestamp, new Date(now + 1).toISOString() as Timestamp);
  // A threshold dismissed in its period was seen: it does not alert again until the next period's key.
  const dismissed = await dismissalsSince(d.store, since);
  const stored: Alert[] = [];
  for (const p of periods) {
    const t = spendTotals(runs.filter((r) => Date.parse(r.finished_at!) >= p.start));
    for (const pct of SPEND_THRESHOLDS) {
      const pattern_key = `spend:${p.name}:${utcDay(p.start)}:${pct}`;
      if (t.cost_usd * 100 < p.budget * pct || dismissed.has(pattern_key)) continue;
      const unknown = t.unknown === 0 ? "" : `; ${t.unknown} run${t.unknown === 1 ? "" : "s"} with no stored cost not counted`;
      const detail = `${usd(t.cost_usd)} of the ${usd(p.budget)} ${p.name} budget spent (${p.name === "daily" ? "UTC day" : "week from"} ${utcDay(p.start)})${unknown}`;
      const scan = await d.scanner.scan("ui", detail);
      const r = await d.store.recordAlert(
        { pattern: "spend_budget", pattern_key, error_code: `${p.name}_${pct}`, count: t.runs, detail: scan.clean ? detail : null },
        SPEND_DEDUPE_MS,
      );
      if (!r.created) continue;
      stored.push(r.alert);
      d.log.warn(`alarm: spend passed ${pct}% of the ${p.name} budget`, { alert_id: r.alert.id });
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

/** Whether a failure pattern's runs hold their items: any pattern but a stall's (design 05-restarts, 2026-11-23). */
const holds = (g: Pick<FailureGroup, "error_code">): boolean => g.error_code !== AGENT_STALLED;

/**
 * Re-raises each recurring pattern: one that already alerted (its repeated-error alert) or was filed (its filed
 * pattern), and that failed `threshold` more runs within the last hour after its last re-raise (none yet: after it
 * was first known, the earlier of its alert and its filing). The re-raise is an alert (pattern `repeated_error`, key
 * `recurring:<key>`) the store dedupes for RERAISE_WINDOW_MS, so of several replicas or steps exactly one stores it,
 * at most once an hour. That one holds the pattern's items (each not held for it since its run, `unheld`; a stall
 * pattern holds none) and comments the count since filing on its filed item. A dismissal of the re-raise or of the
 * pattern's alert moves the count's start to it. Returns the re-raises it stored.
 */
async function reraise(d: AlarmDeps, runs: readonly Run[], now: Date, threshold: number, dismissed: ReadonlyMap<string, number>): Promise<Alert[]> {
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
    const from = Math.max(newest.get(reraiseKey(key)) ?? known.at, dismissed.get(reraiseKey(key)) ?? -Infinity, dismissed.get(alertKey(key)) ?? -Infinity);
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
    if (d.hold && holds(g)) await d.hold({ pattern_key: key, work_item_ids: await unheld(d, runsOf(g, byRun), key, null) });
    if (filed?.filed_ref && d.comment) await commentFiled(d, { ...filed, filed_ref: filed.filed_ref }, now, fresh, r.alert.id);
  }
  return stored;
}

/**
 * Holds the item of each failed run of the last RERAISE_WINDOW_MS whose pattern has an open filed item and that
 * finished after the filing: from its first matching run, not after `alarm_repeat_count` of them. Open: in the store
 * and not closed, or not in the store yet and filed less than FILED_INTAKE_MS ago. The hold itself is a conditional
 * transition of an item nothing else blocks, so a second step writes nothing. A stall pattern holds nothing.
 */
async function holdFiled(d: AlarmDeps, runs: readonly Run[], now: Date): Promise<void> {
  if (!d.hold) return;
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const g of recentPatterns(runs, now).filter(holds)) {
    const key = patternKey(g);
    const filed = await d.store.getFiledPattern(d.project, key);
    if (!filed?.filed_ref) continue;
    const fix = await d.store.getWorkItemBySource(filed.filed_ref.type, filed.filed_ref.id);
    if (fix ? fix.stage === "CLOSED" : now.getTime() - Date.parse(filed.created_at) >= FILED_INTAKE_MS) continue;
    const items = await unheld(d, runsOf(g, byId), key, filed.created_at);
    if (items.length > 0) await d.hold({ pattern_key: key, work_item_ids: items });
  }
}

/**
 * Each pack grant refusal of the last RERAISE_WINDOW_MS (a failed run with PACK_TOOL_REFUSED, of any kind) holds its
 * item for a person at its first run, and its pattern (the improver's key of the code and normalized detail) stores one `repeated_error` alert, key `grant_refused:<key>`, at most once per
 * RERAISE_WINDOW_MS. The detail is the newest run's, which names the refused grant. The hold is the recurring one
 * (`unheld`, then a conditional transition), so `/retry` lifts it and a second step writes nothing. A dismissed alert
 * counts only the runs after its dismissal; the holds do not change. Returns the alerts it stored.
 */
async function holdRefused(d: AlarmDeps, runs: readonly Run[], now: Date, dismissed: ReadonlyMap<string, number>): Promise<Alert[]> {
  const since = now.getTime() - RERAISE_WINDOW_MS;
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const o = r.outcome;
    if (r.status !== "failed" || o?.status !== "failed" || o.error_code !== PACK_TOOL_REFUSED) continue;
    if (r.finished_at === null || Date.parse(r.finished_at) < since) continue;
    const key = patternKey({ error_code: o.error_code, detail: normalizeDetail(o.detail) });
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const stored: Alert[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (d.hold) {
      const items = await unheld(d, group, key, null);
      if (items.length > 0) await d.hold({ pattern_key: key, work_item_ids: items });
    }
    const pattern_key = `${GRANT_REFUSED_PREFIX}${key}`;
    const fresh = group.filter((r) => afterDismissal(dismissed)(pattern_key, r.finished_at!));
    if (fresh.length === 0) continue;
    const newest = [...fresh].sort((a, b) => cmp(b.finished_at!, a.finished_at!))[0]!.outcome as Extract<RunOutcome, { status: "failed" }>;
    const scan = await d.scanner.scan("ui", newest.detail);
    const r = await d.store.recordAlert(
      { pattern: "repeated_error", pattern_key, error_code: newest.error_code, count: fresh.length, detail: scan.clean ? newest.detail : null },
      RERAISE_WINDOW_MS,
    );
    if (!r.created) continue;
    stored.push(r.alert);
    d.log.warn("alarm: a run was refused by the pack grant check", { alert_id: r.alert.id, error_code: newest.error_code, count: fresh.length });
  }
  return stored;
}

/** `g`'s runs, read from `byId`. */
const runsOf = (g: FailureGroup, byId: ReadonlyMap<string, Run>): Run[] => g.run_ids.map((id) => byId.get(id)!);

/**
 * The items of `runs` that finished after `after` (null: any) and that no hold of `key` took after the run
 * finished, so a hold a person lifted (`/retry`) or the release cleared is not put back by the same run.
 */
async function unheld(d: Pick<AlarmDeps, "store">, runs: readonly Run[], key: string, after: Timestamp | null): Promise<WorkItemId[]> {
  const items = new Set<WorkItemId>();
  for (const r of runs) {
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
    holds(filed) ? "The work items it hit are held (`recurring_failure`) until this fix merges; then they are retried." : "The work items it hit are retried with backoff; none is held for it.",
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

/** The coordinator's daily limit as a cycle met it (design 06-spend): the UTC day, the limit and the day's known spend. */
export interface CoordinatorLimit {
  day: string;
  limit_usd: number;
  spent_usd: number;
  /** The day's coordinator cycles with no reported cost, not counted in `spent_usd`. */
  unknown: number;
}

/** The limit the question proposes: twice the current one. */
export const proposedLimit = (limit_usd: number): number => limit_usd * 2;
/** The day's coordinator cycles with no reported cost, as a clause after the spend ("" when there are none). */
export const uncountedCycles = (n: number): string => (n === 0 ? "" : `; ${n} cycle${n === 1 ? "" : "s"} with no reported cost not counted`);
/** A whole-dollar amount as the owner types it in `approve <usd>` (10, not 10.00). */
const typed = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The coordinator limit question as the cycle hands it to the unit: the alert (its text in `detail`) and its dedupe window. */
export interface CoordinatorLimitAlert {
  alert: NewAlert & { detail: string };
  dedupe_ms: number;
}

/**
 * The coordinator limit's owner question (design 06-spend), built here; the coordinator unit scans `detail` as UI text
 * and stores it through the kernel's `alert` write. One Needs-you alert, pattern `coordinator_limit`, key
 * `coordinator_limit:<UTC day>`, with the current and the proposed limit, deduped for one day on a key that names the
 * day; the cycle raises it only on the day's first stop, so there is one per UTC day, answered or not. The answer is
 * coordinatorLimitAnswer (src/core/spend.ts), applied by the commands unit (answerLimit).
 */
export function coordinatorLimitAlert(q: CoordinatorLimit): CoordinatorLimitAlert {
  const proposed = proposedLimit(q.limit_usd);
  const detail = `The coordinator reached its daily limit: ${usd(q.spent_usd)} spent on UTC day ${q.day}${uncountedCycles(q.unknown)}. Current limit ${usd(q.limit_usd)}, proposed limit ${usd(proposed)}. `
    + `Answer approve ${typed(proposed)} to set ${COORDINATOR_LIMIT_KEY} and resume cycles, or reject to keep cycles stopped until the UTC day ends.`;
  return { alert: { pattern: "coordinator_limit", pattern_key: coordinatorLimitKey(q.day), error_code: "daily_limit", count: q.unknown, detail }, dedupe_ms: DAY_MS };
}
