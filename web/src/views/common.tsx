import { type ReactNode, useEffect, useState } from "react";
import { API, type ItemRow as Item, type MergeCheckView, type Overview, type QueueRow, type RunRow, type Session, type Why, mergeCheckLabel, showsMerge, useApi } from "../api.js";
import { IdDetails } from "../components/ui/copy.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { ID_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { duration, isHttpUrl, isWorkerId, localDateTime, relativeTime, shortSource, whyText, workerName } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { StatusBadge } from "../components/ui/badge.js";
import { groupOf } from "../../../src/shared/states.js";
import type { MenuItem } from "../components/ui/menu.js";
import { ItemTable, type ItemTableRow } from "./item-row.js";

/** Date.now(), ticking each second, for "Ns ago" texts. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * A relative time in the one compact form (`relativeTime`), with the exact local time in the element's title. `label`
 * is a catalog text with `{time}` (and the `vars`) for a time inside a sentence ("started {time}"); "–" when there is no time.
 */
export function When({ at, now, label, vars }: { at: string | null | undefined; now: number; label?: MessageKey; vars?: Record<string, string | number> }) {
  if (!at) return <>{t("format.none")}</>;
  const time = relativeTime(at, now);
  return <time dateTime={at} title={localDateTime(at)}>{label ? t(label, { ...vars, time }) : time}</time>;
}

/** The raw fields of a row or card, behind one "Details" toggle: the only place a page shows a stored field name or code as it is stored (`data-raw`, skipped by tests/web-plain-words.test.tsx). */
export function RawDetails({ children, className }: { children: ReactNode; className?: string }) {
  return <Disclosure data-raw className={className} summary={t("details.raw")}>{children}</Disclosure>;
}

/** The viewer: the factory user the page's commands act as (the session's actor), null while unknown. */
export function useViewer(): string | null {
  return useApi<Session>(API.session, false).data?.actor ?? null;
}

/** A worker as "worker N" (its slot number), the full ID behind it (decision 3 of the readable-names change). */
export function WorkerName({ id }: { id: string | null | undefined }) {
  if (!id) return <>–</>;
  return <IdDetails label={workerName(id)} id={id} what="worker ID" nowrap />;
}

/**
 * A person or process by ID: the factory, a worker ("worker N"), "you" when it is the viewer (the owner, on a
 * one-owner factory), else the stored display name or "a person"; the full ID behind it.
 */
export function PersonName({ id, name, viewer }: { id: string | null; name?: string | null | undefined; viewer: string | null }) {
  if (!id || id === "system") return <>{t("person.factory")}</>;
  if (isWorkerId(id)) return <WorkerName id={id} />;
  return <IdDetails label={id === viewer ? t("person.you") : (name || t("person.other"))} id={id} what="user ID" nowrap />;
}

/**
 * The item's source id in short form (`#192`, `30331a68`), linked to the source; the full id shows on hover. With
 * `itemId`, a source with no web address (a local item's `local:` link) links to the item's page instead.
 */
export function SourceLink({ source, className, itemId }: { source: { id: string; link: string }; className?: string; itemId?: string }) {
  if (itemId !== undefined && !isHttpUrl(source.link)) {
    return (
      <Link href={itemPath(itemId)} title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", ID_CLASS, className)}>
        {shortSource(source.id)}
      </Link>
    );
  }
  return (
    <a href={source.link} target="_blank" rel="noreferrer" title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", ID_CLASS, className)}>
      {shortSource(source.id)}
    </a>
  );
}

/** An item's title linking to its page, wrapping at any width; "Untitled item" when it has none. */
export function ItemTitle({ id, title }: { id: string; title: string | null }) {
  return (
    <Link href={itemPath(id)} data-raw={title !== null ? "" : undefined} className={cn("max-w-full font-medium break-words", LINK_CLASS)}>
      {title ?? t("item.untitled")}
    </Link>
  );
}

