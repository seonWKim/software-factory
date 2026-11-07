import { useEffect } from "react";
import type { ThreadEntry } from "../api.js";
import { Empty, Section } from "../components/ui/parts.js";
import { Markdown } from "../components/ui/markdown.js";
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
    <Section title="Thread" count={shown.length}>
      {shown.length === 0 ? <Empty>No message yet.</Empty> : (
        <ol aria-label="Thread" className="space-y-3">
          {shown.map((m) => (
            <li key={m.seq} id={m.anchor} data-seq={m.seq} className="scroll-mt-4 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="mb-1 flex flex-wrap gap-x-2 text-xs text-zinc-600 dark:text-zinc-400">
                <span data-author className="font-mono">{m.author}</span>
                <span data-channel>on {m.channel}</span>
                <span>{m.kind}</span>
                <time dateTime={m.at} title={m.at} className="tabular-nums">{ago(m.at, now)} ago</time>
              </p>
              <div className="min-w-0 text-sm break-words">
                <Markdown text={m.body} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
