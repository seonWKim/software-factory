import { useEffect, useState } from "react";
import type { ThreadEntry } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Markdown } from "../components/ui/markdown.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { When } from "./common.js";
import { Card } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { EmptyState } from "../components/ui/notice.js";

// The item page's thread (design §9, issue #286; newest first since 2026-11-13): every entry of the item API's
// `thread`, newest first by time (the store's seq breaks a tie), each with its author ID, channel and time, its body
// as markdown, and its anchor (`msg-<seq>`) as the element id, so a Needs-you row can link to the factory's latest
// "why". The body is text as stored (`data-raw`: the forge comment the factory wrote, or a person's text); the kind and
// channel above it are in words. The owner's own entries (role owner: a command with its text, a verdict, a message from a source) are right
// aligned and tinted, with the author's stored ID. A factory message longer than its one-line summary (its first
// heading, else its first sentence) starts as that line with its body behind Show more, unless it is the newest
// entry, the newest factory message (what a Needs-you reason names, its anchor), asks the owner for something (kind spec or
// coordination-hold) or is the one the URL's anchor names. A command reply shows up here once the controller writes it and
// the item is read again (the send re-reads it, the poll too). Entries are keyed on their anchor (a verdict has no seq).
// The thread itself is collapsed after its first (newest) message (design 09-dashboard-item): the earlier ones wait
// behind one "Show N earlier messages" button, unless the URL's anchor names one of them (a link to it, the
// DecisionCard's "Show in thread"), which opens them.

/** The kinds of factory message that ask the owner for something: they always start expanded. */
const ASKS: readonly string[] = ["spec", "coordination-hold"];

/** A command's origin (`cli`, `app`) or the item's source type (a thread's channel) in words. */
const CHANNELS: Record<string, MessageKey> = {
  cli: "thread.channel.cli", app: "thread.channel.app", github_issue: "thread.channel.github", slack_thread: "thread.channel.slack",
};

/** An entry's kind in words: a factory message's marker kind (src/ui/thread.ts kindOf), a verdict, a comment or message from a source. */
const KINDS: Record<string, MessageKey> = {
  "spec": "thread.kind.spec",
  "coordination-hold": "thread.kind.coordination-hold",
  "dependency-closed": "thread.kind.dependency-closed",
  "dependency-cycle": "thread.kind.dependency-cycle",
  "eval-regression": "thread.kind.eval-regression",
  "floor": "thread.kind.floor",
  "forge-auth": "thread.kind.forge-auth",
  "leak-blocked": "thread.kind.leak-blocked",
  "max-loops": "thread.kind.max-loops",
  "max-revisions": "thread.kind.max-revisions",
  "needs-human": "thread.kind.needs-human",
  "preflight-access": "thread.kind.preflight-access",
  "rejected": "thread.kind.rejected",
  "run-failed": "thread.kind.run-failed",
  "split": "thread.kind.split",
  "split-done": "thread.kind.split-done",
  "split-failed": "thread.kind.split-failed",
  "split-queued": "thread.kind.split-queued",
  "standing-proposal": "thread.kind.standing-proposal",
  "verdict": "thread.kind.verdict",
  "comment": "thread.kind.comment",
  "message": "thread.kind.message",
  "factory": "thread.kind.factory",
};

/**
 * A stored name in words from `words`: a plain word with none (an owner command's name, a source type like `local`)
 * as it is, any other code (snake_case or kebab-case) as `other`, never as the code.
 */
function inWords(value: string, words: Record<string, MessageKey>, other: MessageKey): string {
  const key = words[value];
  if (key) return t(key);
  return /^[a-z]+$/.test(value) ? value : t(other);
}

/** The entries newest first: by time, then by seq. */
export function threadOrder(entries: readonly ThreadEntry[]): ThreadEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq);
}

const plain = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~>#]/g, "").replace(/\s+/g, " ").trim();

/** A message's one-line summary: its first heading, else its first sentence (markup and HTML comments left out). */
export function summaryOf(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("<!--") && !/^<\/?details>$/.test(l));
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  if (heading) return plain(heading);
  const first = plain(lines.find((l) => !l.startsWith("```")) ?? "");
  return /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
}

