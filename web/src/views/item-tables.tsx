import { ExternalLink } from "lucide-react";
import type { ItemRow as Item, Overview, QueueRow, RunRow } from "../api.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { t } from "../i18n/index.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { elapsed } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { StatusBadge } from "../components/ui/badge.js";
import type { MenuItem } from "../components/ui/menu.js";
import { When } from "./display.js";
import { ItemTable, type ItemTableRow } from "./item-row.js";
import { ItemTitle, MergeCheckNote, PrLink } from "./item-links.js";
import { InteractiveBadge, isInteractiveRun, runKindLabel, runTitle, tryOf } from "./run-kind.js";
import { WhyText } from "./why-text.js";
import { WorkerName } from "./who.js";

/** The item cell of the running and queue rows: the title, or the column label until the item is loaded. Never an id. */
function RunItemCell({ id, item }: { id: string; item: Item | undefined }) {
  return item ? <ItemTitle id={id} title={item.title} /> : <Link href={itemPath(id)} className={LINK_CLASS}>{t("col.item")}</Link>;
}

/**
 * The Work items list as a table of compact ItemRows (design 09-dashboard-system): the state, the title (the link to
 * the item's page), why, the worker, since when, the PR as the one action, and the "⋯" menu with Copy ID (and the
 * issue, only with the GitHub plugin, `plugins` from the overview). Below `sm` each row is a card.
 */
export function ItemsTable({ items, now, label, empty, plugins }: { items: readonly Item[]; now: number; label: string; empty: string; plugins?: Overview["plugins"] }) {
  const rows = items.map((it): ItemTableRow => ({
    key: it.id,
    itemId: it.id,
    "data-key": it.id,
    badge: (
      <>
        <StatusBadge state={it.item_phase} />
        {isInteractiveRun(it.run) && <> <InteractiveBadge /></>}
        {it.merge_check && <MergeCheckNote check={it.merge_check} />}
      </>
    ),
    title: it.title ?? t("item.untitled"),
    titleRaw: it.title !== null,
    href: itemPath(it.id),
    why: it.why ? <WhyText why={it.why} /> : it.blocked_reason || undefined,
    worker: it.run?.worker_id ? <WorkerName id={it.run.worker_id} /> : undefined,
    age: <When at={it.since} now={now} />,
    action: it.change_ref === null ? undefined : <PrLink number={it.change_ref} url={it.change_url} />,
    menuLabel: t("items.more", { title: it.title ?? t("item.untitled") }),
    menuItems: plugins?.issues === "github" && it.issue ? [openItem(t("items.openIssue", { number: it.issue.number }), it.issue.url)] : [],
    copyId: it.id,
  }));
  return <ItemTable label={label} head={head()} rows={rows} empty={empty} />;
}

/** The columns of the Work and Runners tables: an ItemRow's slots. */
const head = () => ({ badge: t("col.state"), title: t("col.item"), why: t("col.why"), project: t("tasks.project"), worker: t("col.worker"), age: t("col.since"), actions: t("col.pr") });

/** A "⋯" menu item that opens `url` in a new tab. */
const openItem = (label: string, url: string): MenuItem => ({ label, icon: ExternalLink, onSelect: () => void window.open(url, "_blank", "noopener,noreferrer") });


/**
 * Runners' running runs as compact ItemRows: the run's state, its item's title (the link; the column label until the
 * items are read, never an ID), the run and its heartbeat as why, the worker, how long it has run, and Copy ID.
 */
export function RunningTable({ runs, items, now }: { runs: readonly RunRow[]; items: ReadonlyMap<string, Item>; now: number }) {
  const rows = runs.filter((r) => r.status === "running").map((r): ItemTableRow => {
    const item = items.get(r.work_item_id);
    const title = item ? (item.title ?? t("item.untitled")) : t("col.item");
    return {
      key: r.id,
      itemId: r.work_item_id,
      "data-key": r.id,
      badge: <StatusBadge state={r.status} />,
      title,
      titleRaw: item?.title != null,
      href: itemPath(r.work_item_id),
      why: <>{runTitle(r)} · <When at={r.heartbeat_at} now={now} label="running.heartbeat" /></>,
      worker: <WorkerName id={r.owner} />,
      age: r.started_at ? elapsed(now - Date.parse(r.started_at)) : undefined,
      menuLabel: t("items.more", { title }),
      copyId: r.work_item_id,
    };
  });
  return <ItemTable label={t("running.label")} head={{ ...head(), age: t("col.runningFor"), actions: t("col.actions") }} rows={rows} empty={t("running.empty")} />;
}

/** Queued runs in claim order, with their item and when each may start: "now" or its retry time, else why it waits. */
export function QueueTable({ queue, items, now, limit }: { queue: readonly QueueRow[]; items: ReadonlyMap<string, Item>; now: number; limit?: number }) {
  const columns: Column<QueueRow>[] = [
    { key: "position", header: "#", numeric: false, className: "tabular-nums" },
    { key: "item", header: t("col.item"), className: "max-w-md", render: (q) => <RunItemCell id={q.work_item_id} item={items.get(q.work_item_id)} /> },
    { key: "kind", header: t("col.run"), render: (r) => runKindLabel(r.kind) },
    { key: "attempt", header: t("col.attempt"), numeric: false, className: "tabular-nums", render: (r) => tryOf(r.attempt) },
    { key: "queued", header: t("col.queued"), className: "tabular-nums", render: (q) => <When at={q.created_at} now={now} /> },
    { key: "starts", header: t("col.starts"), className: "tabular-nums", render: (q) => (q.why && q.why.code !== "queued" && q.why.code !== "not_before" ? <WhyText why={q.why} /> : q.not_before && Date.parse(q.not_before) > now ? <When at={q.not_before} now={now} /> : t("queue.now")) },
  ];
  return <DataTable label={t("queue.title")} columns={columns} rows={limit ? queue.slice(0, limit) : queue} rowKey={(q) => q.id} empty={t("queue.empty")} dataKey />;
}
