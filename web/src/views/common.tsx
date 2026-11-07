import { useEffect, useState } from "react";
import type { ItemRow, Overview, QueueRow, RunRow } from "../api.js";
import { Badge, Empty, Table, Td } from "../components/ui/parts.js";
import { cn } from "../lib/cn.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { LEVEL_LABELS, ago, shortSource, until } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

/** Date.now(), ticking each second, for "Ns ago" texts. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** An item's title (or its source id) linking to its page, with the source link beside it. */
export function ItemTitle({ id, title, source }: { id: string; title: string | null; source: { id: string; link: string } }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <a href={source.link} target="_blank" rel="noreferrer" className={cn("shrink-0 tabular-nums", LINK_CLASS)}>
        {shortSource(source.id)}
      </a>
      <Link href={itemPath(id)} className={cn("truncate font-medium", LINK_CLASS)}>
        {title ?? source.id}
      </Link>
    </span>
  );
}

/** A link out to GitHub; only drawn for the github plugin. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * Needs you and Work items. The title links to the item's page; the Item cell has no link out. The Issue and PR
 * columns exist only when the GitHub plugin is in use (`plugins` from the overview).
 */
export function ItemsTable({ items, now, label, empty, plugins }: { items: readonly ItemRow[]; now: number; label: string; empty: string; plugins?: Overview["plugins"] }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  const showIssue = plugins?.issues === "github";
  const showPr = plugins?.prs === "github";
  const head = ["Item", "State", "Why", "Since", ...(showIssue ? ["Issue"] : []), ...(showPr ? ["PR"] : [])];
  return (
    <Table label={label} head={head}>
      {items.map((it) => (
        <tr key={it.id} data-key={it.id}>
          <Td className="max-w-md">
            <Link href={itemPath(it.id)} className={cn("block truncate font-medium", LINK_CLASS)}>
              {it.title ?? it.id}
            </Link>
          </Td>
          <Td>
            <Badge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</Badge>
          </Td>
          <Td className="text-zinc-600 dark:text-zinc-400">{it.badges.join(" · ") || it.blocked_reason || "–"}</Td>
          <Td className="tabular-nums whitespace-nowrap">{ago(it.since, now)}</Td>
          {showIssue && <Td className="tabular-nums">{it.issue ? <Ext href={it.issue.url}>#{it.issue.number}</Ext> : "–"}</Td>}
          {showPr && (
            <Td className="tabular-nums">
              {it.pr_number === null ? "–" : it.pr_url ? <Ext href={it.pr_url}>#{it.pr_number}</Ext> : `#${it.pr_number}`}
            </Td>
          )}
        </tr>
      ))}
    </Table>
  );
}

/** Running runs with their item, owner and heartbeat. */
export function RunningTable({ runs, items, now }: { runs: readonly RunRow[]; items: ReadonlyMap<string, ItemRow>; now: number }) {
  const running = runs.filter((r) => r.status === "running");
  if (running.length === 0) return <Empty>No run is running. Queued runs start when a worker is free.</Empty>;
  return (
    <Table label="Running now" head={["Item", "Run", "Attempt", "Worker", "Running for", "Heartbeat"]}>
      {running.map((r) => {
        const it = items.get(r.work_item_id);
        return (
          <tr key={r.id}>
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} /> : <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{r.work_item_id}</Link>}</Td>
            <Td>{r.kind}</Td>
            <Td className="tabular-nums">{r.attempt}</Td>
            <Td className="font-mono text-xs">{r.owner ?? "–"}</Td>
            <Td className="tabular-nums">{ago(r.started_at, now)}</Td>
            <Td className="tabular-nums">{ago(r.heartbeat_at, now)} ago</Td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Queued runs in claim order, with their item and when each may start. */
export function QueueTable({ queue, items, now, limit }: { queue: readonly QueueRow[]; items: ReadonlyMap<string, ItemRow>; now: number; limit?: number }) {
  if (queue.length === 0) return <Empty>The queue is empty.</Empty>;
  const shown = limit ? queue.slice(0, limit) : queue;
  return (
    <Table label="Queue" head={["#", "Item", "Run", "Attempt", "Queued", "Starts"]}>
      {shown.map((q) => {
        const it = items.get(q.work_item_id);
        return (
          <tr key={q.id}>
            <Td className="tabular-nums">{q.position}</Td>
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} /> : <Link href={itemPath(q.work_item_id)} className={LINK_CLASS}>{q.work_item_id}</Link>}</Td>
            <Td>{q.kind}</Td>
            <Td className="tabular-nums">{q.attempt}</Td>
            <Td className="tabular-nums">{ago(q.created_at, now)} ago</Td>
            <Td className="tabular-nums">{until(q.not_before, now)}</Td>
          </tr>
        );
      })}
    </Table>
  );
}
