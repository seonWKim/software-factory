// The Work items tree (design §9): a split parent with its phases in phase order, each item once. The model
// (buildTree, itemMatches) is pure; ItemsTree draws it with react-aria-components' Tree, which
// brings the keyboard use (arrow keys move focus, right expands, left collapses) and the treegrid roles.

import { useState } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { ItemRow } from "../api.js";
import { FOCUS } from "../components/ui/control.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { LEVEL_LABELS, duration, shortSource } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { When, WhyText, WorkerName, runKindLabel } from "./common.js";
import { Badge } from "../components/ui/badge.js";
import { type TreeNode, issueNumber } from "./tree-model.js";

/** Browser storage keys: the chosen view, and the expanded rows (a list of item ids; absent: the default). */
export const VIEW_KEY = "sf.items.view";
export const EXPANDED_KEY = "sf.items.expanded";

export type View = "tree" | "list";

/** The item another item waits for (a dependency, an earlier phase or a coordination hold), or null when none or not in the list. */
function waitsFor(it: ItemRow, byNumber: ReadonlyMap<number, ItemRow>, byId: ReadonlyMap<string, ItemRow>): ItemRow | null {
  if (it.claim?.decision === "held" && !it.claim.approved && it.run?.status === "queued" && it.claim.holder) {
    const n = /^#(\d+)$/.exec(it.claim.holder)?.[1];
    return (it.claim.holder_id ? byId.get(it.claim.holder_id) : undefined) ?? (n ? (byNumber.get(Number(n)) ?? null) : null);
  }
  const n = it.waiting_on_number;
  const waits = it.why?.code === "dependency" || (it.why?.code === "phase" && !!it.parent_id);
  return waits && n ? (byNumber.get(n) ?? null) : null;
}

/**
 * One item's row: its title (the link to it; never its id, design-system/writing.md), its state, the run, the PR and
 * why it waits. A blocked item's state badge links to the item it waits for, named on hover.
 */
function Row({ node, now, byNumber, byId }: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, ItemRow>; byId: ReadonlyMap<string, ItemRow> }) {
  const it = node.item;
  const waits = waitsFor(it, byNumber, byId);
  const run = it.run;
  const badge = <Badge level={it.item_phase}>{LEVEL_LABELS[it.item_phase] ?? it.item_phase}</Badge>;
  return (
    <div className={cn("flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 py-1", node.context && "text-text-2")}>
      <Link href={itemPath(it.id)} className={cn("min-w-0 truncate font-medium", LINK_CLASS)}>{it.title ?? shortSource(it.source.id)}</Link>
      {waits ? (
        <Link href={itemPath(waits.id)} data-waits-for title={t("tree.waitsFor", { title: waits.title ?? shortSource(waits.source.id) })} className={cn("rounded-pill", FOCUS)}>
          {badge}
        </Link>
      ) : (
        badge
      )}
      {run && (
        <span className="text-xs whitespace-nowrap tabular-nums" data-run>
          {runKindLabel(run.kind)} #{run.attempt}
          {run.status === "queued" && run.position !== null && t("tree.queue", { position: run.position })}
          {run.started_at && run.status === "running" && ` · ${duration(now - Date.parse(run.started_at))}`}
        </span>
      )}
      {it.change_ref !== null && (
        it.change_url ? <a href={it.change_url} target="_blank" rel="noreferrer" className={cn("text-xs tabular-nums", LINK_CLASS)}>{t("tree.pr", { ref: it.change_ref })}</a> : <span className="text-xs tabular-nums">{t("tree.pr", { ref: it.change_ref })}</span>
      )}
      <span className="text-xs whitespace-nowrap tabular-nums text-text-2"><When at={it.updated_at} now={now} /></span>
      <span className="flex basis-full flex-wrap gap-x-2 text-xs text-text-2 sm:basis-auto sm:text-sm">
        {it.why && <WhyText why={it.why} />}
        {run?.worker_id && <WorkerName id={run.worker_id} />}
      </span>
    </div>
  );
}

/** The left padding of a row by its depth: none at the top level, 1rem more per level, the last step for anything deeper. */
const INDENT = ["pl-0", "pl-4", "pl-8", "pl-12", "pl-16"] as const;
const indentFor = (level: number) => INDENT[Math.min(Math.max(level, 1), INDENT.length) - 1];

function NodeItem(props: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, ItemRow>; byId: ReadonlyMap<string, ItemRow> }) {
  const { node } = props;
  return (
    <TreeItem id={node.item.id} textValue={node.item.title ?? node.item.source.id} className="outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus">
      <TreeItemContent>
        {({ hasChildItems, isExpanded, level }) => (
          <div className={cn("flex items-start gap-1 border-b border-border pr-1", indentFor(level))}>
            {hasChildItems ? (
              <Button slot="chevron" className="mt-1 w-5 shrink-0 text-text-2" aria-label={isExpanded ? t("tree.collapse") : t("tree.expand")}>
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
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  for (const r of rows) {
    const n = issueNumber(r);
    if (n !== null) byNumber.set(n, r);
  }
  return (
    <Tree
      aria-label={t("tree.label")}
      selectionMode="none"
      expandedKeys={expanded}
      onExpandedChange={(keys) => onExpanded([...keys].map(String))}
      className="rounded-control border border-border text-sm"
    >
      {nodes.map((n) => <NodeItem key={n.item.id} node={n} now={now} byNumber={byNumber} byId={byId} />)}
    </Tree>
  );
}
