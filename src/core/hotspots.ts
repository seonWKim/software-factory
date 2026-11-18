// Conflict hotspots (design 07-self-improvement): the improve run's per-file count of the merge_conflict and resolve
// runs whose outcome names the file in `conflicts`, and of the items a coordination hold kept back on it, over the
// last 7 days. A file at or over `conflict_hotspot_threshold` is one `hotspot` row in the report's patterns; the
// controller files one task per hot file through the filed-pattern claim (fileReport in src/core/improver.ts).
// With a MergeGit reader, a file's runs and holds from before the last merge that halved it are dropped, and a file
// gone from the base branch head is not listed.

import type { FactoryStore } from "../interfaces/factory-store.js";
import type { MergeEvaluation } from "./merge-evaluation.js";
import type { ClaimDecision, FailureGroup, ImproveWindow, Run, RunId, Timestamp, WorkItemId } from "./types.js";

/** A hot-file row's error code; its detail is the file path, so the pattern key is `hotspot` plus the path. */
export const HOTSPOT = "hotspot";
/** Default `conflict_hotspot_threshold`: conflict runs plus held items on one file in the window. */
export const DEFAULT_HOTSPOT_THRESHOLD = 3;
/** How far back the count looks from the improve run's window end. */
export const HOTSPOT_WINDOW_MS = 7 * 86_400_000;
/** The claim decisions that kept an item's run back for a holder's shared files (design 05-dependencies). */
const HELD: readonly ClaimDecision["decision"][] = ["held", "approved", "timed_out"];

/**
 * What the count reads from git (design 07-self-improvement); the worker's implementation runs git in the factory
 * repo, src/core never does. Each call throws on a git failure, which fails the improve run.
 */
export interface MergeGit {
  /** Per file the merge `sha` changed against its first parent: the lines it deleted and the file's lines at that parent. */
  removals(sha: string): Promise<ReadonlyMap<string, { deleted: number; lines: number }>>;
  /** Whether `path` is a file at the base branch head (`refs/heads/<base_branch>`). */
  existsAtHead(path: string): Promise<boolean>;
}

/** A merge halves a file when it deletes at least half of the file's lines (a split or move). */
const halves = (r: { deleted: number; lines: number }): boolean => r.lines > 0 && 2 * r.deleted >= r.lines;

/** Where the count starts: HOTSPOT_WINDOW_MS before the improve window's end. */
export function hotspotSince(window: Pick<ImproveWindow, "window_end">): Timestamp {
  return new Date(Date.parse(window.window_end) - HOTSPOT_WINDOW_MS).toISOString() as Timestamp;
}

/** Whether `g` is a hot-file row. */
export const isHotspot = (g: Pick<FailureGroup, "error_code">): boolean => g.error_code === HOTSPOT;

/**
 * The files a run names in its outcome's `conflicts`: a failed `merge_conflict` run, or a resolve run (failed, or
 * succeeded with `data.conflicts`). Only that field counts: no detail text is parsed, so older runs name none.
 */
export function conflictFiles(r: Run): string[] {
  const o = r.outcome;
  if (!o) return [];
  const named = o.status === "succeeded" ? (r.kind === "resolve" ? o.data.conflicts : undefined)
    : r.kind === "resolve" || o.error_code === "merge_conflict" ? o.conflicts : undefined;
  return Array.isArray(named) ? [...new Set(named.filter((f): f is string => typeof f === "string" && f.trim() !== ""))] : [];
}

/**
 * The hot files: per file, the runs among `runs` that name it (`conflictFiles`) and the items `decisions` held back
 * on it (each item once per file), as `hotspot` rows whose run plus held-item count reaches `threshold`. Runs in
 * (finished_at, id) order; rows by count (largest first), then path. `work_item_ids`: the runs' items, then the held ones.
 * `cuts`: per file, the time of the last merge that halved it; a run finished or a decision written before it is not
 * counted for that file. `counted_at`: each counted run's finish time and each held item's first counted decision time.
 */
