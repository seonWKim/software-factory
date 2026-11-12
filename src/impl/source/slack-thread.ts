// A Slack thread as a source: its source id `slack:<team>:<channel>:<thread ts>`, its link, and its SourceRef. Kept
// apart from slack-source.ts so the modules it uses (slack-notice-replies.ts) build thread refs with no import cycle.

import type { SourceRef } from "../../core/types.js";

/** The parts of a Slack source id `slack:<team>:<channel>:<thread ts>`. */
export interface SlackThread {
  team: string;
  channel: string;
  thread_ts: string;
}

export function slackSourceId(t: SlackThread): string {
  return `slack:${t.team}:${t.channel}:${t.thread_ts}`;
}

export function parseSlackSourceId(id: string): SlackThread | null {
  const m = /^slack:([A-Z0-9]+):([A-Z0-9]+):(\d+\.\d+)$/.exec(id);
  return m ? { team: m[1]!, channel: m[2]!, thread_ts: m[3]! } : null;
}

/** A link to a message (or a thread root) that Slack redirects into the workspace. */
export function slackLink(channel: string, ts: string, thread_ts?: string): string {
  const base = `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  return thread_ts && thread_ts !== ts ? `${base}?thread_ts=${thread_ts}&cid=${channel}` : base;
}

export const threadRef = (t: SlackThread): SourceRef => ({ type: "slack_thread", id: slackSourceId(t), link: slackLink(t.channel, t.thread_ts) });
