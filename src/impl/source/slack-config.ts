// The `slack` block of factory.config.json (issue #109): the channels the `slack` source listens in. loadConfig
// checks it (checkConfigKeys, src/config-keys.ts), and the plugin reads it again when it is built, so a selected
// `slack` source without the block fails at startup. A format check only: the bot token has no `channels:read`.

export const SLACK_KEYS = ["channels"] as const;

export interface SlackConfig {
  /** Slack channel IDs (`C…`, or `G…` for an older private channel), never channel names. */
  channels: string[];
}

/** A Slack conversation ID as Slack prints it: upper-case letters and digits after C or G. */
export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Value problems of the `slack` block, one message each, naming its path. Absent block: none. Unknown keys inside
 * the block are reported by unknownConfigKeys, not here.
 */
export function slackConfigProblems(raw: unknown): string[] {
  if (!isObject(raw) || raw.slack === undefined) return [];
  const block = raw.slack;
  if (!isObject(block)) return ['slack must be an object with "channels", a list of Slack channel IDs'];
  const ch = block.channels;
  if (ch === undefined) return ["slack.channels is required: a list of Slack channel IDs such as C0123456789"];
  if (!Array.isArray(ch) || ch.length === 0) return ["slack.channels must be a non-empty list of Slack channel IDs such as C0123456789"];
  const problems: string[] = [];
  ch.forEach((c, i) => {
    if (typeof c !== "string" || !SLACK_CHANNEL_ID.test(c)) {
      problems.push(`slack.channels[${i}] is not a Slack channel ID (got ${JSON.stringify(c) ?? String(c)}); use the ID, e.g. C0123456789, not the channel name`);
    }
  });
  if (new Set(ch).size !== ch.length) problems.push("slack.channels lists the same channel twice");
  return problems;
}

/** The checked block for the `slack` source; throws when it is absent or invalid. */
export function slackConfig(file: unknown): SlackConfig {
  if (!isObject(file) || file.slack === undefined) {
    throw new Error('plugins.source lists "slack", but factory.config.json has no "slack" block; add "slack": { "channels": ["C0123456789"] }');
  }
  const problems = slackConfigProblems(file);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { channels: [...((file.slack as { channels: string[] }).channels)] };
}
