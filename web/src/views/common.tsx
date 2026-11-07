import { useEffect, useState } from "react";
import type { ItemRow, QueueRow, RunRow } from "../api.js";
import { Badge, Empty, Table, Td } from "../components/ui/parts.js";
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
      <a href={source.link} target="_blank" rel="noreferrer" className="shrink-0 text-zinc-500 tabular-nums hover:underline">
        {shortSource(source.id)}
      </a>
      <Link href={itemPath(id)} className="truncate font-medium hover:underline">
        {title ?? source.id}
      </Link>
    </span>
  );
}

export function ItemsTable({ items, now, label, empty }: { items: readonly ItemRow[]; now: number; label: string; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table label={label} head={["Item", "State", "Why", "Since", "PR"]}>
      {items.map((it) => (
        <tr key={it.id} data-key={it.id}>
          <Td className="max-w-md">
            <ItemTitle id={it.id} title={it.title} source={it.source} />
          </Td>
          <Td>
            <Badge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</Badge>
          </Td>
          <Td className="text-zinc-600 dark:text-zinc-400">{it.badges.join(" · ") || it.blocked_reason || "–"}</Td>
          <Td className="tabular-nums whitespace-nowrap">{ago(it.since, now)}</Td>
          <Td className="tabular-nums">
            {it.pr_url ? (
              <a href={it.pr_url} target="_blank" rel="noreferrer" className="hover:underline">
                #{it.pr_number}
              </a>
            ) : (
              "–"
            )}
          </Td>
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
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} /> : <Link href={itemPath(r.work_item_id)}>{r.work_item_id}</Link>}</Td>
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
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} /> : <Link href={itemPath(q.work_item_id)}>{q.work_item_id}</Link>}</Td>
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
