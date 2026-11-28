// An item's thread, transcript and spec, and its commands: GET /api/v1/items/:id/runs/:run/transcript and
// POST /api/v1/items/:id/commands (postCommand).

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import { API } from "./routes.js";

/**
 * One entry of an item's thread. `role` `owner` is anything the owner sent (a command, a verdict, a message from a
 * source): `author` is then the stored user ID (`unknown` when the entry stores none), `kind` a command's name,
 * `channel` the item's source type or `cli` / `app` (the dashboard) for a command.
 */
export interface ThreadEntry {
  seq: number;
  at: string;
  kind: string;
  author: string;
  role: "factory" | "owner";
  channel: string;
  /** The entry's id on the item page: `msg-<seq>`. */
  anchor: string;
  body: string;
  /** The permission mode an owner command ran under; absent when the row stored none. */
  permission_mode?: "ask_all" | "ask_irreversible" | "full";
}

/** Which steps the transcript filter keeps (tool calls of that kind). */
export type StepFilter = "edits" | "commands" | "reads";

/** One step of a stored transcript; withheld text is "[withheld: <rule>]" and its tool is null. */
export interface TranscriptStep {
  id: string;
  kind: "text" | "tool_use" | "tool_result" | "result" | "system" | "error" | "plain" | "other" | "oversize";
  tool: string | null;
  text: string;
  is_error: boolean;
  withheld: boolean;
  truncated?: boolean;
}

/** One page of a run's stored transcript (GET /api/v1/items/<id>/runs/<run>/transcript). */
export interface TranscriptPage {
  run: {
    id: string;
    kind: string;
    status: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    worker_id: string | null;
    outcome: { status: string; error_code: string | null; detail: string | null; summary: string | null } | null;
  };
  parts: string[];
  part: string;
  format: "stream-json" | "plain";
  size: number;
  mode: "forward" | "tail";
  filter: StepFilter | null;
  start: number;
  /** The next page's byte offset; null at the end (or for a tail page). */
  next: number | null;
  /** Steps before `start` exist (a tail page, or a later forward page). */
  earlier: boolean;
  steps: TranscriptStep[];
}

/** The item API's `spec` (issue #526): what the decision panel and the approve confirm step show. */
export interface WaitingSpec {
  in_short: string | null;
  decisions: SpecDecision[];
}

/** One decision of a waiting spec: a question with 2 to 4 options (or none), the proposed default and why triage asks. */
export interface SpecDecision {
  question: string;
  options: string[];
  default: string | null;
  reason: string | null;
  owner_only: boolean;
  /** What picking an option changes; [] when no option changes anything (and on an older spec). */
  option_changes: OptionChange[];
  /** A layout decision: each option is a text sketch, shown in monospace. Absent on any other decision. */
  layout?: boolean;
}

/**
 * One option's changes to the spec: the paths it needs beyond the allowed paths, the done-when lines it changes,
 * and those of its paths the item's allowed_paths do not cover yet (an approve with it is refused until `+paths`).
 */
export interface OptionChange {
  option: string;
  extra_paths: string[];
  done_when: string[];
  uncovered_paths: string[];
}

export interface ItemCommand {
  name: string;
  usage: string;
  description: string;
  /** Whether the viewer's grants allow it (approve_spec, as the controller checks it). */
  allowed: boolean;
  /** Why not, in the controller's refusal words; null when allowed. */
  reason: string | null;
  /** The item stopped the same way three times or more: its main action is Revise or Reject, not Retry (primaryOf). */
  repeated_stop?: boolean;
  /**
   * Approve only, on an item over its size caps (design 04-split-specs): the size, the caps in force and the proposed
   * one-time cap, so the Needs you Approve asks for the note the controller would refuse it without. Absent otherwise.
   */
  over_cap?: OverCapSizes;
}

/** An over-cap Approve's figures, as the server's OverCapSizes (src/core/size-cap.ts). */
export interface OverCapSizes {
  sizes: { lines: number; files: number };
  caps: { max_diff_lines: number; max_diff_files: number };
  one_time_cap: { max_diff_lines: number; max_diff_files: number };
}

/** A stored proposal with its pending commands, each as its typed line and the item it is for. */
export interface ProposalView {
  id: string;
  created_at: string;
  commands: { index: number; work_item_id: string; line: string }[];
}

/** One app command request: `handled_at` null while the controller has not applied or refused it. */
export interface CommandReply {
  seq: number;
  command: string | null;
  created_at: string;
  handled_at: string | null;
  refusal: string | null;
}

/**
 * A refusal as the page shows it (issue #528): plain text, the controller's backticks dropped, and each item ID as
 * its 8-character short ID (design-system/writing.md: no raw IDs). The stored text keeps them, as GitHub, Slack and
 * the CLI show it.
 */
export function plainRefusal(text: string): string {
  return text.replace(/`/g, "").replace(/\bwi_([0-9a-z]{8})[0-9a-z]*\b/g, "$1");
}

/**
 * The item's state after an Approve or Merge the server applied while it handled the request (design
 * 09-dashboard-app): `phase` in the owner's words, `label` the row's words for it ("Approved", "Merging…"), null when
 * the request changed nothing.
 */
export interface RequestState {
  stage: string;
  blocked_on: string;
  blocked_reason: string | null;
  phase: string;
  label: string | null;
}

/**
 * A sent command: its seq; for Approve and Merge also `outcome` (applied, already_done, refused, or queued for the
 * controller), the item's `state` after it and the `refusal` in the controller's words.
 */
export type CommandResult =
  | { ok: true; seq: number; outcome?: string; state?: RequestState; refusal?: string | null }
  | { ok: false; error: string };

/**
 * POST /api/v1/items/:id/commands: `{ command, note }`, the note only when it has text; a proposal's Confirm all or
 * Cancel sends `{ command, proposal }` instead. 202 → the request's seq, and for Approve and Merge the item's new state.
 */
export async function postCommand(token: string, id: string, command: string, note: string, proposal?: string): Promise<CommandResult> {
  const text = note.trim();
  const body = proposal !== undefined ? { command, proposal } : text ? { command, note: text } : { command };
  const r = await postJson<{ seq?: number; error?: string; outcome?: string; state?: RequestState; refusal?: string | null }>(API.itemCommands(id), token, body);
  if (r.ok) {
    const { outcome, state, refusal } = r.value;
    return { ok: true, seq: r.value.seq ?? 0, ...(outcome ? { outcome } : {}), ...(state ? { state } : {}), ...(refusal ? { refusal } : {}) };
  }
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