/** The item cell of the running and queue rows: the title, or the column label until the item is loaded. Never an id. */
function RunItemCell({ id, item }: { id: string; item: Item | undefined }) {
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

/** A snake_case name or an item ID, as `npm run check:responsive`'s raw-name rule finds them (scripts/responsive/rules.mjs). */
const RAW_NAME = /\b(?:wi_[0-9a-z]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/** A sentence that may quote names as written (a check's message): each snake_case name or item ID in it sits in `data-raw`, the words around it stay plain. */
export function RawNames({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(RAW_NAME)) {
    parts.push(text.slice(last, m.index), <span key={m.index} data-raw>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
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
 * Each `#N` a stretch of why text names (from `refs`) links to that issue when the API gave a `ref_url`; an item ID
 * links to the item page; a path is in code style. The text is never changed.
 */
function linked(text: string, why: Pick<Why, "refs" | "ref_url">, key: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const plain = (to: number, from = last) => {
    // `#N` links inside a stretch of plain text.
    let at = from;
    for (const m of text.slice(from, to).matchAll(REF)) {
      const n = Number(m[1]);
      if (!why.ref_url || !why.refs.includes(n)) continue;
      parts.push(text.slice(at, from + m.index));
      parts.push(<a key={`${key}ref${from + m.index}`} href={`${why.ref_url}${n}`} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{n}</a>);
      at = from + m.index + m[0].length;
    }
    parts.push(text.slice(at, to));
  };
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups!;
    const piece = g.id ?? g.path!;
    if (g.path && !isPath(piece)) continue;
    plain(m.index);
    last = m.index + m[0].length;
    parts.push(g.id
      ? <Link key={`${key}i${m.index}`} href={itemPath(piece)} data-why-item={piece} className={LINK_CLASS}>{piece}</Link>
      : <code key={`${key}p${m.index}`} className="font-mono text-xs">{piece}</code>);
  }
  plain(text.length);
  return parts;
}

/** Stands for the holder's name in the text while WhyText puts its link there. */
const HOLDER = "\u0000";

/**
 * Why an item waits, for people: its reason code's en.ts text (whyText). The holder of a held or deadlocked run is
 * named by its title and links to its item page; `#N`, item IDs and paths link as `linked` says.
 */
export function WhyText({ why }: { why: Why }) {
  const holder = why.holder_id && typeof why.params.holder === "string" && why.params.holder ? why.params.holder : null;
  const [before = "", after = ""] = whyText(why, holder === null ? undefined : HOLDER).split(HOLDER);
  return (
    <span data-why={why.code}>
      {linked(before, why, "a")}
      {holder !== null && (
        <>
          <Link href={itemPath(why.holder_id!)} data-why-holder={why.holder_id} className={LINK_CLASS}>{holder}</Link>
          {linked(after, why, "b")}
        </>
      )}
    </span>
  );
}

/** The items list keyed by item ID. */
export const byId = (items: readonly Item[] | undefined): Map<string, Item> => new Map((items ?? []).map((i) => [i.id, i]));

/** What a Needs-you row asks of the owner: merge a PR, approve a spec, or answer or fix (everything else). */
export type NeedGroup = "merge" | "approve" | "answer";

/**
 * The items that wait on the owner, one Needs-you row each (src/ui/needs-you.ts): the state table's Needs-you group.
 * A triage run's ask (Waiting), a failed run and a stuck item (Problem) are no row; an item started past a deadlock is
 * Blocked by another task and goes on by itself.
 */
export const needsYou = (items: readonly Item[]): Item[] => items.filter((i) => groupOf(i.item_phase) === "needs");

export function needGroup(it: Item): NeedGroup {
  if (showsMerge(it.merge) || it.item_phase === "ready_to_merge") return "merge";
  return it.item_phase === "needs_approval" || it.commands?.some((c) => c.name === "approve" && c.allowed) ? "approve" : "answer";
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
const openItem = (label: string, url: string): MenuItem => ({ label, onSelect: () => void window.open(url, "_blank", "noopener,noreferrer") });

/** An item's PR as "PR #N": a link out when it has a stored link, plain text otherwise. */
export function PrLink({ number, url, className }: { number: string; url: string | null; className?: string }) {
  const text = t("tree.pr", { ref: number });
  return url ? <a href={url} target="_blank" rel="noreferrer" className={cn(LINK_CLASS, className)}>{text}</a> : <span className={className}>{text}</span>;
}

/** A run kind as people read it: an `interactive` run is an interactive task (a person handles the item in their own session). */
export const runKindLabel = (kind: string): string => (kind === "interactive" ? t("run.interactive") : kind);

/** Whether a person is handling the item right now through this run: an interactive task that is running. */
export const isInteractiveRun = (run: { kind: string; status: string } | null | undefined): boolean => run?.kind === "interactive" && run.status === "running";

/** The badge an item shows while a person handles it as an interactive task. */
export function InteractiveBadge() {
  return <StatusBadge state="running">{t("run.interactive")}</StatusBadge>;
}

/** A run as a row names it: its kind and attempt, "Implement #2". */
export const runTitle = (run: { kind: string; attempt: number }): string => {
  const kind = runKindLabel(run.kind);
  return t("item.runTitle", { kind: kind.charAt(0).toUpperCase() + kind.slice(1), attempt: run.attempt });
};

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
      age: r.started_at ? duration(now - Date.parse(r.started_at)) : undefined,
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
    { key: "attempt", header: t("col.attempt"), numeric: false, className: "tabular-nums" },
    { key: "queued", header: t("col.queued"), className: "tabular-nums", render: (q) => <When at={q.created_at} now={now} /> },
    { key: "starts", header: t("col.starts"), className: "tabular-nums", render: (q) => (q.why && q.why.code !== "queued" && q.why.code !== "not_before" ? <WhyText why={q.why} /> : q.not_before && Date.parse(q.not_before) > now ? <When at={q.not_before} now={now} /> : t("queue.now")) },
  ];
  return <DataTable label={t("queue.title")} columns={columns} rows={limit ? queue.slice(0, limit) : queue} rowKey={(q) => q.id} empty={t("queue.empty")} dataKey />;
}
