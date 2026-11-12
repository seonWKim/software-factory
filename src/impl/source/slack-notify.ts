// The owner's notices in Slack (design 12-notification-channels): the `notify` capability of the `slack` source.
// Outbound hands it the notices of one 60 s batch, already egress-scanned; they go out as one top-level message in
// `slack.notify_channel` (default the first of `slack.channels`), one line each. The main text of a line is the item's
// title, never a display name or an ID. With an https `slack.dashboard_url` the title links to the item's dashboard
// page; without one the title stays plain text and the line is a section with a View button (design 05-sources,
// "View in Slack"). A needs-you line also links the item's Slack thread when it has one. The source records each
// posted message with the items its lines name (`noticeItemIds`), so a reply in its thread acts on them (design
// 05-sources, "Replies under a notice").

import type { SourceNotice } from "../../interfaces/source-adapter.js";
import type { SlackPost } from "./slack-api.js";
import { SECTION_MAX, dashboardBase, escapeSlack, section } from "./slack-format.js";

/**
 * What a notices message needs of the source's deps: chat.postMessage with no thread (a top-level message), the
 * notices channel or else the first listed one, and the dashboard's https URL (absent: View buttons).
 */
export interface SlackNotifyDeps {
  api: { postMessage(m: Omit<SlackPost, "thread_ts">): Promise<{ ts: string }> };
  channels: readonly string[];
  notify_channel?: string | undefined;
  dashboard_url?: string | undefined;
}

/** Slack's block limit for a message: past it, the remaining lines share one last section with no buttons. */
const MESSAGE_BLOCKS_MAX = 50;

/** `<url|text>`, or the text alone with no URL. */
const linked = (url: string | null, text: string) => (url ? `<${url}|${text}>` : text);

/** One notice's line. `base`: the dashboard's https URL with no trailing slash, or null. */
export function noticeLine(n: SourceNotice, base: string | null): string {
  if (n.kind === "summary") return `🌙 ${linked(base && `${base}/app/`, `${n.count} update${n.count === 1 ? "" : "s"} during quiet hours`)}`;
  const page = base && n.work_item_id ? `${base}/app/items/${encodeURIComponent(n.work_item_id)}` : null;
  const title = linked(page, escapeSlack(n.title || "Untitled item"));
  if (n.kind === "finished") return `✅ Finished: ${title} (${escapeSlack(n.reason)})`;
  const thread = n.thread_url ? ` (${linked(n.thread_url, "thread")})` : "";
  return `🙋 Needs you: ${title}: ${escapeSlack(n.reason)}${thread}`;
}

/** The work item IDs the notices' lines name, in line order, each once; a summary line names none. */
export function noticeItemIds(notices: readonly SourceNotice[]): string[] {
  return [...new Set(notices.flatMap((n) => (n.kind !== "summary" && n.work_item_id ? [n.work_item_id] : [])))];
}

/**
 * Posts the notices as one message, one line each, and returns where it went; nothing (null) for none. Throws on a
 * Slack failure (outbound retries).
 */
export async function postNotices(d: SlackNotifyDeps, notices: readonly SourceNotice[]): Promise<{ channel: string; ts: string } | null> {
  if (notices.length === 0) return null;
  const base = dashboardBase(d.dashboard_url);
  const lines = notices.map((n) => noticeLine(n, base));
  const channel = d.notify_channel ?? d.channels[0]!;
  if (base !== null) return { channel, ts: (await d.api.postMessage({ channel, text: lines.join("\n") })).ts };
  const own = notices.slice(0, MESSAGE_BLOCKS_MAX - 1).map((n, i) => section(lines[i]!.slice(0, SECTION_MAX), n.work_item_id ?? undefined));
  const rest = lines.slice(MESSAGE_BLOCKS_MAX - 1).join("\n").slice(0, SECTION_MAX);
  const { ts } = await d.api.postMessage({ channel, text: lines.join("\n"), blocks: rest === "" ? own : [...own, section(rest)] });
  return { channel, ts };
}
