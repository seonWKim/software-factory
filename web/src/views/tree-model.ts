// The Work items tree's pure model (design §9): the filter and the tree builder. tree.tsx draws it.

import { filterShowsFinished, groupOf, inStateFilter } from "../../../src/shared/states.js";
import type { ItemRow } from "../api.js";

export interface TreeNode {
  item: ItemRow;
  children: TreeNode[];
  /** True when the item only shows as the parent of a match. */
  context: boolean;
}

export const issueNumber = (it: ItemRow): number | null => {
  const m = /#(\d+)$/.exec(it.source.id);
  return m ? Number(m[1]) : null;
};

/** A Finished row (merged, closed or rejected): hidden unless asked for. */
export const isFinished = (it: ItemRow): boolean => groupOf(it.item_phase) === "finished";

/** True when the title or the source id holds the search text (a leading # is optional). */
function inSearch(it: ItemRow, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return true;
  return (it.title ?? "").toLowerCase().includes(needle) || it.source.id.toLowerCase().includes(needle);
}

export interface TreeFilter {
  state: string | null;
  q: string;
  showClosed: boolean;
  /** System items (the self-improvement run's bookkeeping item, state `system`) show only when set. */
  showSystem?: boolean;
  /** Only these items (a link from Failures names them); closed ones show too. */
  ids?: ReadonlySet<string> | null;
}

/**
 * Whether a row passes the filters, as the list's server filter reads them (src/shared/states.ts inStateFilter): a
 * group, one state, or none. Finished rows only with Show closed or a Finished filter; system items only with Show system items.
 */
export function itemMatches(it: ItemRow, f: TreeFilter): boolean {
  if (f.ids) return f.ids.has(it.id) && inSearch(it, f.q);
  if (it.item_phase === "system" && !f.showSystem) return false;
  if (isFinished(it) && !f.showClosed && !filterShowsFinished(f.state)) return false;
  return (f.state === null || inStateFilter(it.item_phase, f.state)) && inSearch(it, f.q);
}

/**
 * The tree of the rows that match, each once. A phase sits under its split parent, in phase order, whatever it
 * waits for; a match whose parent is in the list shows that parent for context. Roots keep the API's order.
 */
export function buildTree(rows: readonly ItemRow[], f: TreeFilter): TreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shown = new Set<string>();
  const matched = new Set<string>();
  for (const r of rows) {
    if (!itemMatches(r, f)) continue;
    matched.add(r.id);
    for (let cur: ItemRow | undefined = r; cur && !shown.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) shown.add(cur.id);
  }
  const node = (it: ItemRow): TreeNode => ({
    item: it,
    context: !matched.has(it.id),
    children: rows
      .filter((c) => c.parent_id === it.id && shown.has(c.id))
      .sort((a, b) => (a.phase ?? Infinity) - (b.phase ?? Infinity) || (issueNumber(a) ?? 0) - (issueNumber(b) ?? 0))
      .map(node),
  });
  return rows.filter((r) => shown.has(r.id) && !(r.parent_id && byId.has(r.parent_id))).map(node);
}

/** The ids of every row that has children. */
export function parentIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length > 0 ? [n.item.id, ...parentIds(n.children)] : []));
}

/** The expanded rows when nothing is saved: every parent that has an open phase. */
export function defaultExpanded(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.some((c) => !isFinished(c.item)) ? [n.item.id, ...defaultExpanded(n.children)] : defaultExpanded(n.children)));
}
