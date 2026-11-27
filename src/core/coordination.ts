import { isUnder, pathsOverlap } from "./policy.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { DependencyKind, DependencyState, SharedPath, SourceRef, Timestamp, WorkItem, WorkItemId } from "./types.js";

/**
 * Coordination (design §5, decided 2026-11-03): when an implement run may start next to other work. Pure: no
 * I/O, no clock. The store's claim, the controller and the tests all use these functions.
 *
 * - The cost of running item A next to item B is the sum of the weights of the paths both change. A run whose
 *   cost against any holder is at or above `max_cost` is held. Holders: items with an implement run in progress,
 *   items with an open PR, and other queued implement runs.
 * - Deadlock rule: a run held only by other queued runs (no running item, no open PR) is claimed when its turn
 *   comes, so the oldest of a group that holds each other goes first. A queued run that is not held never holds
 *   on its own: it cannot make progress before it is claimed.
 * - Oldest held first (decided 2026-11-23): a queued run that is itself held holds every newer run it overlaps, and
 *   a running item or open PR holds a run already held only when it was ahead of it (`aheadOf`). So when a blocker
 *   merges, the oldest held run starts and newer overlapping runs wait for it.
 * - Hold policy (issue #314): a `held` run then waits, starts after `minutes` (default 120), or starts at once
 *   (`holdOutcome`).
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
/**
 * Default `hotspot_paths`: the files nearly every change touches, and that conflict when two do. A mechanical path
 * (`docs/design.md`) is never a hotspot, so it is not listed here.
 */
export const DEFAULT_HOTSPOTS: readonly string[] = [
  "src/impl/store/sqlite/schema.ts",
  "src/controller/",
  "src/worker/",
  "SET_UP.md",
];

/**
 * Default `mechanical_paths` (design §5, issue #297): files two items usually change only by adding lines or new
 * files (the design and plugin indexes and topic files). Their
 * conflicts are merged in code (src/core/mechanical.ts), so they weigh `mechanical_weight` and are never hotspots.
 */
export const DEFAULT_MECHANICAL: readonly string[] = [
  "docs/design/",
  "docs/design.md",
  "docs/plugins.md",
  "docs/plugins/",
];
/** Default `mechanical_weight`: well below BASE_WEIGHT, so a few index and History lines never hold a run. */
export const DEFAULT_MECHANICAL_WEIGHT = 0.25;

/**
 * `hold_policy` (design §5, issue #314): what a cost hold does. `hold` keeps the run queued until `/approve`;
 * `run_after_minutes` (the default, 120 minutes since 2026-11-23) claims it once it has been held `minutes`; `run`
 * claims it at once. Settable live.
 */
export type HoldPolicy = { mode: "hold" } | { mode: "run_after_minutes"; minutes: number } | { mode: "run" };
export const HOLD_POLICY_MODES = ["hold", "run_after_minutes", "run"] as const;
/** `minutes` of `run_after_minutes` when the value gives none. */
export const DEFAULT_HOLD_MINUTES = 120;
export const DEFAULT_HOLD_POLICY: HoldPolicy = { mode: "run_after_minutes", minutes: DEFAULT_HOLD_MINUTES };
/** `hotspot_mode`: `policy` (default) lets a hotspot hold follow `hold_policy`; `hold` always keeps it held. */
export const HOTSPOT_MODES = ["policy", "hold"] as const;
export type HotspotMode = (typeof HOTSPOT_MODES)[number];

