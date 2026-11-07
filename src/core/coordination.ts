import { isCovered } from "./policy.js";
import type { DependencyKind, DependencyState, SharedPath, SourceRef } from "./types.js";

/**
 * Coordination (design §5, decided 2026-11-03): when an implement run may start next to other work. Pure: no
 * I/O, no clock. The store's claim, the controller and the tests all use these functions.
 *
 * - The cost of running item A next to item B is the sum of the weights of the paths both change. A run whose
 *   cost against any holder is at or above `max_cost` is held. Holders: items with an implement run in progress,
 *   items with an open PR, and other queued implement runs.
 * - Deadlock rule: a run held only by other queued runs (no running item, no open PR) is claimed when its turn
 *   comes, so the oldest of a group that holds each other goes first. A queued run never holds on its own: it
 *   cannot make progress before it is claimed, so only a running item or an open PR keeps a run queued.
 * - Dependencies: an item waits for every item it depends on to merge. A cycle is refused.
 */

/** Default `max_coordination_cost`: two ordinary shared files (2.0) run in parallel, a hotspot (3.0) does not. */
export const DEFAULT_MAX_COORDINATION_COST = 2.5;
/** The weight of any shared path. */
export const BASE_WEIGHT = 1.0;
/** Recorded conflicts from which a path weighs more than BASE_WEIGHT. */
export const LEARNED_FROM = 2;
/** Weight added per recorded conflict, from LEARNED_FROM on: 1.0 + 0.5 per conflict. */
export const LEARNED_STEP = 0.5;
/** A learned weight never goes above this. */
export const LEARNED_CAP = 4.0;
/** Default `hotspot_weight`. */
export const DEFAULT_HOTSPOT_WEIGHT = 3.0;
/** Default `hotspot_paths`: the files nearly every change touches, and that conflict when two do. */
export const DEFAULT_HOTSPOTS: readonly string[] = [
  "src/impl/store/sqlite/schema.ts",
  "src/impl/store/mysql/schema.ts",
  "src/core/controller.ts",
  "src/core/worker.ts",
  "docs/design.md",
  "SET_UP.md",
];

/**
 * Default `mechanical_paths` (design §5, issue #297): files two items usually change only by adding lines or new
 * files (the MySQL migration runner and its step folder, the design and plugin indexes and topic files). Their
 * conflicts are merged in code (src/core/mechanical.ts), so they weigh `mechanical_weight` and are never hotspots.
 */
export const DEFAULT_MECHANICAL: readonly string[] = [
  "src/impl/store/mysql/migrations.ts",
  "migrations/mysql/",
  "docs/design/",
  "docs/design.md",
  "docs/plugins.md",
  "docs/plugins/",
];
/** Default `mechanical_weight`: well below BASE_WEIGHT, so a few index and History lines never hold a run. */
export const DEFAULT_MECHANICAL_WEIGHT = 0.25;

export interface CoordinationSettings {
  /** `max_coordination_cost`: a cost at or above it holds the run. */
  max_cost: number;
  /** `hotspot_paths`: files (or folders ending in `/`) with the fixed weight below. */
  hotspots: readonly string[];
  /** `hotspot_weight`: the fixed weight of a hotspot. */
  hotspot_weight: number;
  /** `mechanical_paths`: files (or folders ending in `/`) weighed `mechanical_weight`, never hotspots. */
  mechanical: readonly string[];
  /** `mechanical_weight`: above 0, below 1.0. */
  mechanical_weight: number;
}

export const DEFAULT_COORDINATION: CoordinationSettings = {
  max_cost: DEFAULT_MAX_COORDINATION_COST,
  hotspots: DEFAULT_HOTSPOTS,
  hotspot_weight: DEFAULT_HOTSPOT_WEIGHT,
  mechanical: DEFAULT_MECHANICAL,
  mechanical_weight: DEFAULT_MECHANICAL_WEIGHT,
};

/** A file's weight from its recorded conflicts: 1.0 below two, then 1.0 + 0.5 per conflict, at most 4.0. */
export function learnedWeight(conflicts: number): number {
  if (conflicts < LEARNED_FROM) return BASE_WEIGHT;
  return Math.min(LEARNED_CAP, BASE_WEIGHT + LEARNED_STEP * conflicts);
}

/**
 * The paths two path lists share, by the same coverage rule as the scope gate (`isCovered`): equal paths, or a
 * path under a folder (ending in `/`) of the other list. The more specific of the two is the shared path.
 */
export function sharedPaths(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (x === y) out.add(x);
      else if (isCovered(y, [x])) out.add(y);
      else if (isCovered(x, [y])) out.add(x);
    }
  }
  return [...out].sort();
}

/** Whether `path` is a hotspot, or a folder holding one, or under a hotspot folder. */
function isHotspot(path: string, hotspots: readonly string[]): boolean {
  return hotspots.some((h) => h === path || isCovered(h, [path]) || isCovered(path, [h]));
}

