// Filters for the status page (design §9). Pure: parses query values, applies them to ranked rows, and
// counts what each option would show. An unknown value is an error (the server answers 400).

import type { RunKind, Stage, Tier } from "../core/types.js";
import { LEVEL_LABELS, LEVELS, type Level, NEEDS_YOU } from "./priority.js";

export const STAGES: readonly Stage[] = ["NEW", "READY", "RUNNING", "REVIEW", "CLOSED"];
export const TIERS: readonly Tier[] = [1, 2, 3, 4, 5];
export const RUN_KINDS: readonly RunKind[] = ["triage", "implement", "review", "update"];

/** `needs` is the three levels that wait for a person; every other value is one level. */
export type StateFilter = "needs" | Level;
export const STATE_OPTIONS: readonly { value: StateFilter; label: string }[] = [
  { value: "needs", label: "Needs you" },
  ...LEVELS.map((l) => ({ value: l, label: LEVEL_LABELS[l] })),
];

/** Longest search text kept; the rest is cut. */
export const MAX_QUERY = 200;

export interface Filters {
  state: StateFilter | undefined;
  stage: Stage | undefined;
  tier: Tier | undefined;
  kind: RunKind | undefined;
  /** Only items with dependents. */
  unblocks: boolean;
  /** Lower-cased search text; "" does not filter. */
  q: string;
  /** Show CLOSED items with the open ones. */
  closed: boolean;
}

export const NO_FILTERS: Filters = { state: undefined, stage: undefined, tier: undefined, kind: undefined, unblocks: false, q: "", closed: false };

/** What the filters read about one row. */
export interface FilterRow {
  level: Level;
  stage: Stage;
  tier: Tier | null;
  /** The run kind named in the blocked reason, else the kind of the queued or running run. */
  kind: RunKind | null;
  dependents: number;
  /** The issue number and the title as the page shows it (after withholding), lower-cased. */
  search: readonly string[];
}

export type ParseResult = { ok: true; filters: Filters } | { ok: false; error: string };

function pick<T extends string | number>(raw: string | null, allowed: readonly T[], name: string): { ok: true; value: T | undefined } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  const v = allowed.find((a) => String(a) === raw);
  return v === undefined ? { ok: false, error: `Unknown ${name}.` } : { ok: true, value: v };
}

function flag(raw: string | null, name: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === null || raw === "" || raw === "0") return { ok: true, value: false };
  if (raw === "1") return { ok: true, value: true };
  return { ok: false, error: `Unknown ${name}.` };
}

export function parseFilters(params: URLSearchParams): ParseResult {
  const state = pick(params.get("state"), STATE_OPTIONS.map((o) => o.value), "state");
  if (!state.ok) return state;
  const stage = pick(params.get("stage"), STAGES, "stage");
  if (!stage.ok) return stage;
  const tier = pick(params.get("tier"), TIERS, "tier");
  if (!tier.ok) return tier;
  const kind = pick(params.get("kind"), RUN_KINDS, "run kind");
  if (!kind.ok) return kind;
  const unblocks = flag(params.get("unblocks"), "unblocks value");
  if (!unblocks.ok) return unblocks;
  const closed = flag(params.get("closed"), "closed value");
  if (!closed.ok) return closed;
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY).toLowerCase();
  return {
    ok: true,
    filters: { state: state.value, stage: stage.value, tier: tier.value, kind: kind.value, unblocks: unblocks.value, q, closed: closed.value },
  };
}

/** True when any filter narrows the list (the default view hides only CLOSED). */
export function isFiltered(f: Filters): boolean {
  return f.state !== undefined || f.stage !== undefined || f.tier !== undefined || f.kind !== undefined || f.unblocks || f.q !== "" || f.closed;
}

export function matches(r: FilterRow, f: Filters): boolean {
  // CLOSED rows show only when asked for.
  if (r.level === "closed" && !f.closed && f.state !== "closed" && f.stage !== "CLOSED") return false;
  if (f.state === "needs" ? !NEEDS_YOU.includes(r.level) : f.state !== undefined && r.level !== f.state) return false;
  if (f.stage !== undefined && r.stage !== f.stage) return false;
  if (f.tier !== undefined && r.tier !== f.tier) return false;
  if (f.kind !== undefined && r.kind !== f.kind) return false;
  if (f.unblocks && r.dependents <= 0) return false;
  if (f.q !== "" && !r.search.some((s) => s.includes(f.q))) return false;
  return true;
}

export function applyFilters<T extends FilterRow>(rows: readonly T[], f: Filters): T[] {
  return rows.filter((r) => matches(r, f));
}

export interface FacetCounts {
  /** Rows with the state filter cleared (the "All" option). */
  allStates: number;
  state: Record<StateFilter, number>;
  allStages: number;
  stage: Record<Stage, number>;
  allTiers: number;
  tier: Record<Tier, number>;
  allKinds: number;
  kind: Record<RunKind, number>;
  unblocks: number;
}

/** For each option: how many rows the page would show with that option chosen and every other filter kept. */
export function facetCounts(rows: readonly FilterRow[], f: Filters): FacetCounts {
  const count = (g: Filters) => rows.reduce((n, r) => n + (matches(r, g) ? 1 : 0), 0);
  const per = <K extends string | number, V>(values: readonly V[], key: (v: V) => K, with_: (v: V) => Filters) =>
    Object.fromEntries(values.map((v) => [key(v), count(with_(v))])) as Record<K, number>;
  return {
    allStates: count({ ...f, state: undefined }),
    state: per(STATE_OPTIONS, (o) => o.value, (o) => ({ ...f, state: o.value })),
    allStages: count({ ...f, stage: undefined }),
    stage: per(STAGES, (s) => s, (s) => ({ ...f, stage: s })),
    allTiers: count({ ...f, tier: undefined }),
    tier: per(TIERS, (t) => t, (t) => ({ ...f, tier: t })),
    allKinds: count({ ...f, kind: undefined }),
    kind: per(RUN_KINDS, (k) => k, (k) => ({ ...f, kind: k })),
    unblocks: count({ ...f, unblocks: true }),
  };
}

/** Choice (b): the kind in a `run_failed:<kind>:<code>` reason, else the active run's kind. */
export function runKindOf(blocked_reason: string | null, activeKind: RunKind | null): RunKind | null {
  const named = blocked_reason?.match(/^run_failed:([a-z]+):/)?.[1];
  const fromReason = RUN_KINDS.find((k) => k === named);
  return fromReason ?? activeKind;
}

/** The search keys for a row: "#12" and "12" from the source id, and the shown title (null when withheld). */
export function searchKeys(sourceId: string, shownTitle: string | null): string[] {
  const n = sourceId.match(/#(\d+)$/)?.[1];
  const keys = n ? [`#${n}`] : [sourceId.toLowerCase()];
  if (shownTitle !== null) keys.push(shownTitle.toLowerCase());
  return keys;
}
