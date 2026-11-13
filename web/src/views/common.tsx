import { useEffect, useState } from "react";
import { API, type ItemRow, type MergeCheckView, type Overview, type QueueRow, type RunRow, type Session, type Why, mergeCheckLabel, showsMerge, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { IdDetails } from "../components/ui/copy.js";
import { StatusBadge } from "../components/ui/notice.js";
import { Badge, Empty, Section, Table, Td, Tr } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { LEVEL_LABELS, ago, isHttpUrl, isWorkerId, shortSource, stateAndNext, until, workerName } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { NeedActions, useCommandSend } from "./item-commands.js";

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

const PATH = String.raw`[\w@~-]+(?:\.[\w@~-]+)*(?:\/[\w@~-]+(?:\.[\w@~-]+)*)*`;
/** What the why text names besides `#N`: `/retry +paths <path>...`, a bare `/retry`, an item ID, a path. */
const TOKEN = new RegExp(
  String.raw`(?<allow>(?: with)? \/retry \+paths (?<paths>${PATH}(?: ${PATH})*))|(?<retry>\/retry(?: this item)?\b)|(?<id>\bwi_[0-9a-z]+\b)|(?<path>(?<![\w./@:~-])[\w@~-]+(?:\/[\w@~.-]*[\w@~-])+(?![\w#]))`,
  "g",
);

/** A path is shown in code style when it has a file extension or at least two slashes (so "and/or" stays text). */
const isPath = (s: string): boolean => s.split("/").length > 2 || /\.\w+$/.test(s);
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The "Allow <file> and retry" entries a why text offers: one per `/retry +paths ...` it names, with the note that sends it. */
export function allowEntries(text: string): { label: string; note: string }[] {
  return [...text.matchAll(TOKEN)].flatMap((m) => {
    const paths = m.groups?.paths;
    return paths ? [{ label: t("why.allow", { file: paths.split(" ").map(basename).join(", ") }), note: `+paths ${paths}` }] : [];
  });
}

/** An item the why text may name: its title (the loaded item list) or, not loaded, its ID. */
type ItemTitles = ReadonlyMap<string, { title: string | null }>;

/**
 * The why sentence for people. Each `#N` it names (from `refs`) links to that issue when the API gave a `ref_url`;
 * an item ID is the item's title (from `items`) or the ID, linked to the item page; a path is in code style.
 * With `onRetry` (a Needs-you row), `/retry` is a button ("Retry after it merges" when the sentence waits on an
 * item) and `/retry +paths ...` is dropped from the sentence: the row's menu offers it (`allowEntries`). The stored
 * text is never changed.
 */
export function WhyText({ why, items, onRetry }: { why: Pick<Why, "text" | "refs" | "ref_url"> & { code?: string }; items?: ItemTitles; onRetry?: () => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let waits = false;
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
    const piece = g.allow ?? g.retry ?? g.id ?? g.path!;
    if ((g.allow || g.retry) && !onRetry) continue;
    if (g.path && !isPath(piece)) continue;
    text(m.index);
    last = m.index + m[0].length;
    if (g.allow) continue;
    if (g.retry) {
      parts.push(<Button key={`r${m.index}`} variant="secondary" size="sm" data-why-retry onClick={onRetry}>{t(waits ? "why.retryAfterMerge" : "why.retry")}</Button>);
    } else if (g.id) {
      waits = true;
      parts.push(<Link key={`i${m.index}`} href={itemPath(piece)} data-why-item={piece} className={LINK_CLASS}>{items?.get(piece)?.title ?? piece}</Link>);
    } else {
      parts.push(<code key={`p${m.index}`} className="font-mono text-xs">{piece}</code>);
    }
  }
  text(why.text.length);
  return <span data-why={why.code}>{parts}</span>;
}

/** What a Needs-you row asks of the owner: merge a PR, approve a spec, or answer or fix (everything else). */
export type NeedGroup = "merge" | "approve" | "answer";

export function needGroup(it: ItemRow): NeedGroup {
  if (showsMerge(it.merge) || it.level === "ready_to_merge") return "merge";
  return it.level === "needs_approval" || it.commands?.some((c) => c.name === "approve" && c.allowed) ? "approve" : "answer";
}

/** The row's reason: the stored need (or the item's state and next step), else the why; the same words as the classic page. */
function needReason(it: ItemRow): { text: string; anchor: string | null } {
  if (it.need) return { text: it.blocked_reason === null ? stateAndNext(it.stage, it.commands) : it.need.reason, anchor: it.need.anchor ?? null };
  return { text: it.why?.text ?? (it.badges.join(" · ") || it.blocked_reason || "–"), anchor: null };
}

/** A link out to GitHub; only drawn for the github plugin. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/** Needs-you rows centre every cell on the row's buttons (the cell's own top alignment is overridden). */
const MID = "align-middle!";

/** One Needs-you row: the item, its state, why in one plain line, since, and its actions in the same place in every row. */
function NeedRow({ it, now, titles, showIssue }: { it: ItemRow; now: number; titles: ItemTitles; showIssue: boolean }) {
  const cmd = useCommandSend(it.id);
  const { text, anchor } = needReason(it);
  const refs = { code: it.why?.code ?? "need", text, refs: it.why?.refs ?? [], ref_url: it.why?.ref_url ?? null };
  const group = needGroup(it);
  const checking = it.merge_check?.state === "checking";
  return (
    <Tr data-key={it.id}>
      <Td className={cn("max-w-md", MID)}>
        <span className="flex min-w-0 items-baseline gap-2">
          <Link href={itemPath(it.id)} title={t("needs.idHover", { id: it.id })} className="truncate font-medium text-text-1 hover:underline">
            {it.title ?? shortSource(it.source.id)}
          </Link>
          {it.change_ref !== null && (it.change_url
            ? <a href={it.change_url} target="_blank" rel="noreferrer" aria-label={t("needs.prLabel", { ref: it.change_ref })} className="shrink-0 text-text-2 tabular-nums hover:underline">#{it.change_ref}</a>
            : <span className="shrink-0 text-text-2 tabular-nums">#{it.change_ref}</span>)}
        </span>
      </Td>
      <Td className={MID}>
        <StatusBadge level={it.level}>{LEVEL_LABELS[it.level] ?? it.level}</StatusBadge>
        {it.merge_check && !checking && <MergeCheckNote check={it.merge_check} />}
      </Td>
      <Td className={cn("max-w-xl text-text-2", MID)}>
        <span data-need title={text} className="line-clamp-2 break-words">
          {anchor && text.match(TOKEN) === null
            ? <Link href={`${itemPath(it.id)}#${anchor}`} className={LINK_CLASS}>{text}</Link>
            : <WhyText why={refs} items={titles} onRetry={() => void cmd.send("retry", "")} />}
        </span>
      </Td>
      <Td className={cn("text-right whitespace-nowrap tabular-nums", MID)}>{ago(it.since, now)}</Td>
      {showIssue && <Td className={cn("tabular-nums", MID)}>{it.issue ? <Ext href={it.issue.url}>#{it.issue.number}</Ext> : "–"}</Td>}
      <Td className={cn("w-44 text-right", MID)}>
        <NeedActions id={it.id} title={it.title ?? it.id} commands={it.commands ?? []} pr={it.change_ref} group={group} merge={it.merge} source={it.source.type} checking={checking} cmd={cmd} allow={allowEntries(text)} />
      </Td>
    </Tr>
  );
}

const GROUPS: readonly [NeedGroup, MessageKey][] = [["merge", "needs.groupMerge"], ["approve", "needs.groupApprove"], ["answer", "needs.groupAnswer"]];

/**
 * Needs you: the rows grouped by what is asked (Merge, Approve, Answer or fix, in that order), each group a Section
 * that shows its count only when more than one group has rows. Columns: Item, State, Why, Since, Issue (only when a
 * row has one) and Actions; a PR shows as a muted "#N" link after the title. `titles`: the loaded items, so the why
 * text can name an item by its title.
 */
export function NeedsGroups({ items, now, titles, empty }: { items: readonly ItemRow[]; now: number; titles: ItemTitles; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  const showIssue = items.some((it) => it.issue);
  const head = [t("col.item"), t("col.state"), t("col.why"), t("col.since"), ...(showIssue ? [t("col.issue")] : []), t("col.actions")];
  const numeric = head.map((h) => h === t("col.since"));
  const groups = GROUPS.map(([group, title]) => ({ title: t(title), rows: items.filter((it) => needGroup(it) === group) })).filter((g) => g.rows.length > 0);
  return (
    <>
      {groups.map((g) => (
        <Section key={g.title} title={g.title} count={groups.length > 1 ? g.rows.length : undefined}>
          <Table label={t("page.needs")} head={head} numeric={numeric}>
            {g.rows.map((it) => <NeedRow key={it.id} it={it} now={now} titles={titles} showIssue={showIssue} />)}
          </Table>
        </Section>
      ))}
    </>
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
    <Table label={t("queue.title")} head={["#", t("col.item"), t("col.run"), t("col.attempt"), t("col.queued"), t("col.starts")]}>
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