/** A checked `hold_policy`; throws the config loader's message. `minutes` absent: DEFAULT_HOLD_MINUTES. */
export function parseHoldPolicy(value: unknown): HoldPolicy {
  const v = value as { mode?: unknown; minutes?: unknown } | null;
  if (typeof v !== "object" || v === null || Array.isArray(v) || !(HOLD_POLICY_MODES as readonly unknown[]).includes(v.mode)) {
    throw new Error(`hold_policy must be { "mode": ${HOLD_POLICY_MODES.map((m) => `"${m}"`).join(" | ")} } (got ${JSON.stringify(value) ?? String(value)})`);
  }
  const extra = Object.keys(v).filter((k) => k !== "mode" && !(k === "minutes" && v.mode === "run_after_minutes"));
  if (extra.length > 0) throw new Error(`hold_policy with mode "${String(v.mode)}" takes no ${extra.join(", ")}`);
  if (v.mode !== "run_after_minutes") return { mode: v.mode as "hold" | "run" };
  const minutes = v.minutes ?? DEFAULT_HOLD_MINUTES;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`hold_policy.minutes must be a positive integer (got ${JSON.stringify(v.minutes) ?? String(v.minutes)})`);
  }
  return { mode: "run_after_minutes", minutes };
}

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
  /** `hold_policy`: what a cost hold does (issue #314). */
  hold_policy: HoldPolicy;
  /** `hotspot_mode`: whether a hold on a hotspot follows `hold_policy` or always stays held. */
  hotspot_mode: HotspotMode;
  /** `conflict_window_days`: the claim counts only conflicts recorded this many days before it (design 05-dependencies). */
  conflict_window_days: number;
}

/** Default `conflict_window_days`: older conflicts add no learned weight. */
export const DEFAULT_CONFLICT_WINDOW_DAYS = 3;

/** The oldest conflict time a claim at `now` counts: `conflict_window_days` before it. */
export function conflictWindowStart(now: Date, s: Pick<CoordinationSettings, "conflict_window_days">): Timestamp {
  return new Date(now.getTime() - s.conflict_window_days * 86_400_000).toISOString() as Timestamp;
}

export const DEFAULT_COORDINATION: CoordinationSettings = {
  max_cost: DEFAULT_MAX_COORDINATION_COST,
  hotspots: DEFAULT_HOTSPOTS,
  hotspot_weight: DEFAULT_HOTSPOT_WEIGHT,
  mechanical: DEFAULT_MECHANICAL,
  mechanical_weight: DEFAULT_MECHANICAL_WEIGHT,
  hold_policy: DEFAULT_HOLD_POLICY,
  hotspot_mode: "policy",
  conflict_window_days: DEFAULT_CONFLICT_WINDOW_DAYS,
};

/** A file's weight from its recorded conflicts (inside `conflict_window_days`): 1.0 below two, then 1.0 + 0.5 per conflict, at most 4.0. */
export function learnedWeight(conflicts: number): number {
  if (conflicts < LEARNED_FROM) return BASE_WEIGHT;
  return Math.min(LEARNED_CAP, BASE_WEIGHT + LEARNED_STEP * conflicts);
}

/** Whether `path` is a hotspot, or a folder holding one, or under a hotspot folder. */
function isHotspot(path: string, hotspots: readonly string[]): boolean {
  return hotspots.some((h) => isUnder(h, path) || isUnder(path, h));
}

/**
 * Whether `path` is a mechanical path: equal to one, or under a mechanical folder. A folder that only holds one
 * (e.g. `docs/`) is not: it covers other files too.
 */
