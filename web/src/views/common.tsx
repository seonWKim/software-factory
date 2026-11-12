import { useEffect, useState } from "react";
import { API, type ItemRow, type MergeCheckView, type Overview, type QueueRow, type RunRow, type Session, type Why, mergeCheckLabel, showsMerge, useApi } from "../api.js";
import { IdDetails } from "../components/ui/copy.js";
import { Badge, Empty, Table, Td, Tr } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { LEVEL_LABELS, ago, isHttpUrl, isWorkerId, shortSource, stateAndNext, until, workerName } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { MergeButton, NeedCommands } from "./item-commands.js";

/** Date.now(), ticking each second, for "Ns ago" texts. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The viewer: the factory user the page's commands act as (the session's actor), null while unknown. */
export function useViewer(): string | null {
  return useApi<Session>(API.session, false).data?.actor ?? null;
}

/** A worker as "worker N" (its slot number), the full ID behind it (decision 3 of the readable-names change). */
export function WorkerName({ id }: { id: string | null | undefined }) {
  if (!id) return <>–</>;
  return <IdDetails label={workerName(id)} id={id} what="worker ID" />;
}

/**
 * A person or process by ID: the factory, a worker ("worker N"), "you" when it is the viewer (the owner, on a
 * one-owner factory), else the stored display name or "a person"; the full ID behind it.
 */
export function PersonName({ id, name, viewer }: { id: string | null; name?: string | null | undefined; viewer: string | null }) {
  if (!id || id === "system") return <>{t("person.factory")}</>;
  if (isWorkerId(id)) return <WorkerName id={id} />;
  return <IdDetails label={id === viewer ? t("person.you") : (name || t("person.other"))} id={id} what="user ID" />;
}

/**
 * The item's source id in short form (`#192`, `30331a68`), linked to the source; the full id shows on hover. With
 * `itemId`, a source with no web address (a local item's `local:` link) links to the item's page instead.
 */
export function SourceLink({ source, className, itemId }: { source: { id: string; link: string }; className?: string; itemId?: string }) {
  if (itemId !== undefined && !isHttpUrl(source.link)) {
    return (
      <Link href={itemPath(itemId)} title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", LINK_CLASS, className)}>
        {shortSource(source.id)}
      </Link>
    );
  }
  return (
    <a href={source.link} target="_blank" rel="noreferrer" title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", LINK_CLASS, className)}>
      {shortSource(source.id)}
    </a>
  );
}

/**
 * An item's title (or its short source id) linking to its page, with the source link beside it. `itemPage`: a source
 * with no web address links to the item page (the app's tables set it; the stored-link default goes once its last
 * test, tests/ui-source-id.test.tsx, moves to it).
 */
export function ItemTitle({ id, title, source, itemPage = false }: { id: string; title: string | null; source: { id: string; link: string }; itemPage?: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <SourceLink source={source} className="shrink-0" {...(itemPage ? { itemId: id } : {})} />
      <Link href={itemPath(id)} className={cn("truncate font-medium", LINK_CLASS)}>
        {title ?? shortSource(source.id)}
      </Link>
    </span>
  );
}

/** A ready-to-merge item's merge check label; the conflicting file names show on hover. */
export function MergeCheckNote({ check }: { check: MergeCheckView }) {
  const tone = check.state === "conflicts" ? "text-pill-bad-fg" : check.state === "mergeable" ? "text-pill-ok-fg" : "text-text-2";
  return (
    <span data-merge-check={check.state} className={cn("ml-2 text-xs whitespace-nowrap", tone)} {...(check.conflicts.length > 0 ? { title: check.conflicts.join("\n") } : {})}>
      {mergeCheckLabel(check)}
    </span>
  );
}

/** `#N` not part of `owner/name#N`, as the server reads refs (src/ui/why.ts). */
const REF = /(?<![\w./-])#(\d+)\b/g;

/** The why sentence, each `#N` it names (from `refs`) linked to that issue when the API gave a `ref_url`. */
export function WhyText({ why }: { why: Why }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of why.text.matchAll(REF)) {
    const n = Number(m[1]);
    if (!why.ref_url || !why.refs.includes(n)) continue;
    parts.push(why.text.slice(last, m.index));
    parts.push(<a key={m.index} href={`${why.ref_url}${n}`} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{n}</a>);
    last = m.index + m[0].length;
  }
  parts.push(why.text.slice(last));
  return <span data-why={why.code}>{parts}</span>;
}

/**
 * A Needs-you row's reason (the same words as the classic page). It links to the item page at the factory's newest
 * thread entry, when the item has one. The row's command buttons (NeedCommands) come after it.
 */
