// The ranked item list (design §9): every listed item with its level and what the filters read, for the JSON
// API (src/ui/api.ts): the items list and its facet counts read the same rows in the same order. Reads only.

import { type ConflictCounts, conflictCounts } from "../core/resolve.js";
import type { Alert, FactoryStore } from "../interfaces/factory-store.js";
import { MERGE_QUEUED, MERGE_REQUESTS_READ, mergeQueued, pendingApproval, pendingMerge } from "../core/commands.js";
import { blockingRunKind } from "../core/policy.js";
import { PERSON_PHASES, phaseOf } from "../core/phase.js";
import { type SettingsBase, resolveSettings } from "../core/settings.js";
import type { ClaimDecision, Run, RunKind, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import { alarmText, alarmsFor, itemAlarms, openAlarms } from "./alarms.js";
import { type FilterRow, type Filters, runKindOf, searchKeys } from "./filters.js";
import { filterShowsFinished } from "../shared/states.js";
import { type Level, type Pending, type PriorityInput, closedLevel, levelOf, rank } from "./priority.js";
import { heldFailureOf, needCtx } from "./need.js";
import { type ClaimPauses, type HeldFailure, type Why, type WhyInput, deadlocked, heldBy, refsOf, whyWaiting, withAlarms } from "./why.js";
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
  /** The owner's dashboard command the controller has not carried out yet (pendingOf), else null. */
  pending: Pending | null;
}

/** True when the filters may show closed items, so listRows reads them. */
const showsClosed = (f: Filters) => f.closed || filterShowsFinished(f.state) || f.stage === "CLOSED";

/** Every listed item, ranked (closed items too when the filters may show them). */
export async function listRows(c: ListCtx, f: Filters): Promise<ListRow[]> {
  const items = await c.store.listWorkItemsWhere({ exclude_closed: !showsClosed(f), limit: LIST_LIMIT });
  const { active, position } = await activeRuns(c.store);
  const pauses = await readClaimPauses(c.store);
  const open = await openAlarms(c.store, c.now);
  // One read for every row's latest claim decision; only an active implement run gets one.
  const decisions = await c.store.listLatestClaimDecisions(items.filter((it) => active.get(it.id)?.kind === "implement").map((it) => it.id));

  const titles = await holderTitles(c.store, [...decisions.values()]);
  const merges = await mergePositions(c.store, items.filter((it) => phaseOf(it) === "merge_pending"), items.filter(mergeQueued).length);

  const inputs: (PriorityInput & { item: WorkItem; conflicts: ConflictCounts; why: Why; decision: ClaimDecision | null; alarms: Alert[] })[] = [];
  const phases = items.filter((it) => it.parent_id !== null);
  for (const it of items) {
    const run = active.get(it.id) ?? null;
    const changes = await c.store.listStateChanges(it.id);
    const decision = run?.kind === "implement" ? (decisions.get(it.id) ?? null) : null;
    const waiting = waitingOn(it, phases);
    const runs = await c.store.listRuns(it.id);
    const alarms = alarmsFor(open, it, runs);
    const pending = pendingOf(it, run, changes, merges);
    inputs.push({
      item: it,
      ...priorityInput(it, run, runs, decision, waiting, changes, pending),
      conflicts: conflictCounts(runs, changes),
      decision,
      alarms,
      why: pendingWhy(pending, alarms) ?? whyOf(it, run, position.get(run?.id ?? "") ?? null, withTitle(decision, titles), pauses, waiting, c.now, alarms, await heldFailureOf(needCtx(c.store, c.w), it, runs)),
    });
  }

  const out: ListRow[] = [];
  for (const r of rank(inputs, c.now, c.lease_ms)) {
    const it = r.input.item;
    out.push({
      item: it,
      input: r.input,
      level: r.level,
      stage: it.stage,
      tier: it.tier,
      kind: runKindOf(it.blocked_reason, r.input.run?.kind ?? (r.input.pending?.command === "approve" ? r.input.pending.kind : null)),
      dependents: r.input.dependents,
      search: searchKeys(it.source.id, await searchTitle(c.w, it)),
      runStatus: r.input.run?.status ?? null,
      run: active.get(it.id) ?? null,
      position: position.get(active.get(it.id)?.id ?? "") ?? null,
      decision: r.input.decision && r.input.decision.run_id === active.get(it.id)?.id ? r.input.decision : null,
      conflicts: r.input.conflicts,
      why: r.input.why,
      alarms: r.input.alarms,
      pending: r.input.pending ?? null,
    });
  }
  return out;
}

/**
 * The 1-based place of each of `waiting` (items at merge_pending) whose dashboard Merge is stored and not handled yet,
 * by its oldest such request: behind the `checking` items the merge queue checks now (merge_queued). One store read per
 * item at merge_pending (few wait there at once; the store interface is unchanged), none for any other item.
 */
