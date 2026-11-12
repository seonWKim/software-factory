import { COMMANDS, type CommandName, commandPhase, commandSpec, phaseLabel } from "../../core/commands.js";
import { parseProposalMarker, parseTaskOfferMarker } from "../../core/interpret.js";
import { utcMinute } from "../../core/spec-comment.js";
import type { StateChange, WorkItem } from "../../core/types.js";
import type { RepoRef } from "../github/github-client.js";

// How a control-plane comment (GitHub Markdown) becomes a Slack thread message (issue #109): mrkdwn text in
// section blocks, then the buttons. The command buttons come from the comment's own command footer, which the
// controller builds from the command table in src/core/commands.ts, so a button exists only for a command that
// applies in the item's state when the comment was written. A press is checked again when it arrives. A stored
// proposal's reply (its hidden marker, src/core/interpret.ts) gets one button per proposed command, Confirm all and
// Cancel instead (issue #584); their values carry only the proposal ID and index, the args are read at press time.
// An unsure answer to a top-level message (its task-offer marker) gets one "Make this a task" button whose value is
// the message text (design 04-gate-commands, the chat answer); a press takes the message in as the presser.

/** Commands that take no text get a button; the others (reject, revise, verdict) stay typed. */
export const BUTTON_COMMANDS: readonly CommandName[] = ["approve", "retry", "resolve", "budget", "help"];

/**
 * Button action IDs: a command button; the old Confirm (its value the command text) and Cancel, which no new message
 * gets but whose press on a message posted before is still read; and a stored proposal's buttons (issue #584): one
 * per command (`sf_proposal:<index>`, value `<proposal id>:<index>`), Confirm all and Cancel (value `<proposal id>`).
 */
export const ACTION_COMMAND = "sf_cmd";
export const ACTION_CONFIRM = "sf_confirm";
export const ACTION_CANCEL = "sf_cancel";
export const ACTION_PROPOSAL = "sf_proposal";
export const ACTION_PROPOSAL_ALL = "sf_proposal_all";
export const ACTION_PROPOSAL_CANCEL = "sf_proposal_cancel";
/** "Make this a task" (the chat answer): its value is the top-level message's text, at most SLACK_VALUE_MAX characters. */
export const ACTION_MAKE_TASK = "sf_make_task";
/**
 * A spec waiting for approval (design 05-sources, "Slack spec messages"): Approve with defaults, Other… (the answers
 * modal) and Reject… (the reason modal). Their value is the item ID, for reading only: a press acts on its thread's item.
 */
export const ACTION_SPEC_APPROVE = "sf_spec_approve";
export const ACTION_SPEC_OTHER = "sf_spec_other";
export const ACTION_SPEC_REJECT = "sf_spec_reject";
/** The two modals' callback IDs; each input's element has the action ID MODAL_INPUT. */
export const VIEW_SPEC_ANSWERS = "sf_spec_answers";
export const VIEW_SPEC_REJECT = "sf_spec_reject";
const MODAL_INPUT = "answer";
const REASON_BLOCK = "reason";
/** Slack's modal holds at most 100 blocks: one field per decision for the first 99; the rest are typed. */
export const MODAL_FIELDS_MAX = 99;
/** The most characters Slack takes in a block label and in a text input. */
const LABEL_MAX = 2000;
const INPUT_MAX = 3000;
/** The most characters Slack takes in a button's value. */
export const SLACK_VALUE_MAX = 2000;

const FOOTER_HEADING = "Commands you can reply with now:";
export const SECTION_MAX = 3000;
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

/**
 * Whether a button for `name` (pressed, or shown on an earlier message) still means something for `it` (issue #586):
 * the item's phase is one the command applies in. The phase only: a run held for coordination cost is in no field,
 * so an Approve from the spec is stale once the item is implementing.
 */
export function buttonApplies(name: CommandName, it: WorkItem): boolean {
  return commandSpec(name).phases.includes(commandPhase(it));
}