export function isMechanical(path: string, mechanical: readonly string[]): boolean {
  return mechanical.some((m) => isUnder(path, m));
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

/**
 * Shared index files a normal change never edits (design 05-dependencies, decided 2026-11-20): the design index
 * (edited only to add a topic file) and the generated i18n catalog barrel (edited only for a new area file). A
 * shared one counts only when both runs' lists name it; a folder that merely covers it claims nothing.
 */
export const UNCLAIMED_INDEXES: readonly string[] = ["docs/design.md", "web/src/i18n/en.ts"];

/** The cost of running two items side by side: the shared paths with their weights, and their sum. */
export function coordinationCost(
  a: readonly string[],
  b: readonly string[],
  conflicts: ReadonlyMap<string, number>,
  s: CoordinationSettings,
): { shared: SharedPath[]; cost: number } {
  const claimed = (p: string) => !UNCLAIMED_INDEXES.includes(p) || (a.includes(p) && b.includes(p));
  const shared = pathsOverlap(a, b).filter(claimed).map((p) => pathWeight(p, conflicts, s));
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
  /**
   * Running and PR holders: when the item's first implement run was queued and when it started. Null or absent:
   * none recorded, so it counts as ahead of any hold (`aheadOf`).
   */
  queued?: Timestamp | null;
  started?: Timestamp | null;
  /** Waiting holders: its run is held and comes before the candidate in the claim order, so it holds it (rule 2). */
  held?: boolean;
}

/**
 * Whether running or PR holder `h` may hold a run held since `holdStart` that was queued at `queued` (design
 * 05-dependencies, decided 2026-11-23): only when its implement run started before the hold began, or was queued
 * before the held run (it was ahead in the claim order, so the held run waits for it). A holder with no recorded
 * implement run counts as started before any hold. Waiting holders always pass: the claim order rules them.
 */
export function aheadOf(h: Holder, holdStart: Timestamp, queued: Timestamp): boolean {
  if (h.kind === "waiting" || !h.started) return true;
  const before = (t: Timestamp | null | undefined, ref: Timestamp) => !!t && Date.parse(t) < Date.parse(ref);
  return before(h.started, holdStart) || before(h.queued, queued);
}

export interface Hold {
  holder: Holder;
  shared: SharedPath[];
  cost: number;
}

/**
 * Every holder whose cost against the candidate is at or above `max_cost`: running and PR holders first, then
 * held waiting ones, then the other waiting ones, each group highest cost first. So the first hold is the one that decides (claimDecision) and the
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
  const rank = (h: Hold) => (h.holder.kind !== "waiting" ? 0 : h.holder.held ? 1 : 2);
  return holds.sort((x, y) => rank(x) - rank(y) || y.cost - x.cost);
}

/** An item as the session rule reads it: the files it claims are `files_to_change`, else `allowed_paths`. */
export type ClaimingItem = Pick<WorkItem, "id" | "project" | "files_to_change" | "allowed_paths">;

/**
 * The interactive session rule (design 05-dependencies, decided 2026-11-21): a session start next to running work,
 * and a claim next to an open session, use the workers' cost rule (`holdsOn`) instead of refusing on any shared
 * path, so shared mechanical paths (0.25) and unnamed shared indexes no longer hold. `running`: the other side's
 * running runs with their items. The highest hold (cost at or above `max_cost`) with its run, or null.
 */
export function sessionHold(
  candidate: ClaimingItem,
  running: readonly { run_id: string; item: ClaimingItem }[],
  conflicts: ReadonlyMap<string, number>,
  s: CoordinationSettings,
): (Hold & { run_id: string }) | null {
  const files = (it: ClaimingItem) => it.files_to_change ?? it.allowed_paths;
  const holders = running.map(({ item }): Holder => ({ work_item_id: item.id, project: item.project, ref: item.id, kind: "running", files: files(item), fallback: false }));
  const hold = holdsOn({ work_item_id: candidate.id, project: candidate.project, files: files(candidate) }, holders, conflicts, s)[0];
  return hold ? { ...hold, run_id: running.find((r) => r.item.id === hold.holder.work_item_id)!.run_id } : null;
}

/**
 * What a claim does with a queued implement run, given its holds: `free` (nothing holds it), `deadlock` (held
 * only by other waiting runs that are not held themselves: claimed, the claim takes runs oldest first) or `held`
 * (it stays queued: a running item, an open PR, or an older held run holds it).
 */
export function claimDecision(holds: readonly Hold[]): "free" | "deadlock" | "held" {
  if (holds.length === 0) return "free";
  return holds.every((h) => h.holder.kind === "waiting" && !h.holder.held) ? "deadlock" : "held";
}

/**
 * What `hold_policy` makes of a `held` claim decision (issue #314), `heldMs` after the hold started (`held_since`):
 * `held` (stays queued), `timed_out` (claimed: held `minutes` under `run_after_minutes`) or `overlap_allowed`
 * (claimed at once under `run`). With `hotspot_mode: hold`, a running item or open PR that shares a hotspot keeps
 * the run held whatever the policy.
 */
export function holdOutcome(holds: readonly Hold[], s: CoordinationSettings, heldMs: number): "held" | "timed_out" | "overlap_allowed" {
  const p = s.hold_policy;
  if (p.mode === "hold") return "held";
  if (s.hotspot_mode === "hold" && holds.some((h) => h.holder.kind !== "waiting" && h.shared.some((x) => x.hotspot))) return "held";
  if (p.mode === "run") return "overlap_allowed";
  return heldMs >= p.minutes * 60_000 ? "timed_out" : "held";
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
 * `waiting for #92 to merge: both change src/worker/runner.ts (conflicted 6 times), cost 4.0 > 2.5`. A mechanical
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

/**
 * How a hold names dependency `id`: its `label` (a local item's wi_ id, design 05-dependencies) when it has one, else
 * shortRef.
 */
export function dependencyRef(id: string, self: string, labels: ReadonlyMap<string, string> = new Map()): string {
  return labels.get(id) ?? shortRef(id, self);
}

/** The blocked_reason of a dependency hold: `waiting for #92 to merge` (and the others, if several). */
export function dependencyReason(open: readonly string[], self: string, labels?: ReadonlyMap<string, string>): string {
  return `waiting for ${list(open.map((d) => dependencyRef(d, self, labels)))} to merge`;
}

const DEPENDS_LINE = /^\s*(?:[-*]\s*)?depends\s+on\b\s*:?(.*)$/i;
const REF = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/**
 * The text after `Depends on` on each such line of `text` (`Depends on: #12`, `depends on #12, #13`, `- Depends on
 * wi_abc`), in order. parseDependsOn reads `#N` refs from it, the local source wi_ and tk_ ids.
 */
export function dependsOnLines(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = DEPENDS_LINE.exec(line);
    return m ? [m[1]!] : [];
  });
}