export async function mergePositions(store: Pick<FactoryStore, "listAppCommandRequestsForItem">, waiting: readonly WorkItem[], checking: number): Promise<Map<WorkItemId, number>> {
  const seqs: [WorkItemId, number][] = [];
  for (const it of waiting) {
    const seq = pendingMerge(await store.listAppCommandRequestsForItem(it.id, MERGE_REQUESTS_READ));
    if (seq !== null) seqs.push([it.id, seq]);
  }
  return new Map(seqs.sort((a, b) => a[1] - b[1]).map(([id], i) => [id, checking + i + 1]));
}

/**
 * The pending-request rule (design 09-dashboard-item-commands), one for the list, the item page and the Merge button:
 * a Merge stored and not handled yet (its place from mergePositions), else an Approve whose run the controller has
 * not queued yet (core pendingApproval) while the item has no queued or running run. Null for anything else.
 */
export function pendingOf(it: WorkItem, run: Run | null, changes: readonly StateChange[], merges: ReadonlyMap<WorkItemId, number>): Pending | null {
  const position = merges.get(it.id);
  if (position !== undefined) return { command: "merge", position };
  const active = run?.status === "queued" || run?.status === "running";
  const kind = active ? null : pendingApproval(it, changes);
  return kind === null ? null : { command: "approve", kind };
}

/** A pending command's reason, as a queued run's (the Merge's place, or the approved run's kind), with the alarms; null for none. */
function pendingWhy(pending: Pending | null, alarms: readonly Alert[]): Why | null {
  if (!pending) return null;
  const params = pending.command === "merge" ? { position: pending.position } : { kind: pending.kind };
  return withAlarms({ code: "queued", reason_code: pending.command === "merge" ? "queued_at" : "queued", params, next_actor: "factory", refs: [], alarms: [], holder_id: null }, alarms.map(alarmText));
}

/**
 * What the ranking reads about one item (priority.ts levelOf): its state, its active run, its last finished run,
 * what it waits on and its claim hold. One builder for the list and the item page, so both give one level.
 */
export function priorityInput(
  it: WorkItem, run: Run | null, runs: readonly Run[], decision: ClaimDecision | null, waiting: { waiting_on: number; waiting_on_number: number | null }, changes: readonly StateChange[], pending: Pending | null = null,
): PriorityInput {
  const person = PERSON_PHASES.has(phaseOf(it));
  return {
    stage: it.stage,
    blocked_on: it.blocked_on,
    blocked_reason: it.blocked_reason,
    close_reason: it.close_reason,
    tier: it.tier,
    since: person ? waitingSince(it, changes) : it.updated_at,
    run: run && (run.status === "queued" || run.status === "running") ? { kind: run.kind, status: run.status, heartbeat_at: run.updated_at, paused_at: run.paused_at } : null,
    last_finished_at: runs.reduce<string | null>((a, r) => (r.finished_at && (!a || r.finished_at > a) ? r.finished_at : a), null),
    dependents: 0,
    ...waiting,
    ...holdOf(decision, run, waiting.waiting_on_number),
    asked_by: blockingRunKind(it.blocked_reason, runs) ?? null,
    pending,
  };
}

/**
 * Why one item waits, its level and its pending command, from the same reads and rules as listRows (the item page's
 * state). A pending Merge's place reads the other items at merge_pending only when this item has one.
 */
export async function itemState(c: ListCtx, it: WorkItem, runs: readonly Run[], changes: readonly StateChange[]): Promise<{ why: Why; level: Level; pending: Pending | null }> {
  const { active, position } = await activeRuns(c.store);
  const run = active.get(it.id) ?? null;
  const decision = await latestDecision(c.store, it.id, run);
  const waiting = waitingOn(it, await readPhases(c.store, [it]));
  const alarms = await itemAlarms(c.store, await openAlarms(c.store, c.now), it);
  const pending = pendingOf(it, run, changes, await itemMergePosition(c.store, it));
  const why = pendingWhy(pending, alarms) ?? whyOf(it, run, position.get(run?.id ?? "") ?? null, withTitle(decision, await holderTitles(c.store, [decision])), await readClaimPauses(c.store), waiting, c.now, alarms, await heldFailureOf(needCtx(c.store, c.w), it, runs));
  return { why, level: levelOf(priorityInput(it, run, runs, decision, waiting, changes, pending), c.now, c.lease_ms), pending };
}

