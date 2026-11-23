// The Work items tree (design §9): a split parent with its phases in phase order, each item once. The model
// (buildTree, itemMatches) is pure; ItemsTree draws it with react-aria-components' Tree, which
// brings the keyboard use (arrow keys move focus, right expands, left collapses) and the treegrid roles.

import { useState } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { ItemRow as Item } from "../api.js";
import { buttonClass } from "../components/ui/button.js";
import { FOCUS } from "../components/ui/control.js";
import { DisclosureChevron } from "../components/ui/disclosure.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { duration } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { PrLink, When, WhyText, WorkerName, runKindLabel } from "./common.js";
import { ItemRow } from "./item-row.js";
import { StatusBadge } from "../components/ui/badge.js";
import { type TreeNode, issueNumber } from "./tree-model.js";

/** Browser storage keys: the chosen view, and the expanded rows (a list of item ids; absent: the default). */
export const VIEW_KEY = "sf.items.view";
export const EXPANDED_KEY = "sf.items.expanded";

export type View = "tree" | "list";

/** The item another item waits for (a dependency, an earlier phase or a coordination hold), or null when none or not in the list. */
function waitsFor(it: Item, byNumber: ReadonlyMap<number, Item>, byId: ReadonlyMap<string, Item>): Item | null {
  if (it.claim?.decision === "held" && !it.claim.approved && it.run?.status === "queued" && it.claim.holder) {
    const n = /^#(\d+)$/.exec(it.claim.holder)?.[1];
    return (it.claim.holder_id ? byId.get(it.claim.holder_id) : undefined) ?? (n ? (byNumber.get(Number(n)) ?? null) : null);
  }
  const n = it.waiting_on_number;
  const waits = it.why?.code === "dependency" || (it.why?.code === "phase" && !!it.parent_id);
  return waits && n ? (byNumber.get(n) ?? null) : null;
}

/**
 * One item's row, a compact ItemRow: its state, its title (the link to it; never its id, design-system/writing.md),
 * why it waits, the run and its worker, when it last changed, the PR as its action and Copy ID in "⋯". A blocked item's
 * state badge links to the item it waits for, named on hover, and its second line names that item.
 */
function Row({ node, now, byNumber, byId }: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, Item>; byId: ReadonlyMap<string, Item> }) {
  const it = node.item;
  const waits = waitsFor(it, byNumber, byId);
  const run = it.run;
  const badge = <StatusBadge state={it.item_phase} />;
  const title = it.title ?? t("item.untitled");
  const waitsTitle = waits ? (waits.title ?? t("item.untitled")) : "";
  return (
    <ItemRow
      layout="tree"
      variant="compact"
      itemId={it.id}
      className={cn(node.context && "text-text-2")}
      badge={waits ? (
        <Link href={itemPath(waits.id)} data-waits-for title={t("tree.waitsFor", { title: waitsTitle })} className={cn("rounded-pill", FOCUS)}>
          {badge}
        </Link>
      ) : (
        badge
      )}
      title={title}
      titleRaw={it.title !== null}
      href={itemPath(it.id)}
      why={it.why && <WhyText why={it.why} />}
      worker={run && (
        <span className="flex flex-wrap gap-x-2">
          {run && (
            <span className="whitespace-nowrap tabular-nums" data-run>
              {runKindLabel(run.kind)} #{run.attempt}
              {run.status === "queued" && run.position !== null && t("tree.queue", { position: run.position })}
              {run.started_at && run.status === "running" && ` · ${duration(now - Date.parse(run.started_at))}`}
            </span>
          )}
          {run?.worker_id && <WorkerName id={run.worker_id} />}
        </span>
      )}
      age={<When at={it.updated_at} now={now} />}
      action={it.change_ref !== null && <PrLink number={it.change_ref} url={it.change_url} />}
      menuLabel={t("items.more", { title })}
      copyId={it.id}
      second={waits && <span data-raw={waits.title !== null ? "" : undefined} className="break-words">{t("tree.heldBehind", { title: waitsTitle })}</span>}
    />
  );
}

/** The left padding of a row by its depth: none at the top level, 1rem more per level, the last step for anything deeper. */
const INDENT = ["pl-0", "pl-4", "pl-8", "pl-12", "pl-16"] as const;
const indentFor = (level: number) => INDENT[Math.min(Math.max(level, 1), INDENT.length) - 1];

function NodeItem(props: { node: TreeNode; now: number; byNumber: ReadonlyMap<number, Item>; byId: ReadonlyMap<string, Item> }) {
  const { node } = props;
  return (
    <TreeItem id={node.item.id} textValue={node.item.title ?? node.item.source.id} className="outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus">
      <TreeItemContent>
        {({ hasChildItems, isExpanded, level }) => (
          <div className={cn("flex items-start gap-1 border-b border-border pr-1", indentFor(level))}>
            {hasChildItems ? (
              // The design system's icon button (32px, ghost) around the Disclosure's chevron: the row's first line is 32px
              // already, so the row keeps its height.
              <Button slot="chevron" className={buttonClass({ variant: "ghost", size: "icon", className: "group text-text-2" })} aria-label={isExpanded ? t("tree.collapse") : t("tree.expand")}>
                <DisclosureChevron open={isExpanded} className="size-4" />
              </Button>
            ) : (
              <span className="w-8 shrink-0" aria-hidden />
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
  rows: readonly Item[];
  now: number;
  expanded: ReadonlySet<string>;
  onExpanded: (ids: Iterable<string>) => void;
}) {
  const byNumber = new Map<number, Item>();
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