/**
 * Whether `path` is a mechanical path: equal to one, or under a mechanical folder. A folder that only holds one
 * (e.g. `docs/`) is not: it covers other files too.
 */
export function isMechanical(path: string, mechanical: readonly string[]): boolean {
  return mechanical.some((m) => m === path || isCovered(path, [m]));
}

/** Recorded conflicts on `path`; for a folder, the most on any file under it. */
function conflictsOn(path: string, conflicts: ReadonlyMap<string, number>): number {
  if (!path.endsWith("/")) return conflicts.get(path) ?? 0;
  let most = 0;
  for (const [p, n] of conflicts) if (p.startsWith(path) && n > most) most = n;
  return most;
}

/**
 * One shared path's weight: the highest of BASE_WEIGHT, its learned weight and, for a hotspot, the hotspot weight.
 * A mechanical path is never a hotspot: it weighs `mechanical_weight`, or its learned weight when that is higher
 * (from LEARNED_FROM recorded conflicts, which only real resolve runs add).
 */
export function pathWeight(path: string, conflicts: ReadonlyMap<string, number>, s: CoordinationSettings): SharedPath {
  const n = conflictsOn(path, conflicts);
  if (isMechanical(path, s.mechanical)) {
    const weight = n >= LEARNED_FROM ? Math.max(s.mechanical_weight, learnedWeight(n)) : s.mechanical_weight;
    return { path, weight, conflicts: n, hotspot: false, mechanical: true };
  }
  const hotspot = isHotspot(path, s.hotspots);
  return { path, weight: Math.max(BASE_WEIGHT, learnedWeight(n), hotspot ? s.hotspot_weight : 0), conflicts: n, hotspot };
}

/** The cost of running two items side by side: the shared paths with their weights, and their sum. */
export function coordinationCost(
  a: readonly string[],
  b: readonly string[],
  conflicts: ReadonlyMap<string, number>,
  s: CoordinationSettings,
): { shared: SharedPath[]; cost: number } {
  const shared = sharedPaths(a, b).map((p) => pathWeight(p, conflicts, s));
  // Weights are multiples of 0.25 by default; rounding keeps a sum like 2.4999999 from slipping under a threshold.
  const cost = Math.round(shared.reduce((sum, p) => sum + p.weight, 0) * 1000) / 1000;
  return { shared, cost };
}

/** Work that can hold a queued implement run. */
export interface Holder {
  /** Null for a PR the store has no item for. */
  work_item_id: string | null;
  project: string;
  /** How comments name it: "#92". */
  ref: string;
  kind: "running" | "pr" | "waiting";
  files: readonly string[];
  /** `files` are allowed_paths, because the holder's open PR has no stored file list. */
  fallback: boolean;
}

export interface Hold {
  holder: Holder;
  shared: SharedPath[];
  cost: number;
}

/**
 * Every holder whose cost against the candidate is at or above `max_cost`: running and PR holders first, then
 * waiting ones, each group highest cost first. So the first hold is the one that decides (claimDecision) and the
 * one the stored decision names: a run held by an open PR names the PR, even when a queued run shares more files.
 * Only holders of the same project and another item count.
 */
export function holdsOn(
  candidate: { work_item_id: string; project: string; files: readonly string[] },
  holders: readonly Holder[],
  conflicts: ReadonlyMap<string, number>,
  s: CoordinationSettings,
): Hold[] {
  const holds: Hold[] = [];
  for (const h of holders) {
    if (h.work_item_id === candidate.work_item_id || h.project !== candidate.project) continue;
    const { shared, cost } = coordinationCost(candidate.files, h.files, conflicts, s);
    if (shared.length > 0 && cost >= s.max_cost) holds.push({ holder: h, shared, cost });
  }
  const rank = (h: Hold) => (h.holder.kind === "waiting" ? 1 : 0);
  return holds.sort((x, y) => rank(x) - rank(y) || y.cost - x.cost);
}

/**
 * What a claim does with a queued implement run, given its holds: `free` (nothing holds it), `deadlock` (held
 * only by other waiting runs: claimed, the claim takes runs oldest first) or `held` (it stays queued).
 */
export function claimDecision(holds: readonly Hold[]): "free" | "deadlock" | "held" {
  if (holds.length === 0) return "free";
  return holds.every((h) => h.holder.kind === "waiting") ? "deadlock" : "held";
}

/** A cost: one decimal (4.0, 2.5), two when a mechanical weight needs them (2.75). */
const fmt = (n: number) => n.toFixed(Number.isInteger(Math.round(n * 1000) / 100) ? 1 : 2);

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A weight as written in a hold reason: 0.25, 1, 2.5. */
const weightText = (n: number) => String(Number(n.toFixed(2)));

