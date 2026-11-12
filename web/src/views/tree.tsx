// The Work items tree (design §9): a split parent with its phases in phase order, each item once. The model
// (buildTree, itemMatches, summaryCounts) is pure; ItemsTree draws it with react-aria-components' Tree, which
// brings the keyboard use (arrow keys move focus, right expands, left collapses) and the treegrid roles.

import { useState } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { ItemRow } from "../api.js";
import { Badge } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import { LEVEL_LABELS, NEEDS_YOU_LEVELS, ago, shortSource } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { SourceLink, WhyText, WorkerName } from "./common.js";

/** Browser storage keys: the chosen view, and the expanded rows (a list of item ids; absent: the default). */
export const VIEW_KEY = "sf.items.view";
export const EXPANDED_KEY = "sf.items.expanded";

export type View = "tree" | "list";

/** The tree's own filter besides the API's levels: items held behind another item. */
export const HELD = "held";

export interface TreeNode {
  item: ItemRow;
  children: TreeNode[];
  /** True when the item only shows as the parent of a match. */
  context: boolean;
}

const issueNumber = (it: ItemRow): number | null => {
  const m = /#(\d+)$/.exec(it.source.id);
  return m ? Number(m[1]) : null;
};

const needsYou = (it: ItemRow) => (NEEDS_YOU_LEVELS as readonly string[]).includes(it.level);

/** Held behind another item: a held claim, or a phase waiting for the phase before it. */
export function isHeld(it: ItemRow): boolean {
  return it.why?.code === "held" || (it.why?.code === "phase" && !!it.parent_id);
}

/** The state filter as the list's server filter reads it, applied to a row. */
function inState(it: ItemRow, state: string | null): boolean {
  if (state === null) return true;
  if (state === "needs") return needsYou(it);
  if (state === HELD) return isHeld(it);
  return it.level === state;
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
}

/** Whether a row passes the filters: closed rows only with Show closed (or the Closed filter). */
export function itemMatches(it: ItemRow, f: TreeFilter): boolean {
  if (it.level === "closed" && !f.showClosed && f.state !== "closed") return false;
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
  return nodes.flatMap((n) => (n.children.some((c) => c.item.level !== "closed") ? [n.item.id, ...defaultExpanded(n.children)] : defaultExpanded(n.children)));
}

/** The counts of the summary line, over the open items: each is also a state filter. */
export function summaryCounts(rows: readonly ItemRow[]) {
  const open = rows.filter((r) => r.level !== "closed");
  return {
    running: open.filter((r) => r.level === "running").length,
    queued: open.filter((r) => r.level === "queued").length,
    held: open.filter(isHeld).length,
    needs: open.filter((r) => needsYou(r)).length,
  };
}

/** What an item waits for: the number to show and the item it names (null when it is not in the list). */
function waitsFor(it: ItemRow, byNumber: ReadonlyMap<number, ItemRow>): { label: string; id: string | null } | null {
  if (it.claim?.decision === "held" && !it.claim.approved && it.run?.status === "queued" && it.claim.holder) {
    const n = /^#(\d+)$/.exec(it.claim.holder)?.[1];
    return { label: it.claim.holder, id: it.claim.holder_id ?? (n ? (byNumber.get(Number(n))?.id ?? null) : null) };
  }
  const n = it.waiting_on_number;
  const waits = it.why?.code === "dependency" || (it.why?.code === "phase" && !!it.parent_id);
  return waits && n ? { label: `#${n}`, id: byNumber.get(n)?.id ?? null } : null;
}

const CHIP = "rounded-control border border-border-strong px-1.5 py-0.5 text-xs whitespace-nowrap";