export function hotspotGroups(
  runs: readonly Run[], decisions: readonly ClaimDecision[], threshold: number, cuts: ReadonlyMap<string, Timestamp> = new Map(),
): FailureGroup[] {
  const byPath = new Map<string, FailureGroup & { held_item_ids: WorkItemId[]; counted_at: Record<string, Timestamp> }>();
  const row = (path: string) => {
    const g = byPath.get(path) ?? {
      error_code: HOTSPOT, detail: path, run_ids: [] as RunId[], work_item_ids: [] as WorkItemId[], held_item_ids: [] as WorkItemId[], counted_at: {},
    };
    byPath.set(path, g);
    return g;
  };
  const before = (path: string, at: string) => {
    const cut = cuts.get(path);
    return cut !== undefined && at < cut;
  };
  const sorted = [...runs].sort((a, b) => cmp(a.finished_at ?? "", b.finished_at ?? "") || cmp(a.id, b.id));
  for (const r of sorted) {
    for (const path of conflictFiles(r)) {
      if (before(path, r.finished_at ?? "")) continue;
      const g = row(path);
      g.run_ids.push(r.id);
      if (r.finished_at) g.counted_at[r.id] = r.finished_at;
      if (!g.work_item_ids.includes(r.work_item_id)) g.work_item_ids.push(r.work_item_id);
    }
  }
  for (const d of decisions) {
    if (!HELD.includes(d.decision)) continue;
    for (const path of new Set(d.shared.map((s) => s.path))) {
      if (before(path, d.at ?? "")) continue;
      const g = row(path);
      if (g.held_item_ids.includes(d.work_item_id)) continue;
      g.held_item_ids.push(d.work_item_id);
      if (d.at) g.counted_at[d.work_item_id] = d.at;
      if (!g.work_item_ids.includes(d.work_item_id)) g.work_item_ids.push(d.work_item_id);
    }
  }
  const count = (g: FailureGroup) => g.run_ids.length + (g.held_item_ids?.length ?? 0);
  return [...byPath.values()].filter((g) => count(g) >= threshold).sort((a, b) => count(b) - count(a) || cmp(a.detail, b.detail));
}

/** The rows of `project`'s work items (runs, claim decisions), in order: one item read per work item (design §7, reports are per project). */
export async function ofProject<T extends { work_item_id: WorkItemId }>(store: Pick<FactoryStore, "getWorkItem">, rows: readonly T[], project: string): Promise<T[]> {
  const projects = new Map<WorkItemId, string | null>();
  for (const r of rows) if (!projects.has(r.work_item_id)) projects.set(r.work_item_id, (await store.getWorkItem(r.work_item_id))?.project ?? null);
  return rows.filter((r) => projects.get(r.work_item_id) === project);
}

/**
 * Per file, the time of the last of `merges` (oldest first) that halved it, read from `git`. One git read per merge.
 */
export async function halvingCuts(git: MergeGit, merges: readonly Pick<MergeEvaluation, "merge_sha" | "merged_at">[]): Promise<Map<string, Timestamp>> {
  const cuts = new Map<string, Timestamp>();
  for (const m of merges) {
    for (const [path, r] of await git.removals(m.merge_sha)) if (halves(r)) cuts.set(path, m.merged_at);
  }
  return cuts;
}

/**
 * The project's hot files for the improve run over `window`: its runs finished and its claim decisions written from
 * hotspotSince to the window's end, counted by hotspotGroups against `threshold` (absent: DEFAULT_HOTSPOT_THRESHOLD).
 * With `git`: cut at the project's last merge in that span that halved each file, and only files at the base head.
 */
export async function hotspotsIn(
  store: Pick<FactoryStore, "listRunsFinishedBetween" | "listClaimDecisionsSince" | "getWorkItem" | "listMergeEvaluations">,
  window: ImproveWindow, project: string, threshold?: number, git?: MergeGit,
): Promise<FailureGroup[]> {
  const since = hotspotSince(window);
  const runs = await ofProject(store, await store.listRunsFinishedBetween(since, window.window_end), project);
  const decisions = await ofProject(store, (await store.listClaimDecisionsSince(since)).filter((c) => c.at < window.window_end), project);
  if (!git) return hotspotGroups(runs, decisions, threshold ?? DEFAULT_HOTSPOT_THRESHOLD);
  const merges = (await store.listMergeEvaluations(since)).filter((m) => m.project === project && m.merged_at < window.window_end);
  const groups = hotspotGroups(runs, decisions, threshold ?? DEFAULT_HOTSPOT_THRESHOLD, await halvingCuts(git, merges));
  const kept: FailureGroup[] = [];
  for (const g of groups) if (await git.existsAtHead(g.detail)) kept.push(g);
  return kept;
}

/** A hot file's task text: the file, its conflict runs, its held items and every item named. Never raw detail. */
export function hotspotBody(g: FailureGroup): string {
  const held = g.held_item_ids ?? [];
  const lines = [
    `The factory's improve run counted ${g.run_ids.length} conflict runs and ${held.length} held items on one file in the last 7 days.`,
    "",
    `- File: \`${g.detail}\``,
    `- Conflict runs (merge_conflict or resolve): ${g.run_ids.length}`,
    `- Items held back by another item's change to this file: ${held.length}`,
  ];
  const dated = (id: string) => `- \`${id}\`${g.counted_at?.[id] ? ` (${g.counted_at[id]})` : ""}`;
  if (g.run_ids.length > 0) lines.push("", "Conflict runs (finished):", ...g.run_ids.map(dated));
  if (held.length > 0) lines.push("", "Held items (held at):", ...held.map(dated));
  lines.push(
    "", "Work items:", ...g.work_item_ids.map((id) => `- \`${id}\``),
    "",
    "Filed as a fix: split or restructure the file so parallel work items stop conflicting on it. A change that touches the factory's prompts or gates still waits for a person's merge.",
  );
  return lines.join("\n");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