/**
 * What already happened to `it`, in plain words with no error wording (issue #586): `Done: <reason> by <actor ID> at
 * <time>. The item is now <phase>.`, from its last state change. Ends an earlier message whose buttons no longer
 * apply, and the reply to a stale button press.
 */
export function doneLine(last: Pick<StateChange, "reason" | "actor" | "at"> | null, it: WorkItem): string {
  const what = last ? `${last.reason.replace(/_/g, " ")} by ${last.actor.id} at ${utcMinute(last.at)}` : "the item moved on";
  return `Done: ${what}. The item is now ${phaseLabel(commandPhase(it))}.`;
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
 * `body` without its command footer (the heading, its list and the "No command changes" line after it): what an
 * earlier message keeps once its commands no longer apply (issue #586).
 */
function withoutFooter(body: string): string {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === FOOTER_HEADING);
  if (at < 0) return body;
  let end = at + 1;
  while (end < lines.length && /^- `/.test(lines[end]!.trim())) end++;
  if (lines[end]?.startsWith("No command changes")) end++;
  return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

/**
 * The Slack message for one comment: mrkdwn sections, a line on typing commands in Slack (a leading `/` would be
 * taken by Slack itself, so a command follows a mention, with no slash: `approve`, `revise <feedback>`, `help`; issue
 * #541), and an actions block with the command buttons. A stored proposal's reply gets its proposal buttons instead
 * (`proposalButtons`); a reply with no marker (a question, or one not stored) stays plain text, with no buttons.
 * `done` (issue #586): the message after a state change, its footer dropped, the `done` line added, and only the
 * buttons in `keep` (those of its footer that still apply).
 */
export function renderComment(body: string, repo: RepoRef, botUserId: string, done?: { line: string; keep: readonly CommandName[] }): SlackRendered {
  let text = toMrkdwn(done ? withoutFooter(body) : body, repo);
  if (done) text += `\n\n*${escapeSlack(done.line)}*`;
  const cmds = done ? done.keep : footerCommands(body);
  if (cmds.length > 0 || (!done && body.includes(FOOTER_HEADING))) {
    text += `\n\n_In Slack, type a command after a mention, e.g. <@${botUserId}> approve or <@${botUserId}> revise &lt;feedback&gt; ` +
      `(<@${botUserId}> help lists them), or use the buttons._`;
  }
  const proposal = done ? null : parseProposalMarker(body);
  if (proposal) text += "\n\n_Or press a command's button to apply it as you, *Confirm all* to apply them in order, or *Cancel*._";
  const offer = done ? null : parseTaskOfferMarker(body);
  const offerFits = offer !== null && offer.length <= SLACK_VALUE_MAX;
  if (offerFits) text += "\n\n_To make your message a work item, press *Make this a task*._";
  else if (offer !== null) {
    text += `\n\n_Your message is too long for a *Make this a task* button (Slack takes ${SLACK_VALUE_MAX} characters), so none is offered. ` +
      "Mention the bot again with a shorter request to make it a work item._";
  }
  let sections = chunks(text);
  if (sections.length > MAX_SECTIONS) sections = [...sections.slice(0, MAX_SECTIONS), "_(message cut: too long for Slack)_"];
  const blocks: unknown[] = sections.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
  const buttons = proposal
    ? proposalButtons(proposal.id, proposal.commands)
    : offerFits
    ? [button("Make this a task", ACTION_MAKE_TASK, offer, "primary")]
    : cmds.map((c) => button(LABELS[c] ?? c, `${ACTION_COMMAND}:${c}`, `/${c}`, c === "approve" ? "primary" : undefined));
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

/**
 * A stored proposal's buttons (issue #584): one per proposed command, in index order, then Confirm all and Cancel.
 * Each value is the proposal ID, with the index for one command: never the args, which the press reads from the store.
 */
export function proposalButtons(id: string, commands: readonly CommandName[]): unknown[] {
  return [
    ...commands.map((c, i) => button(`${i + 1}. /${c}`, `${ACTION_PROPOSAL}:${i}`, `${id}:${i}`)),
    button("Confirm all", ACTION_PROPOSAL_ALL, id, "primary"),
    button("Cancel", ACTION_PROPOSAL_CANCEL, id),
  ];
}

function button(label: string, action_id: string, value: string, style?: "primary"): unknown {
  return { type: "button", text: { type: "plain_text", text: label }, action_id, value, ...(style ? { style } : {}) };
}

/** One numbered decision of a spec: its text and its proposed default (null: none proposed). */
export interface SpecDecisionLine {
  n: number;
  text: string;
  default: string | null;
}

/** What Slack shows of a spec waiting for approval: its In short lines and its numbered decisions. */
export interface SpecSummary {
  in_short: string[];
  decisions: SpecDecisionLine[];
}

/** The lines under the `### <name>` heading of `lines`, up to the next heading. */
function sectionLines(lines: readonly string[], name: string): string[] {
  const at = lines.findIndex((l) => l.trim().startsWith(`### ${name}`));
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && /^#{1,3}\s/.test(l.trim()));
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

/** `1. <text> Proposed default: <d>.` (with ` (owner only)` maybe) as its parts; a line with no default keeps its text. */
function decisionOf(n: number, line: string): SpecDecisionLine {
  const m = /^(.*?)\s*Proposed default:\s*(.*?)\.?(?:\s*\(owner only\))?\s*$/.exec(line);
  return m ? { n, text: m[1]!.trim(), default: m[2]!.trim() } : { n, text: line.trim(), default: null };
}

/**
 * The spec comment `body` read by its headings, when it is a spec waiting for approval: it has the `## Factory spec`
 * heading and its command footer offers approve. Else null (another comment, or a spec approved with no reply).
 */
export function waitingSpec(body: string): SpecSummary | null {
  const lines = body.split(/\r?\n/);
  if (!lines.some((l) => l.trim() === "## Factory spec") || !footerCommands(body).includes("approve")) return null;
  const in_short = sectionLines(lines, "In short").map((l) => l.trim()).filter((l) => l !== "").slice(0, 3);
  const decisions = sectionLines(lines, "Decisions for you").flatMap((l) => {
    const m = /^\s*(\d+)\.\s+(.*)$/.exec(l);
    return m ? [decisionOf(Number(m[1]), m[2]!)] : [];
  });
  return { in_short, decisions };
}

/** `text` at most SECTION_MAX characters: a longer one is cut and ends with `cutNote(whole, link)`. */
function fitSection(text: string, whole: string, link?: string): string {
  if (text.length <= SECTION_MAX) return text;
  const note = cutNote(whole, link);
  return `${text.slice(0, SECTION_MAX - note.length - 1)}\n${note}`;
}

/**
 * The Slack message for a spec waiting for approval: "Needs your approval: <title>", In short (at most 3 lines),
 * Decisions (one line each, with its proposed default), and a Full spec link to the dashboard item page (`link`;
 * null: none). Problem, Applied defaults, Done when and the rest stay in the store and on the dashboard. Each section is
 * at most SECTION_MAX characters, a longer one cut with the note naming `factory task show <id>`. Buttons: Approve
 * with defaults, Other… when there is a decision, and Reject….
 */
export function renderSpecMessage(spec: SpecSummary, item: { id: string; title: string | null }, repo: RepoRef, link: string | null): SlackRendered {
  const whole = `factory task show ${item.id}`;
  const at = link ?? undefined;
  const first = `Needs your approval: ${escapeSlack(item.title ?? item.id)}`;
  const sections = [first, `*In short*\n${toMrkdwn(spec.in_short.join("\n"), repo)}`];
  if (spec.decisions.length > 0) {
    const lines = spec.decisions.map((d) => `${d.n}. ${inline(d.text, repo)}${d.default === null ? "" : ` _Proposed default: ${inline(d.default, repo)}_`}`);
    sections.push(`*Decisions*\n${lines.join("\n")}`);
  }
  if (link !== null) sections.push(`<${link.replace(/[<>|]/g, "")}|Full spec>`);
  const fitted = sections.map((t) => fitSection(t, whole, at));
  const buttons = [
    button("Approve with defaults", ACTION_SPEC_APPROVE, item.id, "primary"),
    ...(spec.decisions.length > 0 ? [button("Other…", ACTION_SPEC_OTHER, item.id)] : []),
    button("Reject…", ACTION_SPEC_REJECT, item.id),
  ];
  const blocks: unknown[] = [...fitted.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } })), { type: "actions", elements: buttons }];
  return { text: fitted[0]!, blocks };
}

