// Failure groups (design §7): the improve run's and the alarm step's grouping of failed runs by error code and
// normalized detail, and of the owner's pushbacks by their normalized words (issue #571).

import type { FactoryStore } from "../interfaces/factory-store.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FailureGroup, ImproveWindow, Run, RunId, Timestamp, WorkItemId } from "./types.js";

/** Characters of a normalized detail kept as a group's key. */
const DETAIL_CHARS = 200;

/** A failed run an improve report counts: the same runs groupFailures groups. */
export function reviewable(r: Run): boolean {
  return r.kind !== "improve" && r.status === "failed" && r.outcome?.status === "failed";
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

/** A pushback group's error code: the owner pushed back on a run's output with these words (issue #571). */
export const PUSHBACK = "pushback";
/** The state changes whose `spec_feedback` is a pushback: a `/reject` and a `/revise`. */
const PUSHBACK_REASONS: readonly string[] = ["spec_rejected", "spec_revision_requested"];

/** One pushback as the improver counts it: the owner's words on the run whose output they answered. */
export interface Pushback {
  run_id: RunId;
  work_item_id: WorkItemId;
  text: string;
  at: Timestamp;
}

/**
 * Groups failed runs by error code and normalized detail, and pushbacks by their normalized words under the code
 * `pushback` (each pushback counts its run once). Pure and deterministic: runs are taken in (finished_at, id) order,
 * then pushbacks in (at, run id) order; groups of two or more come first by size (largest first), then by key; one-run
 * patterns by key. Runs that did not fail, and improve runs themselves, are left out.
 */
export function groupFailures(runs: readonly Run[], pushbacks: readonly Pushback[] = []): { groups: FailureGroup[]; patterns: FailureGroup[] } {
  const failed = runs
    .filter(reviewable)
    .sort((a, b) => cmp(a.finished_at ?? "", b.finished_at ?? "") || cmp(a.id, b.id));
  const byKey = new Map<string, FailureGroup>();
  const add = (error_code: string, raw: string, run_id: RunId, work_item_id: WorkItemId) => {
    const detail = normalizeDetail(raw);
    const key = `${error_code}\n${detail}`;
    const g = byKey.get(key) ?? { error_code, detail, run_ids: [] as RunId[], work_item_ids: [] as WorkItemId[] };
    g.run_ids.push(run_id);
    if (!g.work_item_ids.includes(work_item_id)) g.work_item_ids.push(work_item_id);
    byKey.set(key, g);
  };
  for (const r of failed) {
    const outcome = r.outcome as Extract<Run["outcome"], { status: "failed" }>;
    add(outcome.error_code, outcome.detail ?? "", r.id, r.work_item_id);
  }
  for (const p of [...pushbacks].sort((a, b) => cmp(a.at, b.at) || cmp(a.run_id, b.run_id))) add(PUSHBACK, p.text, p.run_id, p.work_item_id);
  const all = [...byKey.values()].sort((a, b) => b.run_ids.length - a.run_ids.length || cmp(a.error_code, b.error_code) || cmp(a.detail, b.detail));
  return { groups: all.filter((g) => g.run_ids.length > 1), patterns: all.filter((g) => g.run_ids.length === 1) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What reading pushbacks needs: three store reads and the G5 scanner. */
export interface PushbackDeps {
  store: Pick<FactoryStore, "listStateChangesSince" | "listVerdictsSince" | "getWorkItem" | "listRuns">;
  scanner: EgressScanner;
}

/**
 * The project's pushbacks made inside `window` (issue #571): each `/reject` and `/revise` with words (their state
 * change's `spec_feedback`) and each explicit `changes` verdict with a reason, on the item's latest run that succeeded
 * before it (the output pushed back on; none: not counted). Each text passes the G5 scan (`log`) first: a flagged one
 * is not counted. Two reads across items, then one run list per item with a pushback.
 */
export async function pushbacksIn(d: PushbackDeps, window: ImproveWindow, project: string): Promise<Pushback[]> {
  const inWindow = (at: Timestamp) => at >= window.window_start && at < window.window_end;
  const said: { work_item_id: WorkItemId; text: string; at: Timestamp }[] = [];
  for (const c of await d.store.listStateChangesSince({ reasons: PUSHBACK_REASONS, since: window.window_start })) {
    const text = c.changes.spec_feedback?.to;
    if (inWindow(c.at) && typeof text === "string" && text.trim() !== "") said.push({ work_item_id: c.work_item_id, text, at: c.at });
  }
  for (const v of await d.store.listVerdictsSince(window.window_start)) {
    if (inWindow(v.at) && v.verdict === "changes" && !v.implicit && v.reason?.trim()) said.push({ work_item_id: v.work_item_id, text: v.reason, at: v.at });
  }
  const runsOf = new Map<WorkItemId, Run[] | null>();
  const out: Pushback[] = [];
  for (const s of said) {
    if (!runsOf.has(s.work_item_id)) {
      const it = await d.store.getWorkItem(s.work_item_id);
      runsOf.set(s.work_item_id, it?.project === project ? await d.store.listRuns(s.work_item_id) : null);
    }
    const run = runsOf.get(s.work_item_id)?.filter((r) => r.status === "succeeded" && r.finished_at !== null && r.finished_at <= s.at).at(-1);
    if (!run || !(await d.scanner.scan("log", s.text)).clean) continue;
    out.push({ run_id: run.id, work_item_id: s.work_item_id, text: s.text, at: s.at });
  }
  return out;
}
