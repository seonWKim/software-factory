// The Needs-you list (design 09-status-page): one row per open work item that waits on a person or the budget check
// (the levels in NEEDS_YOU, priority.ts: ready to merge, needs approval, needs you, needs triage), and one row per
// system action, each open alarm its own row (the Tasks page's "Check" group). A stuck item waits on nobody's answer
// and an item started past a deadlock goes on by itself: neither is a row. The overview's `needs_you` is the number of
// these rows, so the sidebar badge, the top-bar chip and the Tasks page's section (web/src/views/task-work.tsx) agree.

import type { BlockedOn } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/** The blocks that make an open item a Needs-you row: an item with one of them has a NEEDS_YOU level (`levelOf`). */
export const WAITING_ON: readonly BlockedOn[] = ["human", "budget"];

/**
 * The number of Needs-you rows: every open item blocked on a person or the budget (an exact count, store reads only),
 * plus one per system action in `checks`.
 */
export async function needsYouCount(store: FactoryStore, checks: readonly unknown[]): Promise<number> {
  let items = 0;
  for (const blocked_on of WAITING_ON) items += await store.countWorkItemsWhere({ blocked_on, exclude_closed: true });
  return items + checks.length;
}