/** The location's hash without `#` ("" when there is no window: the page can be rendered on the server). */
const hashId = () => (typeof location === "undefined" ? "" : decodeURIComponent(location.hash.slice(1)));

/** Scrolls to the location's hash once the element it names is on the page. */
function useHashScroll(ready: boolean) {
  useEffect(() => {
    const id = hashId();
    if (ready && id) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [ready]);
}

function Message({ m, now, open: initial }: { m: ThreadEntry; now: number; open: boolean }) {
  const owner = m.role === "owner";
  const summary = owner ? "" : summaryOf(m.body);
  // Collapsible only when the body says more than its summary line.
  const long = !owner && plain(m.body) !== summary;
  const [open, setOpen] = useState(initial);
  const folded = long && !open;
  return (
    <li
      id={m.anchor}
      data-seq={m.seq}
      data-role={m.role}
      className={cn(
        "min-w-0 scroll-mt-4 overflow-hidden rounded-control border border-border",
        owner && "ml-auto w-full bg-surface-2 sm:max-w-[85%]",
      )}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg px-3 py-2 text-xs text-text-2">
        <span data-author className={cn("font-mono font-semibold text-text-1", owner && "font-sans")} title={owner ? m.author : undefined}>
          {owner ? t("thread.you") : m.author}
        </span>
        {owner && <span data-author-id className="font-mono">{m.author}</span>}
        <span data-channel>{t("thread.channel", { channel: inWords(m.channel, CHANNELS, "thread.channel.other") })}</span>
        {m.permission_mode && <span data-permission-mode={m.permission_mode} title={t("key.permission_mode.label")}>{t(`settings.permissionMode.${m.permission_mode}`)}</span>}
        <Badge>{inWords(m.kind, KINDS, m.role === "owner" ? "thread.kind.message" : "thread.kind.factory")}</Badge>
        <span className="ml-auto tabular-nums"><When at={m.at} now={now} /></span>
      </p>
      {folded ? (
        <p data-summary data-raw className="min-w-0 truncate px-3 py-2 text-sm sm:px-4">{summary}</p>
      ) : m.body !== "" && (
        <div data-raw className="max-w-[75ch] min-w-0 px-3 py-3 sm:px-4">
          <Markdown text={m.body} renumberHeadings />
        </div>
      )}
      {long && (
        <div className="px-3 pb-2 sm:px-4">
          <Button variant="ghost" size="sm" flush aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("thread.showLess") : t("thread.showMore")}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Whether the location's hash names an entry after the first: the earlier messages then show. */
const namesEarlier = (shown: readonly ThreadEntry[]) => shown.slice(1).some((m) => m.anchor === hashId());

export function Thread({ entries, now }: { entries: readonly ThreadEntry[]; now: number }) {
  useHashScroll(entries.length > 0);
  const shown = threadOrder(entries);
  const newestFactory = shown.find((m) => m.role === "factory")?.anchor;
  const hash = hashId();
  const [all, setAll] = useState(() => namesEarlier(shown));
  useEffect(() => {
    const open = () => namesEarlier(threadOrder(entries)) && setAll(true);
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
  }, [entries]);
  const earlier = shown.length - 1;
  const collapsed = earlier > 0 && !all;
  return (
    <Card title={t("thread.title")} count={shown.length}>
      {shown.length === 0 ? <EmptyState title={t("thread.empty")} /> : (
        <>
          <ol aria-label={t("thread.title")} data-collapsed={collapsed} className={cn("space-y-4", collapsed && "[&>li+li]:hidden")}>
            {shown.map((m, i) => (
              <Message key={m.anchor} m={m} now={now} open={i === 0 || m.anchor === newestFactory || ASKS.includes(m.kind) || m.anchor === hash} />
            ))}
          </ol>
          {earlier > 0 && (
            <Button variant="ghost" size="sm" flush className="mt-2" aria-expanded={!collapsed} onClick={() => setAll(collapsed)}>
              {collapsed ? t(earlier === 1 ? "thread.showEarlierOne" : "thread.showEarlier", { count: earlier }) : t("thread.showNewest")}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