const plain = (text: string, max: number) => ({ type: "plain_text", text: text.slice(0, max) || " " });

function modal(callback_id: string, title: string, submit: string, private_metadata: string, blocks: unknown[]): Record<string, unknown> {
  return { type: "modal", callback_id, private_metadata, title: plain(title, 24), submit: plain(submit, 24), close: plain("Cancel", 24), blocks };
}

/**
 * The Other… modal: one optional text field per decision (the first MODAL_FIELDS_MAX), labelled with the decision's
 * text and prefilled with its proposed default. `meta`: the thread's source ID, read back on submit.
 */
export function answersModal(decisions: readonly SpecDecisionLine[], meta: string): Record<string, unknown> {
  const blocks = decisions.slice(0, MODAL_FIELDS_MAX).map((d) => ({
    type: "input",
    block_id: `d${d.n}`,
    optional: true,
    label: plain(`${d.n}. ${d.text}`, LABEL_MAX),
    element: { type: "plain_text_input", action_id: MODAL_INPUT, max_length: INPUT_MAX, ...(d.default === null ? {} : { initial_value: d.default.slice(0, INPUT_MAX) }) },
  }));
  return modal(VIEW_SPEC_ANSWERS, "Answer the decisions", "Approve", meta, blocks);
}

/** The Reject… modal: one required reason field. */
export function rejectModal(meta: string): Record<string, unknown> {
  const reason = { type: "input", block_id: REASON_BLOCK, label: plain("Reason", LABEL_MAX), element: { type: "plain_text_input", action_id: MODAL_INPUT, multiline: true, max_length: INPUT_MAX } };
  return modal(VIEW_SPEC_REJECT, "Reject spec", "Reject", meta, [reason]);
}

/** One submitted field's text, its line breaks folded to spaces; "" when absent. */
function fieldOf(values: Record<string, unknown>, block: string): string {
  const el = (values[block] as Record<string, { value?: unknown }> | undefined)?.[MODAL_INPUT];
  return typeof el?.value === "string" ? el.value.replace(/\s+/g, " ").trim() : "";
}

/**
 * The command a submitted modal stands for, as typed in the thread: the answers modal's `/approve` with one `N: <answer>`
 * line per non-blank field, the reject modal's `/reject <reason>`. Null for another view. `values`: the view's
 * `state.values`, untrusted.
 */
export function modalCommand(callback_id: string, values: Record<string, unknown>): string | null {
  if (callback_id === VIEW_SPEC_REJECT) return `/reject ${fieldOf(values, REASON_BLOCK)}`.trim();
  if (callback_id !== VIEW_SPEC_ANSWERS) return null;
  const lines = Object.keys(values)
    .flatMap((b) => (/^d(\d{1,4})$/.exec(b) ? [Number(b.slice(1))] : []))
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const v = fieldOf(values, `d${n}`);
      return v === "" ? [] : [`${n}: ${v}`];
    });
  return ["/approve", ...lines].join("\n");
}
