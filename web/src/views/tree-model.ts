// The Work items tree's pure model (design §9): the filter and the tree builder. tree.tsx draws it.

import type { ItemRow } from "../api.js";
import { NEEDS_YOU_LEVELS } from "../lib/format.js";

/** The tree's own filter besides the API's levels: items held behind another item. */
export const HELD = "held";

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

const needsYou = (it: ItemRow) => (NEEDS_YOU_LEVELS as readonly string[]).includes(it.item_phase);

/** Held behind another item: a held claim, or a phase waiting for the phase before it. */
export function isHeld(it: ItemRow): boolean {
  return it.why?.code === "held" || (it.why?.code === "phase" && !!it.parent_id);
}

/** The state filter as the list's server filter reads it, applied to a row. */
function inState(it: ItemRow, state: string | null): boolean {
  if (state === null) return true;
  if (state === "needs") return needsYou(it);
  if (state === HELD) return isHeld(it);
  return it.item_phase === state;
}

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
  /** Only these items (a link from Failures names them); closed ones show too. */
  ids?: ReadonlySet<string> | null;
}

/** Whether a row passes the filters: closed rows only with Show closed (or the Closed filter). */
export function itemMatches(it: ItemRow, f: TreeFilter): boolean {
  if (f.ids) return f.ids.has(it.id) && inSearch(it, f.q);
  if (it.item_phase === "closed" && !f.showClosed && f.state !== "closed") return false;
  return inState(it, f.state) && inSearch(it, f.q);
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
  return nodes.flatMap((n) => (n.children.some((c) => c.item.item_phase !== "closed") ? [n.item.id, ...defaultExpanded(n.children)] : defaultExpanded(n.children)));
}
