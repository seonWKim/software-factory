// The owner's notices in Slack (design 12-notification-channels): the `notify` capability of the `slack` source.
// Outbound hands it the notices of one 60 s batch, already egress-scanned; they go out as one top-level message in
// `slack.notify_channel` (default the first of `slack.channels`), one line each. The main text of a line is the item's
// title, never a display name or an ID; the title links to the item's dashboard page, and a needs-you line also
// links the item's Slack thread when it has one.

import type { SourceNotice } from "../../interfaces/source-adapter.js";
import type { SlackPost } from "./slack-api.js";
import { escapeSlack } from "./slack-format.js";

/**
 * What a notices message needs of the source's deps: chat.postMessage with no thread (a top-level message), the
 * notices channel or else the first listed one, and the dashboard's base URL (absent: no dashboard link).
 */
export interface SlackNotifyDeps {
  api: { postMessage(m: Omit<SlackPost, "thread_ts">): Promise<{ ts: string }> };
  channels: readonly string[];
  notify_channel?: string | undefined;
  dashboard?: (() => Promise<string>) | undefined;
}

/** `<url|text>`, or the text alone with no URL. */
const linked = (url: string | null, text: string) => (url ? `<${url}|${text}>` : text);

/** One notice's line. `base`: the dashboard's URL with no trailing slash, or null. */
export function noticeLine(n: SourceNotice, base: string | null): string {
  if (n.kind === "summary") return `🌙 ${linked(base && `${base}/app/`, `${n.count} update${n.count === 1 ? "" : "s"} during quiet hours`)}`;
  const page = base && n.work_item_id ? `${base}/app/items/${encodeURIComponent(n.work_item_id)}` : null;
  const title = linked(page, escapeSlack(n.title || "Untitled item"));
  if (n.kind === "finished") return `✅ Finished: ${title} (${escapeSlack(n.reason)})`;
  const thread = n.thread_url ? ` (${linked(n.thread_url, "thread")})` : "";
  return `🙋 Needs you: ${title}: ${escapeSlack(n.reason)}${thread}`;
}

/** Posts the notices as one message, one line each; nothing for none. Throws on a Slack failure (outbound retries). */
export async function postNotices(d: SlackNotifyDeps, notices: readonly SourceNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const base = d.dashboard ? (await d.dashboard()).replace(/\/+$/, "") : null;
  await d.api.postMessage({ channel: d.notify_channel ?? d.channels[0]!, text: notices.map((n) => noticeLine(n, base)).join("\n") });
}