/**
 * The source ids a text names on `Depends on` lines (`Depends on: #12`, `depends on #12, #13`, `- Depends on
 * owner/other#4`), in order, without duplicates. `repo` ("owner/name") completes a bare `#N`.
 */
export function parseDependsOn(text: string, repo: string): string[] {
  const out: string[] = [];
  for (const line of dependsOnLines(text)) {
    for (const r of line.matchAll(REF)) {
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
 * What a source offers for dependencies (e.g. `Depends on` lines, sub-issues, blocked-by links). Optional:
 * a source without it gives no edges. The controller calls it outside the claim lock and stores the result.
 */
export interface DependencySource {
  /** The links of one source item, deduplicated by `depends_on` (the first kind found wins). */
  dependencyLinks(source: SourceRef): Promise<DependencyLink[]>;
  /** The state of a source item the store has no work item for. */
  dependencyState(depends_on: string): Promise<DependencyState>;
  /**
   * How a hold names `depends_on` when not as shortRef: the local source's wi_ id of the item (design
   * 05-dependencies). Optional: absent, or null, keeps shortRef. Reads only the store.
   */
  dependencyLabel?(depends_on: string): Promise<string | null>;
}

export function isDependencySource(x: object): x is DependencySource {
  const d = x as Partial<DependencySource>;
  return typeof d.dependencyLinks === "function" && typeof d.dependencyState === "function";
}

/** A wi_ or tk_ id as `--depends-on`, `/hold` and a local `Depends on:` line take it. */
export const LOCAL_ID = /^(?:wi|tk)_[\w-]+$/;

/**
 * The local work item a wi_ id names (the full ID, or a prefix of exactly one item's ID, as the dashboard's short ID
 * `wi_bbd7d1c8`), or the one task tk_'s build made; null for none, several, or an item that is not local.
 */
export async function localItemOf(store: Pick<FactoryStore, "getTask" | "getWorkItem" | "findWorkItemIds">, id: string): Promise<WorkItem | null> {
  if (!LOCAL_ID.test(id)) return null;
  let item: WorkItem | null;
  if (id.startsWith("tk_")) {
    const wi = (await store.getTask(id))?.work_item_id ?? null;
    item = wi ? await store.getWorkItem(wi) : null;
  } else {
    item = await store.getWorkItem(id as WorkItemId);
    const ids = item || !/^wi_[0-9a-f]+$/.test(id) ? [] : await store.findWorkItemIds(id);
    if (ids.length === 1) item = await store.getWorkItem(ids[0]!);
  }
  return item?.source.type === "local" ? item : null;
}

/** How a `Depends on:` line names `dep`, the item localItemOf found for `id`: a tk_ id as given, else the item's full wi_ ID. */
export const dependsOnId = (id: string, dep: Pick<WorkItem, "id">): string => (id.startsWith("tk_") ? id : dep.id);
