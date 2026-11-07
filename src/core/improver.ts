// The improve run (design §7, issue #306): a daily look back at failed runs. No agent, no model: the failed runs
// of a window are grouped by error code and normalized detail, and one report is stored. Nothing is filed.

import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Clock } from "../interfaces/clock.js";
import type { Actor, FailureGroup, ImproveReport, ImproveWindow, Run, RunId, SourceRef, Timestamp, UserId, WorkItem, WorkItemId } from "./types.js";

/** Who queues improve runs and owns the system work items. */
export const IMPROVER: Actor = { kind: "system", id: "system:improver" };
/**
 * The system work item's hold (design §7): `NEW`, `blocked_on: upstream` with this reason, for good. It only
 * carries its project's improve runs, so nothing triages, implements or releases it.
 */
export const SYSTEM_ITEM = "system_item";
/** Characters of a normalized detail kept as a group's key. */
const DETAIL_CHARS = 200;
const DAY_MS = 86_400_000;

type ImproveStore = Pick<FactoryStore, "createWorkItem" | "enqueueRun">;

/** The one system work item of `project`: a local source, unique per project, so intake never makes a second. */
export function systemSource(project: string): SourceRef {
  return { type: "local", id: `system:improve:${project}`, link: "" };
}

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The daily run's key: one per project and UTC day, so a second tick that day queues nothing. */
export function dailyImproveKey(project: string, day: string): string {
  return `improve:${project}:daily:${day}`;
}

/** A manual run's key (`factory improve`): its own time, never a day's slot. */
export function manualImproveKey(project: string, at: Date): string {
  return `improve:${project}:manual:${at.toISOString()}`;
}

/** The daily run of `day` reports the day before it, the last full UTC day: [day - 1 00:00, day 00:00). */
export function dailyWindow(day: string): ImproveWindow {
  const end = Date.parse(`${day}T00:00:00.000Z`);
  return { window_start: new Date(end - DAY_MS).toISOString() as Timestamp, window_end: new Date(end).toISOString() as Timestamp };
}

/** A manual run reports the 24 hours before it was queued. */
export function manualWindow(at: Date): ImproveWindow {
  return { window_start: new Date(at.getTime() - DAY_MS).toISOString() as Timestamp, window_end: at.toISOString() as Timestamp };
}

/**
 * Queues one improve run on the project's system work item (made on first use). `daily`: the current UTC day's
 * slot, a no-op when it is already queued. `manual`: a run of its own. The window goes into the run's input.
 */
export async function enqueueImprove(
  d: { store: ImproveStore; clock: Clock },
  project: string,
  trigger: "daily" | "manual",
): Promise<{ run: Run; created: boolean }> {
  const now = d.clock.now();
  const { item } = await d.store.createWorkItem(
    {
      source: systemSource(project),
      title: "Factory improve runs",
      requester_id: IMPROVER.id as UserId,
      project,
      problem: "The system work item that carries this project's improve runs (design §7). Nothing implements it.",
      resources: [],
      hold: { blocked_on: "upstream", blocked_reason: SYSTEM_ITEM },
    },
    IMPROVER,
  );
  const daily = trigger === "daily";
  return d.store.enqueueRun({
    work_item_id: item.id,
    kind: "improve",
    idempotency_key: daily ? dailyImproveKey(project, utcDay(now)) : manualImproveKey(project, now),
    input: { improve: daily ? dailyWindow(utcDay(now)) : manualWindow(now) },
  });
}

/**
 * A failure detail as a group key: lower case, every run of digits as `#` (counts, line numbers, ports, times,
 * shas' digit runs), hex ids of 7 or more characters as `<id>`, whitespace collapsed, cut to 200 characters.
 */
export function normalizeDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_CHARS);
}

/**
 * Groups failed runs by error code and normalized detail. Pure and deterministic: runs are taken in
 * (finished_at, id) order; groups of two or more runs come first by size (largest first), then by key; one-run
 * patterns by key. Runs that did not fail, and improve runs themselves, are left out.
 */
export function groupFailures(runs: readonly Run[]): { groups: FailureGroup[]; patterns: FailureGroup[] } {
  const failed = runs
    .filter((r) => r.kind !== "improve" && r.status === "failed" && r.outcome?.status === "failed")
    .sort((a, b) => cmp(a.finished_at ?? "", b.finished_at ?? "") || cmp(a.id, b.id));
  const byKey = new Map<string, FailureGroup>();
  for (const r of failed) {
    const outcome = r.outcome as Extract<Run["outcome"], { status: "failed" }>;
    const detail = normalizeDetail(outcome.detail ?? "");
    const key = `${outcome.error_code}\n${detail}`;
    const g = byKey.get(key) ?? { error_code: outcome.error_code, detail, run_ids: [] as RunId[], work_item_ids: [] as WorkItemId[] };
    g.run_ids.push(r.id);
    if (!g.work_item_ids.includes(r.work_item_id)) g.work_item_ids.push(r.work_item_id);
    byKey.set(key, g);
  }
  const all = [...byKey.values()].sort((a, b) => b.run_ids.length - a.run_ids.length || cmp(a.error_code, b.error_code) || cmp(a.detail, b.detail));
  return { groups: all.filter((g) => g.run_ids.length > 1), patterns: all.filter((g) => g.run_ids.length === 1) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The improve run's work: the failed runs finished inside its window, grouped, stored as its one report. A run
 * with no window in its input (none should have one) reports the 24 hours before it was queued. Safe to run
 * twice: the report is keyed by the run, so a retry keeps the first one.
 */
export async function runImprove(
  store: Pick<FactoryStore, "listRunsFinishedBetween" | "recordImproveReport">,
  run: Run,
  item: Pick<WorkItem, "project">,
): Promise<ImproveReport> {
  const window = run.input?.improve ?? manualWindow(new Date(run.created_at));
  const { groups, patterns } = groupFailures(await store.listRunsFinishedBetween(window.window_start, window.window_end));
  const { report } = await store.recordImproveReport({ run_id: run.id, project: item.project, ...window, groups, patterns });
  return report;
}
