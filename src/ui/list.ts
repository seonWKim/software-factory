// The ranked item list (design §9): every listed item with its level, badges and what the filters read.
// Shared by the HTML page (src/ui/pages.ts) and the JSON API (src/ui/api.ts), so both show the same rows in
// the same order for the same store and query. Reads only.

import { type ConflictCounts, conflictCounts } from "../core/resolve.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";
import { blockingRunKind } from "../core/policy.js";
import { PHASE_HOLD, PHASES_OPEN } from "../core/split.js";
import type { ClaimDecision, Run, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import { alarmText, alarmsFor, openAlarms } from "./alarms.js";
import { type FilterRow, type Filters, runKindOf, searchKeys } from "./filters.js";
import { esc } from "./html.js";
import { type PriorityInput, rank } from "./priority.js";
import { type ClaimPauses, type Why, deadlocked, heldBy, refsOf, whyWaiting, withAlarms } from "./why.js";
import type { Withholder } from "./withhold.js";

/** Most rows any list or section reads from the store. */
export const LIST_LIMIT = 200;

/** What listRows reads: the store, the withholder for titles, the page's "now" and the lease for "stuck". */
export interface ListCtx {
  store: FactoryStore;
  w: Withholder;
  now: Date;
  lease_ms: number;
}

/** One ranked row of the list, with what the filters read. */
export interface ListRow extends FilterRow {
  item: WorkItem;
  input: PriorityInput;
  badges: string[];
  /** Escaped title HTML (withheld marker when withheld; source id when untitled). */
  titleHtml: string;
  /** The full title as shown, for the title attribute; null when withheld or untitled. */
  titlePlain: string | null;
  runStatus: "queued" | "running" | null;
  /** The item's queued or running run, and a queued run's 1-based place in the queue. */
  run: Run | null;
  position: number | null;
  /** The latest claim decision of the item's active implement run; null when it has none or it is from an earlier run. */
  decision: ClaimDecision | null;
  /** Merge conflicts resolved automatically and those that needed a person, from the item's history. */
  conflicts: ConflictCounts;
  /** Why the item waits (why.ts), with the open alarms that affect it named; its text is not withheld yet. */
  why: Why;
  /** The open alarms that affect the item (alarms.ts). */
  alarms: Alert[];
}

/** True when the filters may show closed items, so listRows reads them. */
const showsClosed = (f: Filters) => f.closed || f.state === "closed" || f.stage === "CLOSED";

/** Every listed item, ranked (closed items too when the filters may show them). */
export async function listRows(c: ListCtx, f: Filters): Promise<ListRow[]> {
  const items = await c.store.listWorkItemsWhere({ exclude_closed: !showsClosed(f), limit: LIST_LIMIT });
  const { active, position } = await activeRuns(c.store);
  const pauses = await readClaimPauses(c.store);
  const open = await openAlarms(c.store, c.now);
  // One read for every row's latest claim decision; only an active implement run gets one.
  const decisions = await c.store.listLatestClaimDecisions(items.filter((it) => active.get(it.id)?.kind === "implement").map((it) => it.id));

  const inputs: (PriorityInput & { item: WorkItem; conflicts: ConflictCounts; why: Why; decision: ClaimDecision | null; alarms: Alert[] })[] = [];
  const phases = items.filter((it) => it.parent_id !== null);
  for (const it of items) {
    const run = active.get(it.id) ?? null;
    const blocked = it.blocked_on === "human" || it.blocked_on === "budget";
    const changes = await c.store.listStateChanges(it.id);
    const decision = run?.kind === "implement" ? (decisions.get(it.id) ?? null) : null;
    const waiting = waitingOn(it, phases);
    const runs = await c.store.listRuns(it.id);
    const alarms = alarmsFor(open, it, runs);
    inputs.push({
      item: it,
      stage: it.stage,
      blocked_on: it.blocked_on,
      blocked_reason: it.blocked_reason,
      close_reason: it.close_reason,
      tier: it.tier,
      since: blocked && it.stage !== "CLOSED" ? waitingSince(it, changes) : it.updated_at,
      run: run ? { kind: run.kind, status: run.status as "queued" | "running", heartbeat_at: run.updated_at, paused_at: run.paused_at } : null,
      last_finished_at: runs.reduce<string | null>((a, r) => (r.finished_at && (!a || r.finished_at > a) ? r.finished_at : a), null),
      dependents: 0,
      ...waiting,
      ...holdOf(decision, run, waiting.waiting_on_number),
      asked_by: blockingRunKind(it.blocked_reason, runs) ?? null,
      conflicts: conflictCounts(runs, changes),
      decision,
      alarms,
      why: whyOf(it, run, position.get(run?.id ?? "") ?? null, decision, pauses, waiting, c.now, alarms),
    });
  }

  const out: ListRow[] = [];
  for (const r of rank(inputs, c.now, c.lease_ms)) {
    const it = r.input.item;
    const t = it.title ? await c.w.shown(it.title, { max: 120 }) : { html: esc(it.source.id), plain: null };
    out.push({
      item: it,
      input: r.input,
      level: r.level,
      badges: r.badges,
      stage: it.stage,
      tier: it.tier,
      kind: runKindOf(it.blocked_reason, r.input.run?.kind ?? null),
      dependents: r.input.dependents,
      search: searchKeys(it.source.id, it.title ? t.plain : null),
      titleHtml: t.html,
      titlePlain: t.plain,
      runStatus: r.input.run?.status ?? null,
      run: active.get(it.id) ?? null,
      position: position.get(active.get(it.id)?.id ?? "") ?? null,
      decision: r.input.decision && r.input.decision.run_id === active.get(it.id)?.id ? r.input.decision : null,
      conflicts: r.input.conflicts,
      why: r.input.why,
      alarms: r.input.alarms,
    });
  }
  return out;
}

/**
 * The closed items as the facet counts read them, when listRows left them out: so the Closed option counts the
 * closed items that match the other filters, as every other option does. One store read (at most LIST_LIMIT
 * items), no per-item reads: a closed item's level is always `closed`, its kind comes from its blocked reason.
 */
export async function closedFacetRows(c: ListCtx, f: Filters): Promise<FilterRow[]> {
  if (showsClosed(f)) return [];
  const out: FilterRow[] = [];
  for (const it of await c.store.listWorkItemsWhere({ stage: "CLOSED", limit: LIST_LIMIT })) {
    const shown = it.title ? (await c.w.shown(it.title, { max: 120 })).plain : null;
    out.push({ level: "closed", stage: it.stage, tier: it.tier, kind: runKindOf(it.blocked_reason, null), dependents: 0, search: searchKeys(it.source.id, shown) });
  }
  return out;
}

/**
 * When the item started waiting: the latest state change that set its blocked_on or blocked_reason
 * (created_at if none did).
 */
export function waitingSince(it: WorkItem, changes: readonly StateChange[]): string {
  const set = changes.filter((sc) => sc.changes.blocked_on !== undefined || sc.changes.blocked_reason !== undefined).at(-1);
  return set?.at ?? it.created_at;
}

/**
 * What a split item waits on, from the listed items: a held phase (`phase_hold`) waits on the phase before it,
 * a split parent (`phases_open`) on its open phases, a dependency blocker on the `#N` its stored reason names.
 * Anything else: nothing.
 */
export function waitingOn(it: WorkItem, phases: readonly WorkItem[]): { waiting_on: number; waiting_on_number: number | null } {
  if (it.blocked_on === "upstream" && it.blocked_reason === PHASE_HOLD && it.phase !== null) {
    const before = phases.find((p) => p.parent_id === it.parent_id && p.phase === it.phase! - 1 && p.stage !== "CLOSED");
    return before ? { waiting_on: 1, waiting_on_number: issueNumber(before) } : { waiting_on: 0, waiting_on_number: null };
  }
  if (it.blocked_on === "upstream" && it.blocked_reason === PHASES_OPEN) {
    const open = phases.filter((p) => p.parent_id === it.id && p.stage !== "CLOSED");
    return { waiting_on: open.length, waiting_on_number: open.length === 1 ? issueNumber(open[0]!) : null };
  }
  if (it.blocked_on === "dependency") {
    const refs = refsOf(it.blocked_reason ?? "");
    return { waiting_on: refs.length, waiting_on_number: refs.length === 1 ? refs[0]! : null };
  }
  return { waiting_on: 0, waiting_on_number: null };
}

/** The issue number at the end of a source id (`owner/name#12`), else null. */
function issueNumber(it: WorkItem): number | null {
  const m = /#(\d+)$/.exec(it.source.id);
  return m ? Number(m[1]) : null;
}

/** Every item's queued or running run (running wins) and each queued run's 1-based place, in the Queue's order. */
export async function activeRuns(store: FactoryStore): Promise<{ active: Map<WorkItemId, Run>; position: Map<string, number> }> {
  const active = new Map<WorkItemId, Run>();
  const position = new Map<string, number>();
  for (const [i, r] of (await store.listRunsByStatus(["queued"], LIST_LIMIT)).entries()) {
    position.set(r.id, i + 1);
    if (!active.has(r.work_item_id)) active.set(r.work_item_id, r);
  }
  for (const r of await store.listRunsByStatus(["running"], LIST_LIMIT)) active.set(r.work_item_id, r); // running wins
  return { active, position };
}

/** The claim pauses in effect, as the claim reads them (four store reads). */
export async function readClaimPauses(store: FactoryStore): Promise<ClaimPauses> {
  return {
    rate_limit: await store.getClaimPause("rate_limit"),
    model_stall: await store.getClaimPause("model_stall"),
    forge_auth: await store.getClaimPause("forge_auth"),
    preflight_access: await store.getClaimPause("preflight_access"),
  };
}

/** The item's latest claim decision, read only while its active run is an implement run (only those get one). */
export async function latestDecision(store: FactoryStore, id: WorkItemId, run: Run | null): Promise<ClaimDecision | null> {
  return run?.kind === "implement" ? ((await store.listClaimDecisions(id)).at(-1) ?? null) : null;
}

/**
 * whyWaiting's input from the stored item and run; `not_before` counts only while it is after `now`. The open
 * alarms that affect the item are named after the sentence.
 */
export function whyOf(
  it: WorkItem,
  run: Run | null,
  position: number | null,
  decision: ClaimDecision | null,
  pauses: ClaimPauses,
  phases: { waiting_on: number; waiting_on_number: number | null },
  now: Date,
  alarms: readonly Alert[],
): Why {
  const active = run && (run.status === "queued" || run.status === "running") ? run : null;
  const notBefore = active?.status === "queued" && active.not_before && Date.parse(active.not_before) > now.getTime() ? active.not_before : null;
  return withAlarms(whyWaiting({
    item: it,
    run: active ? { id: active.id, kind: active.kind, status: active.status as "queued" | "running", position: active.status === "queued" ? position : null } : null,
    decision,
    pauses,
    not_before: notBefore,
    phases,
  }), alarms.map(alarmText));
}

/** The phases waitingOn reads: the open split items, read only when one of `items` waits on a phase. */
export async function readPhases(store: FactoryStore, items: readonly WorkItem[]): Promise<WorkItem[]> {
  if (!items.some((it) => it.blocked_on === "upstream")) return [];
  return (await store.listWorkItemsWhere({ exclude_closed: true, limit: LIST_LIMIT })).filter((it) => it.parent_id !== null);
}

/**
 * A claim decision's hold on the item's current run: `deadlock` and `held` (a coordination hold), and the holder's
 * issue number as the number the item waits on when the item names none of its own.
 */
function holdOf(decision: ClaimDecision | null, run: Run | null, waiting_on_number: number | null): { deadlock: boolean; held: boolean; waiting_on_number: number | null } {
  const deadlock = deadlocked(decision, run);
  const held = heldBy(decision, run);
  const holder = deadlock || held ? (refsOf(decision!.holder_ref)[0] ?? null) : null;
  return { deadlock, held, waiting_on_number: waiting_on_number ?? holder };
}