function Row({ node, now, byNumber }: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, ItemRow> }) {
  const it = node.item;
  const waits = waitsFor(it, byNumber);
  const run = it.run;
  return (
    <div className={cn("flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 py-1", node.context && "text-text-2")}>
      <SourceLink source={it.source} itemId={it.id} className="shrink-0" />
      <Link href={itemPath(it.id)} className={cn("min-w-0 truncate font-medium", LINK_CLASS)}>{it.title ?? shortSource(it.source.id)}</Link>
      <Badge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</Badge>
      {waits && (
        waits.id ? (
          <Link href={itemPath(waits.id)} className={cn(CHIP, LINK_CLASS)} data-waits-for>waits for {waits.label}</Link>
        ) : (
          <span className={CHIP} data-waits-for>waits for {waits.label}</span>
        )
      )}
      {run && (
        <span className="text-xs whitespace-nowrap tabular-nums" data-run>
          {run.kind} #{run.attempt}
          {run.status === "queued" && run.position !== null && ` · queue ${run.position}`}
          {run.started_at && run.status === "running" && ` · ${ago(run.started_at, now)}`}
        </span>
      )}
      {it.change_ref !== null && (
        it.change_url ? <a href={it.change_url} target="_blank" rel="noreferrer" className={cn("text-xs tabular-nums", LINK_CLASS)}>PR #{it.change_ref}</a> : <span className="text-xs tabular-nums">PR #{it.change_ref}</span>
      )}
      <span className="text-xs whitespace-nowrap tabular-nums text-text-2">{ago(it.updated_at, now)}</span>
      <span className="flex basis-full flex-wrap gap-x-2 text-xs text-text-2 sm:basis-auto sm:text-sm">
        {it.why && <WhyText why={it.why} />}
        {run?.worker_id && <WorkerName id={run.worker_id} />}
      </span>
    </div>
  );
}

function NodeItem(props: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, ItemRow> }) {
  const { node } = props;
  return (
    <TreeItem id={node.item.id} textValue={node.item.title ?? node.item.source.id} className="outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus">
      <TreeItemContent>
        {({ hasChildItems, isExpanded }) => (
          <div className="flex items-start gap-1 border-b border-border px-1" style={{ paddingLeft: "calc(var(--tree-item-level, 1) * 1rem - 1rem)" }}>
            {hasChildItems ? (
              <Button slot="chevron" className="mt-1 w-5 shrink-0 text-text-2" aria-label={isExpanded ? "Collapse" : "Expand"}>
                {isExpanded ? "▾" : "▸"}
              </Button>
            ) : (
              <span className="w-5 shrink-0" aria-hidden />
            )}
            <Row {...props} />
          </div>
        )}
      </TreeItemContent>
      {node.children.map((c) => <NodeItem key={c.item.id} {...props} node={c} />)}
    </TreeItem>
  );
}

function loadExpanded(): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "null");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** The expanded rows, saved per browser from the first change on. */
export function useExpanded(defaults: readonly string[]): [ReadonlySet<string>, (ids: Iterable<string>) => void] {
  const [saved, setSaved] = useState<string[] | null>(loadExpanded);
  const set = (ids: Iterable<string>) => {
    const next = [...ids];
    setSaved(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
    } catch {
      // Storage is full or blocked: the choice lasts until reload.
    }
  };
  return [new Set(saved ?? defaults), set];
}

export function ItemsTree({ nodes, rows, now, expanded, onExpanded }: {
  nodes: readonly TreeNode[];
  rows: readonly ItemRow[];
  now: number;
  expanded: ReadonlySet<string>;
  onExpanded: (ids: Iterable<string>) => void;
}) {
  const byNumber = new Map<number, ItemRow>();
  for (const r of rows) {
    const n = issueNumber(r);
    if (n !== null) byNumber.set(n, r);
  }
  return (
    <Tree
      aria-label="Work items"
      selectionMode="none"
      expandedKeys={expanded}
      onExpandedChange={(keys) => onExpanded([...keys].map(String))}
      className="rounded-control border border-border text-sm"
    >
      {nodes.map((n) => <NodeItem key={n.item.id} node={n} now={now} byNumber={byNumber} />)}
    </Tree>
  );
}