function NeedText({ it, need }: { it: ItemRow; need: NonNullable<ItemRow["need"]> }) {
  // No stored reason: the item's state and what moves it next, never "no reason".
  const reason = it.blocked_reason === null ? stateAndNext(it.stage, it.commands) : need.reason;
  return (
    <span data-need>
      {need.anchor ? <Link href={`${itemPath(it.id)}#${need.anchor}`} className={LINK_CLASS}>{reason}</Link> : reason}
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
 * Needs you and Work items. The title links to the item's page; the Item cell has no link out. The Issue column
 * exists only when the GitHub plugin is in use (`plugins` from the overview); the PR column always shows. `actions`
 * (Needs you): each row gets its command buttons and, waiting for its merge, the Merge button beside its reason.
 */
export function ItemsTable({ items, now, label, empty, plugins, actions = false }: { items: readonly ItemRow[]; now: number; label: string; empty: string; plugins?: Overview["plugins"]; actions?: boolean }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  const showIssue = plugins?.issues === "github";
  const head = [t("col.item"), t("col.state"), t("col.why"), t("col.since"), ...(showIssue ? [t("col.issue")] : []), t("col.pr"), ...(actions ? [t("commands.label")] : [])];
  // Needs-you rows centre every cell on the row's buttons (the cell's own top alignment is overridden).
  const mid = actions ? "align-middle!" : "";
  return (
    <Table label={label} head={head}>
      {items.map((it) => (
        <Tr key={it.id} data-key={it.id}>
          <Td className={cn("max-w-md", mid)}>
            <Link href={itemPath(it.id)} className={cn("block font-medium sm:truncate", LINK_CLASS)}>
              {it.title ?? shortSource(it.source.id)}
            </Link>
          </Td>
          <Td className={mid}>
            <Badge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</Badge>
            {it.merge_check && <MergeCheckNote check={it.merge_check} />}
          </Td>
          <Td className={cn("text-text-2", mid)}>
            {it.need ? <NeedText it={it} need={it.need} /> : it.why ? <WhyText why={it.why} /> : it.badges.join(" · ") || it.blocked_reason || "–"}
          </Td>
          <Td className={cn("tabular-nums whitespace-nowrap", mid)}>{ago(it.since, now)}</Td>
          {showIssue && <Td className={cn("tabular-nums", mid)}>{it.issue ? <Ext href={it.issue.url}>#{it.issue.number}</Ext> : "–"}</Td>}
          <Td className={cn("tabular-nums", mid)}>
            {it.change_ref === null ? "–" : it.change_url ? <Ext href={it.change_url}>#{it.change_ref}</Ext> : `#${it.change_ref}`}
          </Td>
          {actions && (
            <Td className={mid}>
              <span className="inline-flex items-center gap-2">
                {showsMerge(it.merge) && <MergeButton id={it.id} source={it.source.type} merge={it.merge} />}
                {(it.commands?.length ?? 0) > 0 && <NeedCommands id={it.id} title={it.title ?? it.id} commands={it.commands!} pr={it.change_ref} />}
              </span>
            </Td>
          )}
        </Tr>
      ))}
    </Table>
  );
}

/** Running runs with their item, owner and heartbeat. */
export function RunningTable({ runs, items, now }: { runs: readonly RunRow[]; items: ReadonlyMap<string, ItemRow>; now: number }) {
  const running = runs.filter((r) => r.status === "running");
  if (running.length === 0) return <Empty>{t("running.empty")}</Empty>;
  return (
    <Table label={t("running.label")} head={[t("col.item"), t("col.run"), t("col.attempt"), t("col.worker"), t("col.runningFor"), t("col.heartbeat")]}>
      {running.map((r) => {
        const it = items.get(r.work_item_id);
        return (
          <Tr key={r.id} data-key={r.id}>
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} itemPage /> : <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{r.work_item_id}</Link>}</Td>
            <Td>{r.kind}</Td>
            <Td className="tabular-nums">{r.attempt}</Td>
            <Td><WorkerName id={r.owner} /></Td>
            <Td className="tabular-nums">{ago(r.started_at, now)}</Td>
            <Td className="tabular-nums">{t("time.ago", { time: ago(r.heartbeat_at, now) })}</Td>
          </Tr>
        );
      })}
    </Table>
  );
}

/** Queued runs in claim order, with their item and when each may start: "now" or its retry time, else why it waits. */
export function QueueTable({ queue, items, now, limit }: { queue: readonly QueueRow[]; items: ReadonlyMap<string, ItemRow>; now: number; limit?: number }) {
  if (queue.length === 0) return <Empty>{t("queue.empty")}</Empty>;
  const shown = limit ? queue.slice(0, limit) : queue;
  return (
    <Table label={t("page.queue")} head={["#", t("col.item"), t("col.run"), t("col.attempt"), t("col.queued"), t("col.starts")]}>
      {shown.map((q) => {
        const it = items.get(q.work_item_id);
        return (
          <Tr key={q.id} data-key={q.id}>
            <Td className="tabular-nums">{q.position}</Td>
            <Td className="max-w-md">{it ? <ItemTitle id={it.id} title={it.title} source={it.source} itemPage /> : <Link href={itemPath(q.work_item_id)} className={LINK_CLASS}>{q.work_item_id}</Link>}</Td>
            <Td>{q.kind}</Td>
            <Td className="tabular-nums">{q.attempt}</Td>
            <Td className="tabular-nums">{t("time.ago", { time: ago(q.created_at, now) })}</Td>
            <Td className="tabular-nums">{q.why && q.why.code !== "queued" && q.why.code !== "not_before" ? <WhyText why={q.why} /> : until(q.not_before, now)}</Td>
          </Tr>
        );
      })}
    </Table>
  );
}
