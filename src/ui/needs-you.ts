// The Needs-you list (design 09-status-page): one row per open work item in the state table's Needs-you group
// (NEEDS_YOU, priority.ts: ready to merge, needs approval, needs you), and one row per system action, each open alarm
// its own row (the Tasks page's "Check" group). A triage run's ask (Waiting), a failed run (Problem), a stuck item and
// an item started past a deadlock are no row. The overview's `needs_you` is the number of these rows, so the tab
// title, the sidebar badge, the top-bar chip, the Work page's Needs-you group and the Tasks page's section
// (web/src/views/task-work.tsx) agree.

import { FAILED_PHASES, phaseOf } from "../core/phase.js";
import { AGENT_NEEDS_HUMAN, blockingRunKind } from "../core/policy.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { LIST_LIMIT } from "./list.js";

/**
 * The number of Needs-you rows: every open item blocked on the budget, every open item blocked on a person except a
 * failed run's and a triage run's ask (store reads only; the runs only of an item an agent asked from), plus one per
 * system action in `checks`.
 */
export async function needsYouCount(store: Pick<FactoryStore, "countWorkItemsWhere" | "listWorkItemsWhere" | "listRuns">, checks: readonly unknown[]): Promise<number> {
  let items = await store.countWorkItemsWhere({ blocked_on: "budget", exclude_closed: true });
  for (const it of await store.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, limit: LIST_LIMIT })) {
    if (FAILED_PHASES.has(phaseOf(it))) continue;
    if (it.blocked_reason === AGENT_NEEDS_HUMAN && blockingRunKind(it.blocked_reason, await store.listRuns(it.id)) === "triage") continue;
    items++;
  }
  return items + checks.length;
}