/** mergePositions as the list reads it, for one item: the other items at merge_pending and merge_queued are read only when its own Merge is pending. */
async function itemMergePosition(store: FactoryStore, it: WorkItem): Promise<Map<WorkItemId, number>> {
  if (phaseOf(it) !== "merge_pending" || pendingMerge(await store.listAppCommandRequestsForItem(it.id, MERGE_REQUESTS_READ)) === null) return new Map();
  const waiting = await store.listWorkItemsWhere({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", limit: LIST_LIMIT });
  const checking = await store.countWorkItemsWhere({ stage: "REVIEW", blocked_on: "ci", blocked_reason: MERGE_QUEUED });
  return mergePositions(store, waiting, checking);
}

/**
 * The open and running counts every page shows (design 09-status-page), defined once: open is every item whose stage
 * is not CLOSED, running every run whose status is running. The overview (Activity) and the items list (Work) both
 * read them from here.
 */
export async function itemCounts(store: Pick<FactoryStore, "countWorkItemsByStage" | "listRunsByStatus">): Promise<{ open: number; running: number }> {
  const stages = await store.countWorkItemsByStage();
  const open = Object.entries(stages).reduce((n, [stage, count]) => n + (stage === "CLOSED" ? 0 : count), 0);
  return { open, running: (await store.listRunsByStatus(["running"], LIST_LIMIT)).length };
}

/** The title the search reads: the full title, or null when the item has none or it is withheld. */
async function searchTitle(w: Withholder, it: WorkItem): Promise<string | null> {
  return it.title && !(await w.plain(it.title)).withheld ? it.title : null;
}

/**
 * The closed items as the facet counts read them, when listRows left them out: so the Finished options count the
 * closed items that match the other filters, as every other option does. One store read (at most LIST_LIMIT
 * items), no per-item reads: a closed item's level comes from its phase and close reason (closedLevel), its kind
 * from its blocked reason.
 */
export async function closedFacetRows(c: ListCtx, f: Filters): Promise<FilterRow[]> {
  if (showsClosed(f)) return [];
  const out: FilterRow[] = [];
  for (const it of await c.store.listWorkItemsWhere({ stage: "CLOSED", limit: LIST_LIMIT })) {
    out.push({ level: closedLevel(it), stage: it.stage, tier: it.tier, kind: runKindOf(it.blocked_reason, null), dependents: 0, search: searchKeys(it.source.id, await searchTitle(c.w, it)) });
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
  const p = phaseOf(it);
  if (p === "phase_hold" && it.phase !== null) {
    const before = phases.find((p) => p.parent_id === it.parent_id && p.phase === it.phase! - 1 && p.stage !== "CLOSED");
    return before ? { waiting_on: 1, waiting_on_number: issueNumber(before) } : { waiting_on: 0, waiting_on_number: null };
  }
  if (p === "phases_open") {
    const open = phases.filter((p) => p.parent_id === it.id && p.stage !== "CLOSED");
    return { waiting_on: open.length, waiting_on_number: open.length === 1 ? issueNumber(open[0]!) : null };
  }
  if (p === "dependency_hold") {
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
    worker_kinds: await workerKindsNow(store),
    rate_limit: await store.getClaimPause("rate_limit"),
    model_stall: await store.getClaimPause("model_stall"),
    model_credential: await store.getClaimPause("model_credential"),
    forge_auth: await store.getClaimPause("forge_auth"),
    preflight_access: await store.getClaimPause("preflight_access"),
  };
}

/**
 * The run kinds workers claim now: the `worker_kinds` override, else the default (the config file does not set it).
 * A failed read says nothing (every kind), so the reason never claims a wait it could not check.
 */
async function workerKindsNow(store: FactoryStore): Promise<readonly RunKind[] | null> {
  try {
    return resolveSettings(NO_FILE, await store.listSettingOverrides()).values.worker_kinds;
  } catch {
    return null;
  }
}

const NO_FILE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

/** The item's latest claim decision, read only while its active run is an implement run (only those get one). */
export async function latestDecision(store: FactoryStore, id: WorkItemId, run: Run | null): Promise<ClaimDecision | null> {
  return run?.kind === "implement" ? ((await store.listClaimDecisions(id)).at(-1) ?? null) : null;
}

/** The titles of the work items that hold a deadlock or held claim of one of `decisions`: one store read per distinct holder. */
export async function holderTitles(store: FactoryStore, decisions: readonly (ClaimDecision | null)[]): Promise<Map<WorkItemId, string | null>> {
  const out = new Map<WorkItemId, string | null>();
  for (const d of decisions) {
    const id = d?.decision === "deadlock" || d?.decision === "held" ? d.holder_work_item_id : null;
    if (id && !out.has(id)) out.set(id, (await store.getWorkItem(id))?.title ?? null);
  }
  return out;
}

/** The decision with its holder's title, for whyWaiting; as is when it has no holder item. */
export function withTitle(decision: ClaimDecision | null, titles: ReadonlyMap<WorkItemId, string | null>) {
  return decision && { ...decision, holder_title: decision.holder_work_item_id ? (titles.get(decision.holder_work_item_id) ?? null) : null };
}

/**
 * whyWaiting's input from the stored item and run; `not_before` counts only while it is after `now`. The open
 * alarms that affect the item are named after the sentence; `failure` is a held item's last failed run (heldFailureOf).
 */
export function whyOf(
  it: WorkItem,
  run: Run | null,
  position: number | null,
  decision: WhyInput["decision"],
  pauses: ClaimPauses,
  phases: { waiting_on: number; waiting_on_number: number | null },
  now: Date,
  alarms: readonly Alert[],
  failure: HeldFailure | null = null,
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
    failure,
  }), alarms.map(alarmText));
}

/** The phases waitingOn reads: the open split items, read only when one of `items` waits on a phase. */
export async function readPhases(store: FactoryStore, items: readonly WorkItem[]): Promise<WorkItem[]> {
  if (!items.some((it) => phaseOf(it) === "phase_hold" || phaseOf(it) === "phases_open")) return [];
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
