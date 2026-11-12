import { useEffect } from "react";
import type { ThreadEntry } from "../api.js";
import { Badge, Empty, Section } from "../components/ui/parts.js";
import { Markdown } from "../components/ui/markdown.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";

// The item page's thread (design §9, issue #286): every entry of the item API's `thread`, oldest first by time
// (the store's seq breaks a tie), each with its author ID, channel and time, its body as markdown, and its anchor
// (`msg-<seq>`) as the element id, so a Needs-you row can link to the factory's latest "why". A command reply
// shows up here once the controller writes it and the item is read again (the send re-reads it, the poll too).

/** The entries oldest first: by time, then by seq. */
export function threadOrder(entries: readonly ThreadEntry[]): ThreadEntry[] {
  return [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
}

/** Scrolls to the location's hash once the element it names is on the page. */
function useHashScroll(ready: boolean) {
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (ready && id) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [ready]);
}

export function Thread({ entries, now }: { entries: readonly ThreadEntry[]; now: number }) {
  useHashScroll(entries.length > 0);
  const shown = threadOrder(entries);
  return (
    <Section title={t("thread.title")} count={shown.length}>
      {shown.length === 0 ? <Empty>{t("thread.empty")}</Empty> : (
        <ol aria-label={t("thread.title")} className="space-y-4">
          {shown.map((m) => (
            <li key={m.seq} id={m.anchor} data-seq={m.seq} className="min-w-0 scroll-mt-4 overflow-hidden rounded-control border border-border">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg px-3 py-2 text-xs text-text-2">
                <span data-author className="font-mono font-semibold text-text-1">{m.author}</span>
                <span data-channel>{t("thread.channel", { channel: m.channel })}</span>
                <Badge>{m.kind}</Badge>
                <time dateTime={m.at} title={m.at} className="ml-auto tabular-nums">{t("time.ago", { time: ago(m.at, now) })}</time>
              </p>
              <div className="max-w-[75ch] min-w-0 px-3 py-3 sm:px-4">
                <Markdown text={m.body} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
