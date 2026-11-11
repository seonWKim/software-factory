import { COMMANDS, type CommandName } from "../../core/commands.js";
import type { RepoRef } from "../github/github-client.js";

// How a control-plane comment (GitHub Markdown) becomes a Slack thread message (issue #109): mrkdwn text in
// section blocks, then the buttons. The command buttons come from the comment's own command footer, which the
// controller builds from the command table in src/core/commands.ts, so a button exists only for a command that
// applies in the item's state when the comment was written. A press is checked again when it arrives.

/** Commands that take no text get a button; the others (reject, revise, verdict) stay typed. */
export const BUTTON_COMMANDS: readonly CommandName[] = ["approve", "retry", "resolve", "budget", "help"];

/**
 * Button action IDs: a command button, and Confirm and Cancel. No message gets Confirm or Cancel any more (proposals
 * are plain text, design §4, issue #583); the source still reads a press on a message posted before.
 */
export const ACTION_COMMAND = "sf_cmd";
export const ACTION_CONFIRM = "sf_confirm";
export const ACTION_CANCEL = "sf_cancel";

const FOOTER_HEADING = "Commands you can reply with now:";
const SECTION_MAX = 3000;
const MAX_SECTIONS = 45;

export interface SlackRendered {
  text: string;
  blocks: unknown[];
}

/** The command names the footer of `body` lists, in footer order, that get a button. */
export function footerCommands(body: string): CommandName[] {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === FOOTER_HEADING);
  if (at < 0) return [];
  const out: CommandName[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^- `([^`]+)`/.exec(line.trim());
    if (!m) break;
    const spec = COMMANDS.find((c) => c.usage === m[1]);
    if (spec && BUTTON_COMMANDS.includes(spec.name) && !out.includes(spec.name)) out.push(spec.name);
  }
  return out;
}

/** `&`, `<` and `>` as Slack wants them in text. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack's own escapes back to text (`&lt;` and so on), for message text read from an event. */
export function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * GitHub Markdown to Slack mrkdwn: HTML comments (markers) dropped, headings and `**bold**` to `*bold*`, `[t](u)`
 * links to `<u|t>`, list dashes to bullets, `PR #N` to a link to the pull request. A folded block's
 * `<details><summary>T</summary>` line is the bold heading `T` and its `</details>` line is dropped: Slack has no
 * folding, and the tags would show as text. Code spans and fenced blocks are kept as they are (escaped only).
 */
export function toMrkdwn(markdown: string, repo: RepoRef): string {
  const noMarkers = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of noMarkers.split(/\r?\n/)) {
    const f = /^\s*(`{3,})/.exec(raw);
    if (fence !== null) {
      if (f && raw.trim() === f[1] && f[1]!.length >= fence.length) {
        out.push("```");
        fence = null;
      } else out.push(escapeSlack(raw));
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push("```");
      continue;
    }
    const fold = /^\s*<details>\s*(?:<summary>(.*?)<\/summary>)?\s*$/.exec(raw);
    if (fold) {
      if (fold[1]) out.push(`*${inline(fold[1], repo)}*`);
      continue;
    }
    if (/^\s*<\/details>\s*$/.test(raw)) continue;
    out.push(inline(raw, repo));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One line outside a fence; code spans are left alone. */
function inline(line: string, repo: RepoRef): string {
  const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  let text = heading ? heading[1]! : bullet ? bullet[2]! : line;
  text = text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) return escapeSlack(part);
      let s = escapeSlack(part);
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<${u}|${t}>`);
      s = s.replace(/\*\*([^*]+)\*\*/g, "*$1*");
      s = s.replace(/(^|[^\w/|])PR #(\d+)\b/g, (_m, pre: string, n: string) => `${pre}<${prUrl(repo, n)}|PR #${n}>`);
      return s;
    })
    .join("");
  if (heading) return `*${text.replace(/^\*(.*)\*$/, "$1")}*`;
  if (bullet) return `${bullet[1]}• ${text}`;
  return text;
}

/** The PR link for PR `n`: a number, or a change_ref (the PR number as text). */
export function prUrl(repo: RepoRef, n: number | string): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${n}`;
}

/** Splits mrkdwn into chunks of at most `max` characters, at line breaks where it can. */
function chunks(text: string, max = SECTION_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const add = cur === "" ? line : `${cur}\n${line}`;
    if (add.length <= max) {
      cur = add;
      continue;
    }
    if (cur !== "") out.push(cur);
    cur = line;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

const LABELS: Record<string, string> = { approve: "Approve", retry: "Retry", resolve: "Resolve", budget: "Continue (budget)", help: "Help" };

/**
 * The Slack message for one comment: mrkdwn sections, a line on typing commands in Slack (a leading `/` would be
 * taken by Slack itself, so a command follows a mention, with no slash: `approve`, `revise <feedback>`, `help`; issue
 * #541), and an actions block with the command buttons. A proposed command (design §4) is plain text, with no buttons.
 */
export function renderComment(body: string, repo: RepoRef, botUserId: string): SlackRendered {
  let text = toMrkdwn(body, repo);
  const cmds = footerCommands(body);
  if (cmds.length > 0 || body.includes(FOOTER_HEADING)) {
    text += `\n\n_In Slack, type a command after a mention, e.g. <@${botUserId}> approve or <@${botUserId}> revise &lt;feedback&gt; ` +
      `(<@${botUserId}> help lists them), or use the buttons._`;
  }
  let sections = chunks(text);
  if (sections.length > MAX_SECTIONS) sections = [...sections.slice(0, MAX_SECTIONS), "_(message cut: too long for Slack)_"];
  const blocks: unknown[] = sections.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
  const buttons = cmds.map((c) => button(LABELS[c] ?? c, `${ACTION_COMMAND}:${c}`, `/${c}`, c === "approve" ? "primary" : undefined));
  if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  return { text: sections[0] ?? "", blocks };
}

/**
 * The note that ends a chat reply cut to Slack's limits (design 05-sources, "Cut chat replies"): it says the reply
 * was cut, names `whole`, the CLI command that prints the whole text, and links `link` (the item's source) when given.
 */
export function cutNote(whole: string, link?: string): string {
  const at = link && /^https?:\/\//.test(link) ? ` or <${link.replace(/[<>|]/g, "")}|the item>` : "";
  return `_(reply cut to Slack's limits; the whole text: \`${escapeSlack(whole)}\`${at})_`;
}

const FENCE = "```";

/**
 * A command's printed lines (the CLI's text, unchanged) as Slack code blocks: one section per block, each at most
 * SECTION_MAX characters with its fences, at most MAX_SECTIONS sections. A longer text keeps the sections that fit
 * and ends with `cutNote(whole, link)`.
 */
export function renderLines(lines: readonly string[], whole: string, link?: string): SlackRendered {
  let sections = chunks(escapeSlack(lines.join("\n")), SECTION_MAX - 2 * (FENCE.length + 1)).map((t) => `${FENCE}\n${t}\n${FENCE}`);
  if (sections.length > MAX_SECTIONS) sections = [...sections.slice(0, MAX_SECTIONS - 1), cutNote(whole, link)];
  return { text: sections[0] ?? "", blocks: sections.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } })) };
}

function button(label: string, action_id: string, value: string, style?: "primary"): unknown {
  return { type: "button", text: { type: "plain_text", text: label }, action_id, value, ...(style ? { style } : {}) };
}
