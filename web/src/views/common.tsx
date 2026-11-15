import { useEffect, useState } from "react";
import { API, type ItemRow, type MergeCheckView, type Overview, type QueueRow, type RunRow, type Session, type Why, mergeCheckLabel, showsMerge, useApi } from "../api.js";
import { IdDetails } from "../components/ui/copy.js";
import { Badge, Empty, Table, Td, Tr } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { LEVEL_LABELS, NEEDS_YOU_LEVELS, ago, isHttpUrl, isWorkerId, shortSource, until, workerName } from "../lib/format.js";
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

/** An item's title linking to its page, wrapping at any width; "Untitled item" when it has none. */
export function ItemTitle({ id, title }: { id: string; title: string | null }) {
  return (
    <Link href={itemPath(id)} className={cn("font-medium", LINK_CLASS)}>
      {title ?? t("item.untitled")}
    </Link>
  );
}

/** The item cell of the running and queue rows: the title, or the column label until the item is loaded. Never an id. */
function RunItemCell({ id, item }: { id: string; item: ItemRow | undefined }) {
  return item ? <ItemTitle id={id} title={item.title} /> : <Link href={itemPath(id)} className={LINK_CLASS}>{t("col.item")}</Link>;
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

const PATH = String.raw`[\w@~-]+(?:\.[\w@~-]+)*(?:\/[\w@~-]+(?:\.[\w@~-]+)*)*`;
/** `/retry +paths <path>...` in a why text: the reply that allows those paths and retries. */
const ALLOW = new RegExp(String.raw`\/retry \+paths (?<paths>${PATH}(?: ${PATH})*)`, "g");
/** What the why text names besides `#N`: an item ID, a path. */
const TOKEN = new RegExp(String.raw`(?<id>\bwi_[0-9a-z]+\b)|(?<path>(?<![\w./@:~-])[\w@~-]+(?:\/[\w@~.-]*[\w@~-])+(?![\w#]))`, "g");

/** A path is shown in code style when it has a file extension or at least two slashes (so "and/or" stays text). */
const isPath = (s: string): boolean => s.split("/").length > 2 || /\.\w+$/.test(s);
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The "Allow <file> and retry" entries a why text offers: one per `/retry +paths ...` it names, with the note that sends it. */
export function allowEntries(text: string): { label: string; note: string }[] {
  return [...text.matchAll(ALLOW)].map((m) => {
    const paths = m.groups!.paths!;
    return { label: t("why.allow", { file: paths.split(" ").map(basename).join(", ") }), note: `+paths ${paths}` };
  });
}

/**
 * The why sentence for people. Each `#N` it names (from `refs`) links to that issue when the API gave a `ref_url`;
 * an item ID links to the item page; a path is in code style. The stored text is never changed.
 */
export function WhyText({ why }: { why: Pick<Why, "text" | "refs" | "ref_url"> & { code?: string } }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const text = (to: number, from = last) => {
    // `#N` links inside a stretch of plain text.
    let at = from;
    for (const m of why.text.slice(from, to).matchAll(REF)) {
      const n = Number(m[1]);
      if (!why.ref_url || !why.refs.includes(n)) continue;
      parts.push(why.text.slice(at, from + m.index));
      parts.push(<a key={`ref${from + m.index}`} href={`${why.ref_url}${n}`} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{n}</a>);
      at = from + m.index + m[0].length;
    }
    parts.push(why.text.slice(at, to));
  };
  for (const m of why.text.matchAll(TOKEN)) {
    const g = m.groups!;
    const piece = g.id ?? g.path!;
    if (g.path && !isPath(piece)) continue;
    text(m.index);
    last = m.index + m[0].length;
    parts.push(g.id
      ? <Link key={`i${m.index}`} href={itemPath(piece)} data-why-item={piece} className={LINK_CLASS}>{piece}</Link>
      : <code key={`p${m.index}`} className="font-mono text-xs">{piece}</code>);
  }
  text(why.text.length);
  return <span data-why={why.code}>{parts}</span>;
}

/** The items list keyed by item ID. */
export const byId = (items: readonly ItemRow[] | undefined): Map<string, ItemRow> => new Map((items ?? []).map((i) => [i.id, i]));

/** What a Needs-you row asks of the owner: merge a PR, approve a spec, or answer or fix (everything else). */
export type NeedGroup = "merge" | "approve" | "answer";

/** The levels of an item that waits on the owner (the server's NEEDS_YOU): a stuck item waits on nobody's answer. */
const WAITING_LEVELS: readonly string[] = NEEDS_YOU_LEVELS.filter((l) => l !== "stuck");

/**
 * The items that wait on the owner, one Needs-you row each (src/ui/needs-you.ts): blocked on a person or the budget.
 * An item started past a deadlock is Blocked by another task and goes on by itself.
 */
export const needsYou = (items: readonly ItemRow[]): ItemRow[] => items.filter((i) => WAITING_LEVELS.includes(i.level));

export function needGroup(it: ItemRow): NeedGroup {
  if (showsMerge(it.merge) || it.level === "ready_to_merge") return "merge";
  return it.level === "needs_approval" || it.commands?.some((c) => c.name === "approve" && c.allowed) ? "approve" : "answer";
}

/** A link out to GitHub; only drawn for the github plugin. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/** The Work items table. The title links to the item's page; the Item cell has no link out. The Issue column exists only when the GitHub plugin is in use (`plugins` from the overview); the PR column always shows. */
export function ItemsTable({ items, now, label, empty, plugins }: { items: readonly ItemRow[]; now: number; label: string; empty: string; plugins?: Overview["plugins"] }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  const showIssue = plugins?.issues === "github";
  const head = [t("col.item"), t("col.state"), t("col.why"), t("col.since"), ...(showIssue ? [t("col.issue")] : []), t("col.pr")];
  return (
    <Table label={label} head={head}>
      {items.map((it) => (
        <Tr key={it.id} data-key={it.id}>
          <Td className="max-w-md">
            <Link href={itemPath(it.id)} className={cn("block font-medium sm:truncate", LINK_CLASS)}>
              {it.title ?? shortSource(it.source.id)}
            </Link>
          </Td>
          <Td>
            <Badge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</Badge>
            {it.merge_check && <MergeCheckNote check={it.merge_check} />}
          </Td>
          <Td className="text-text-2">{it.why ? <WhyText why={it.why} /> : it.badges.join(" · ") || it.blocked_reason || "–"}</Td>
          <Td className="tabular-nums whitespace-nowrap">{ago(it.since, now)}</Td>
          {showIssue && <Td className="tabular-nums">{it.issue ? <Ext href={it.issue.url}>#{it.issue.number}</Ext> : "–"}</Td>}
          <Td className="tabular-nums">
            {it.change_ref === null ? "–" : it.change_url ? <Ext href={it.change_url}>#{it.change_ref}</Ext> : `#${it.change_ref}`}
          </Td>
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
            <Td className="max-w-md"><RunItemCell id={r.work_item_id} item={it} /></Td>
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
    <Table label={t("queue.title")} head={["#", t("col.item"), t("col.run"), t("col.attempt"), t("col.queued"), t("col.starts")]}>
      {shown.map((q) => {
        const it = items.get(q.work_item_id);
        return (
          <Tr key={q.id} data-key={q.id}>
            <Td className="tabular-nums">{q.position}</Td>
            <Td className="max-w-md"><RunItemCell id={q.work_item_id} item={it} /></Td>
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