function describePath(p: SharedPath): string {
  if (p.mechanical) {
    const times = p.conflicts === 0 ? "" : `, conflicted ${p.conflicts === 1 ? "once" : `${p.conflicts} times`}`;
    return `${p.path} (mechanical, ${weightText(p.weight)}${times})`;
  }
  if (p.conflicts > 0) return `${p.path} (conflicted ${p.conflicts === 1 ? "once" : `${p.conflicts} times`})`;
  return p.hotspot ? `${p.path} (hotspot)` : p.path;
}

/**
 * The hold reason the item's comment and the dashboard show, e.g.
 * `waiting for #92 to merge: both change src/core/worker.ts (conflicted 6 times), cost 4.0 > 2.5`. A mechanical
 * path names its weight: `docs/design.md (mechanical, 0.25)`.
 */
export function holdReason(h: {
  holder_ref: string;
  shared: readonly SharedPath[];
  cost: number;
  threshold: number;
  fallback: boolean;
}): string {
  const op = h.cost > h.threshold ? ">" : "≥";
  const text = `waiting for ${h.holder_ref} to merge: both change ${list(h.shared.map(describePath))}, cost ${fmt(h.cost)} ${op} ${fmt(h.threshold)}`;
  return h.fallback
    ? `${text} (${h.holder_ref} is a PR opened before PR file lists were stored, so its allowed paths were used)`
    : text;
}

/** "#92" for an item of the same repository as `self` ("owner/repo#N" source ids), else the whole id. */
export function shortRef(id: string, self: string): string {
  const [repo, n] = id.split("#");
  return repo === self.split("#")[0] && n ? `#${n}` : id;
}

/** The blocked_reason of a dependency hold: `waiting for #92 to merge` (and the others, if several). */
export function dependencyReason(open: readonly string[], self: string): string {
  return `waiting for ${list(open.map((d) => shortRef(d, self)))} to merge`;
}

const DEPENDS_LINE = /^\s*(?:[-*]\s*)?depends\s+on\b\s*:?(.*)$/i;
const REF = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/**
 * The source ids a text names on `Depends on` lines (`Depends on: #12`, `depends on #12, #13`, `- Depends on
 * owner/other#4`), in order, without duplicates. `repo` ("owner/name") completes a bare `#N`.
 */
export function parseDependsOn(text: string, repo: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DEPENDS_LINE.exec(line);
    if (!m) continue;
    for (const r of m[1]!.matchAll(REF)) {
      const id = `${r[1] ?? repo}#${Number(r[2])}`;
      if (Number(r[2]) > 0 && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * A cycle through `start` in the dependency graph (source id → the source ids it depends on), as the ids in
 * order, starting and ending with `start`; null when there is none.
 */
export function findCycle(start: string, graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const seen = new Set<string>();
  const walk = (node: string, path: string[]): string[] | null => {
    for (const next of graph.get(node) ?? []) {
      if (next === start) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

export type DependencyVerdict =
  /** Every dependency merged (or there are none): nothing holds the item. */
  | { kind: "clear" }
  /** Still open: the item waits. */
  | { kind: "wait"; open: string[] }
  /** One closed without a merge: a human decides. */
  | { kind: "closed"; dependency: string }
  /** The item depends on itself through these ids: refused. */
  | { kind: "cycle"; cycle: string[] };

/** What an item's dependencies mean for it: a cycle first, then a dependency closed unmerged, then open ones. */
export function dependencyVerdict(
  self: string,
  edges: readonly { depends_on: string; state: DependencyState }[],
  graph: ReadonlyMap<string, readonly string[]>,
): DependencyVerdict {
  const cycle = findCycle(self, graph);
  if (cycle) return { kind: "cycle", cycle };
  const closed = edges.find((e) => e.state === "closed_unmerged");
  if (closed) return { kind: "closed", dependency: closed.depends_on };
  const open = edges.filter((e) => e.state === "open").map((e) => e.depends_on);
  return open.length > 0 ? { kind: "wait", open } : { kind: "clear" };
}

/** A dependency link a source found, before the controller stores it as an edge. */
export interface DependencyLink {
  depends_on: string;
  kind: DependencyKind;
}

/**
 * What a source offers for dependencies (GitHub: `Depends on` lines, sub-issues, blocked-by links). Optional:
 * a source without it gives no edges. The controller calls it outside the claim lock and stores the result.
 */
export interface DependencySource {
  /** The links of one source item, deduplicated by `depends_on` (the first kind found wins). */
  dependencyLinks(source: SourceRef): Promise<DependencyLink[]>;
  /** The state of a source item the store has no work item for. */
  dependencyState(depends_on: string): Promise<DependencyState>;
}

export function isDependencySource(x: object): x is DependencySource {
  const d = x as Partial<DependencySource>;
  return typeof d.dependencyLinks === "function" && typeof d.dependencyState === "function";
}
