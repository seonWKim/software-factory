// The ranked item list (design §9): every listed item with its level, badges and what the filters read.
// Shared by the HTML page (src/ui/pages.ts) and the JSON API (src/ui/api.ts), so both show the same rows in
// the same order for the same store and query. Reads only.

import { type ConflictCounts, conflictCounts } from "../core/resolve.js";
import type { Run, StateChange, WorkItem, WorkItemId } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type FilterRow, type Filters, runKindOf, searchKeys } from "./filters.js";
import { esc } from "./html.js";
import { type PriorityInput, rank } from "./priority.js";
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
  /** Merge conflicts resolved automatically and those that needed a person, from the item's history. */
  conflicts: ConflictCounts;
}

/** Every listed item, ranked (closed items too when the filters may show them). */
export async function listRows(c: ListCtx, f: Filters): Promise<ListRow[]> {
  const withClosed = f.closed || f.state === "closed" || f.stage === "CLOSED";
  const items = await c.store.listWorkItemsWhere({ exclude_closed: !withClosed, limit: LIST_LIMIT });
  const active = new Map<WorkItemId, Run>();
  for (const r of await c.store.listRunsByStatus(["queued"], LIST_LIMIT)) if (!active.has(r.work_item_id)) active.set(r.work_item_id, r);
  for (const r of await c.store.listRunsByStatus(["running"], LIST_LIMIT)) active.set(r.work_item_id, r); // running wins

  const inputs: (PriorityInput & { item: WorkItem; conflicts: ConflictCounts })[] = [];
  for (const it of items) {
    const run = active.get(it.id);
    const blocked = it.blocked_on === "human" || it.blocked_on === "budget";
    const changes = await c.store.listStateChanges(it.id);
    inputs.push({
      item: it,
      stage: it.stage,
      blocked_on: it.blocked_on,
      blocked_reason: it.blocked_reason,
      close_reason: it.close_reason,
      tier: it.tier,
      since: blocked && it.stage !== "CLOSED" ? waitingSince(it, changes) : it.updated_at,
      run: run && (run.status === "queued" || run.status === "running") ? { kind: run.kind, status: run.status, heartbeat_at: run.updated_at } : null,
      dependents: 0,
      waiting_on: 0,
      conflicts: conflictCounts(await c.store.listRuns(it.id), changes),
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
      conflicts: r.input.conflicts,
    });
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
