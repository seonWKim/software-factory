// The improve run (design §7, issue #306): once a day, and on `factory improve`, the failed runs of a window are
// grouped by error code and normalized detail and stored as one report. No model call, no agent, nothing filed:
// the report is a store row, read by people and by later phases.

import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore, FailureGroup, NewImproveReport } from "../interfaces/factory-store.js";
import type { Actor, ImproveWindow, Run, RunId, SourceRef, Timestamp, UserId, WorkItem, WorkItemId } from "./types.js";

export const IMPROVE = "improve" as const;
/** The improver's actor and requester: an ID, never a display name. */
export const IMPROVER_ID = "system:improver";
export const IMPROVER: Actor = { kind: "system", id: IMPROVER_ID };
export const DAY_MS = 86_400_000;
/** A normalized detail is cut to this many characters, so one long message cannot split a group. */
export const DETAIL_CHARS = 200;

/** The project's system item: one per project, the work item every improve run of the project belongs to. */
export function systemSource(project: string): SourceRef {
  return { type: "system", id: `improve:${project}`, link: "" };
}

/** Finds or creates the project's system item. Idempotent on its source, so any replica may call it. */
export async function systemItem(store: FactoryStore, project: string): Promise<WorkItem> {
  const { item } = await store.createWorkItem(
    {
      source: systemSource(project),
      title: "factory improve runs",
      requester_id: IMPROVER_ID as UserId,
      project,
      problem: "The factory's own item: it carries the daily and manual improve runs (design §7). Nothing to do.",
      resources: [],
    },
    IMPROVER,
  );
  return item;
}

/** `YYYY-MM-DD` of the UTC calendar day of `at`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The daily run's key: one per project and UTC day, so a second enqueue on the same day is a no-op. */
export function dailyImproveKey(project: string, day: string): string {
  return `improve:${project}:daily:${day}`;
}

/** A manual run's key: its own nonce, so it never takes the day's slot and each `factory improve` queues one. */
export function manualImproveKey(project: string, nonce: string): string {
  return `improve:${project}:manual:${nonce}`;
}

/** The daily run of UTC day `day` reports the day before it: [day − 1 00:00Z, day 00:00Z). */
export function dailyWindow(day: string): ImproveWindow {
  const end = new Date(`${day}T00:00:00.000Z`);
  return { start: new Date(end.getTime() - DAY_MS).toISOString() as Timestamp, end: end.toISOString() as Timestamp };
}

/** Queues the improve run of the current UTC day for `project`. Safe to call on every tick and on any replica. */
export async function enqueueDailyImprove(store: FactoryStore, clock: Clock, project: string): Promise<{ run: Run; created: boolean }> {
  const day = utcDay(clock.now());
  const item = await systemItem(store, project);
  return store.enqueueRun({
    work_item_id: item.id,
    kind: IMPROVE,
    idempotency_key: dailyImproveKey(project, day),
    input: { improve: dailyWindow(day) },
  });
}

/**
 * `factory improve`: queues one improve run now, over the last 24 hours. The caller passes a fresh nonce (the core
 * makes no random values); the same nonce twice queues one run. Not gated by the daily run.
 */
export async function enqueueManualImprove(
  store: FactoryStore,
  clock: Clock,
  project: string,
  nonce: string,
): Promise<{ run: Run; created: boolean }> {
  const now = clock.now();
  const item = await systemItem(store, project);
  const window: ImproveWindow = {
    start: new Date(now.getTime() - DAY_MS).toISOString() as Timestamp,
    end: now.toISOString() as Timestamp,
  };
  return store.enqueueRun({ work_item_id: item.id, kind: IMPROVE, idempotency_key: manualImproveKey(project, nonce), input: { improve: window } });
}

/**
 * The detail with what differs between runs of one failure taken out: timestamps, UUIDs, hex ids and shas, and
 * numbers become placeholders; case and whitespace are folded; the result is cut to DETAIL_CHARS.
 */
export function normalizeDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, "<time>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/(?<![0-9a-z])(?=[0-9a-f]*\d)[0-9a-f]{7,}(?![0-9a-z])/g, "<id>")
    .replace(/(?<![a-z<])\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_CHARS);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The report body of `runs` over `window`: every failed run that finished inside the window, grouped by error code
 * and normalized detail. Groups of two or more runs are `groups` (largest first), the rest `singles`; ties and the
 * IDs inside a group are sorted, so the same runs in any order give the same report.
 */
export function groupFailures(
  runs: readonly Run[],
  window: ImproveWindow,
): Pick<NewImproveReport, "window_start" | "window_end" | "groups" | "singles"> {
  const byKey = new Map<string, { error_code: string; detail: string; runs: Set<RunId>; items: Set<WorkItemId> }>();
  for (const r of runs) {
    if (r.status !== "failed" || r.outcome?.status !== "failed") continue;
    if (r.finished_at === null || r.finished_at < window.start || r.finished_at >= window.end) continue;
    const error_code = r.outcome.error_code;
    const detail = normalizeDetail(r.outcome.detail);
    const key = `${error_code}\n${detail}`;
    const g = byKey.get(key) ?? { error_code, detail, runs: new Set(), items: new Set() };
    g.runs.add(r.id);
    g.items.add(r.work_item_id);
    byKey.set(key, g);
  }
  const all: FailureGroup[] = [...byKey.values()].map((g) => ({
    error_code: g.error_code,
    detail: g.detail,
    run_ids: [...g.runs].sort(cmp),
    work_item_ids: [...g.items].sort(cmp),
  }));
  const order = (a: FailureGroup, b: FailureGroup) =>
    b.run_ids.length - a.run_ids.length || cmp(a.error_code, b.error_code) || cmp(a.detail, b.detail);
  return {
    window_start: window.start,
    window_end: window.end,
    groups: all.filter((g) => g.run_ids.length > 1).sort(order),
    singles: all.filter((g) => g.run_ids.length === 1).sort(order),
  };
}

/**
 * What a worker does for a claimed improve run: reads the runs of the project that finished in the run's window,
 * groups the failed ones and stores the report, once per run (a rerun after a lost lease stores nothing new).
 * Calls no model and writes no filed pattern. Returns the counts for the run's outcome.
 */
export async function runImprove(
  store: FactoryStore,
  run: Run,
  item: WorkItem,
): Promise<{ groups: number; singles: number; created: boolean }> {
  const window = run.input?.improve;
  if (!window) throw new Error("improve run has no window");
  const runs = await store.listRunsFinishedBetween(item.project, window.start, window.end);
  const body = groupFailures(runs, window);
  const { report, created } = await store.recordImproveReport({ run_id: run.id, project: item.project, ...body });
  return { groups: report.groups.length, singles: report.singles.length, created };
}
