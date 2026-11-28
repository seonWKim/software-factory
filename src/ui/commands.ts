// Item commands from the status page (design §9, issue #227): POST /api/v1/items/:id/commands records one app
// command request (FactoryStore.recordAppCommandRequest) with the page's actor (`ui.user_id`, else on loopback the
// CLI identity: compose.ts uiCommandsActor). Approve and Merge are answered while the request is handled (design
// 09-dashboard-app, 2026-11-15): the owner check, then the controller's own store-only checks (core
// requestTransition); Approve is one conditional write, Merge writes nothing and answers "Merging…" until the
// controller's next pass enters the merge queue. The response carries the item's state, or the refusal. The
// controller does the rest (an approval's run, the merge itself); it authorizes and applies every other command, or
// refuses it with a reply (design §4, app requests).
//
// Guards, in order, every refusal before any store write: Host (server.ts), then an Origin equal to the Host's own
// http origin (403), Content-Type application/json (415), the per-process token in x-csrf-token (403, with code
// "stale_csrf": STALE_CSRF, which the page retries once with a fresh token), a
// an actor (503), a body of at most 16 KB (413), JSON (400), a known command with a valid note (400),
// a known item (404). Success is 202 with the request's ID (Approve and Merge: also `outcome` and `state`). GET /api/v1/session hands out the token behind the
// same Host guard. The item API's `commands` (each with the viewer's `allowed` and `reason`), `replies`, `spec` and
// `merge` fields are built here too.
// `merge` (design §9, the Merge button) is an app command beside the item commands, with no note: the local merge
// of `factory merge` for a local item, the PR's merge on the forge for any other.
// `restart` (design 09-dashboard-item-commands, the Restart app button) is an app command with no note too: on a
// merged item when `repo.restart_command` is set (UiCommands.restart), the same request `factory restart` stores.
// The command box (design 09-dashboard-app) sends `sentence` with the words as its note, for the controller's
// plain-words reader; a pending proposal's Confirm all sends `proposal_confirm` and its Cancel `proposal_cancel`, each
// with `proposal`, the proposal ID only. The item API's `proposals` lists the item's pending proposals, found by the
// marker of the replies in its thread. This process makes no model call and applies none of them.

import { randomUUID } from "node:crypto";
import { COMMAND_TABLE } from "../core/command-table.js";
import {
  COMMANDS, type CommandName, ROW_LABELS, commandPhase, commandSpec, commandsFor, itemCommandState, latestSpec, mergeQueued, mergeQueuedLabel, mergeRoute, noFilesRefusal,
  parseCommandPaths, phaseLabel, refusalText, requestTransition,
} from "../core/commands.js";
import { refusalReply } from "../core/authorize.js";
import { CONFIRM_COMMAND, INTERPRET_MAX_CHARS, isProposalId, parseProposalMarker, typed } from "../core/interpret.js";
import { CANCEL_APP_COMMAND, SENTENCE_APP_COMMAND } from "../core/local-cli.js";
import { MERGE_COMMAND } from "../core/local-merge.js";
import { RESTART_COMMAND, mergedIntoBase } from "../core/restart.js";
import { parseNeedsHuman } from "../core/outputs.js";
import { phaseOf } from "../core/phase.js";
import { isCovered } from "../core/policy.js";
import { type OverCapSizes, storedProjectCaps } from "../core/size-cap.js";
import { type SplitLimits, overCap } from "../core/split.js";
import type { Run, StateChange, UserId, WorkItem, WorkItemId } from "../core/types.js";
import type { AuthDecision } from "../interfaces/auth-provider.js";
import type { AppCommandRequest } from "../interfaces/factory-store.js";
import { answersDetail, splitAnswers } from "../shared/command-notes.js";
import type { UiDeps } from "./deps.js";
import type { Pending } from "./priority.js";
import { csrfMatches } from "./settings-api.js";
import { Withholder } from "./withhold.js";

/** What the commands route needs beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiCommands {
  /** The factory user the page's commands act as; null on a non-loopback server without ui.user_id (POST answers 503). */
  actor: UserId | null;
  /** Where the actor came from: `config` (ui.user_id or cli_user) or `environment` (git user.email, the OS user). */
  source: "config" | "environment" | null;
  /** Random, per process; held only in memory. GET /api/v1/session returns it, POST must send it in x-csrf-token. */
  token: string;
  /**
   * Whether `actor` may send `action` on the project: the owner check the controller applies to every command
   * (compose.ts, src/core/authorize.ts), asked read-only: an allowed answer writes no authz_audit row, a refusal one.
   * Absent (a page with no auth wired): see actorGrant.
   */
  allowed?: (action: PageAction) => Promise<AuthDecision>;
  /** Whether a forge is selected (`plugins.forge`), for a PR's Merge; set by compose.ts buildUiParts. Absent: not known here; the controller still checks. */
  forge?: boolean;
  /** Whether the controller's sandbox can merge locally, for a local item's Merge; set by compose.ts buildUiParts. Absent: not known here; the controller still checks. */
  localMerge?: boolean;
  /** How a refusal names the item's PR, as the controller names it (`PR #N`); set by compose.ts buildUiParts, so ui writes no change-ref form. Absent: the bare ref. */
  changeName?: (change_ref: string) => string;
  /** Whether `repo.restart_command` is set, so a merged item offers Restart app; set by compose.ts buildUiParts. Absent: not offered. */
  restart?: boolean;
}

/** The largest commands body read. A command and a 2000-character note fit well inside it. */
export const MAX_COMMAND_BODY = 16 * 1024;
/** The longest note a command takes. */
export const MAX_NOTE = 2000;
/** The replies the item API lists: the newest this many of the item's requests. */
export const REPLIES_LIMIT = 50;
/** A command the page may send: an item command, the local merge or the restart, neither of which has a comment command. */
export type AppCommand = CommandName | typeof MERGE_COMMAND | typeof RESTART_COMMAND;
const COMMENT_NAMES: readonly string[] = COMMANDS.map((c) => c.name);
/**
 * Commands the page may send: every item command but `/help` and the account command `/link`, then the command
 * table's other item commands (`merge`), so a new item command in the table reaches the page too, then `restart`.
 */
export const APP_COMMANDS: readonly AppCommand[] = [
  ...COMMANDS.map((c) => c.name).filter((n) => n !== "help" && n !== "link"),
  ...COMMAND_TABLE.filter((c) => c.item && !COMMENT_NAMES.includes(c.name)).map((c) => c.name as AppCommand),
  RESTART_COMMAND,
];
/** Commands that take no note. */
const NO_NOTE: readonly AppCommand[] = [MERGE_COMMAND, RESTART_COMMAND];
/** Commands that need text: the reason or the feedback. */
const NEEDS_TEXT: readonly AppCommand[] = ["reject", "revise"];

const PATH = /^\/api\/v1\/items\/([^/]+)\/commands$/;

/** The item id in a commands path (raw, still percent-encoded), or null for any other path. */
export function commandsPathId(rawUrl: string | undefined): string | null {
  const path = (rawUrl ?? "/").split(/[?#]/, 1)[0]!;
  return PATH.exec(path)?.[1] ?? null;
}

export interface CommandsRequest {
  host: string | undefined;
  origin?: string | undefined;
  contentType?: string | undefined;
  csrfToken?: string | undefined;
  body?: string | undefined;
  bodyTooLarge?: boolean;
}

export interface CommandsResult {
  status: number;
  value: unknown;
}

const err = (status: number, error: string): CommandsResult => ({ status, value: { error } });

/** The 503 with no actor: commands need ui.user_id off loopback. */
const COMMANDS_OFF = "Commands are off: this server is not on loopback, so it needs ui.user_id. Settings (/app/settings#page-commands) says what to set.";

/** The code of the missing-or-stale-token 403: the page fetches a fresh token from GET /api/v1/session and retries once. */
export const STALE_CSRF = "stale_csrf";
/** The 403 for a missing or stale x-csrf-token, on every write route; the only 403 that carries a code. */
export const staleCsrf = (): CommandsResult => ({ status: 403, value: { error: "Missing or stale x-csrf-token; reload the page.", code: STALE_CSRF } });

/** The Content-Type's media type, lowercased, without parameters. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/** A proposal's Confirm all and Cancel: the page's requests that name a stored proposal by its ID. */
const PROPOSAL_REQUESTS: readonly string[] = [CONFIRM_COMMAND, CANCEL_APP_COMMAND];

/** What the page may send: an item command with its note, a sentence (its words as the note), or a proposal's request. */
export type PageRequest = { command: AppCommand; note?: string } | { command: typeof SENTENCE_APP_COMMAND; note: string } | { command: string; proposal: string };

/** The body as a request, or why it is not one. */
export function parseCommand(body: unknown): PageRequest | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "command" && k !== "note" && k !== "proposal");
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.command === "string" && PROPOSAL_REQUESTS.includes(b.command)) {
    if (b.note !== undefined) return { error: `${b.command} takes no note` };
    return typeof b.proposal === "string" && isProposalId(b.proposal) ? { command: b.command, proposal: b.proposal } : { error: "proposal must be a proposal ID" };
  }
  if (b.proposal !== undefined) return { error: `unknown field "proposal"` };
  if (b.command === SENTENCE_APP_COMMAND) {
    const words = typeof b.note === "string" ? b.note.trim() : "";
    if (words === "") return { error: "sentence needs your words" };
    if (words.length > INTERPRET_MAX_CHARS) return { error: `sentence must be at most ${INTERPRET_MAX_CHARS} characters` };
    return { command: SENTENCE_APP_COMMAND, note: words };
  }
  if (typeof b.command !== "string" || !APP_COMMANDS.includes(b.command as AppCommand)) {
    return { error: `command must be one of ${[...APP_COMMANDS, SENTENCE_APP_COMMAND, ...PROPOSAL_REQUESTS].join(", ")}` };
  }
  const command = b.command as AppCommand;
  if (b.note !== undefined && typeof b.note !== "string") return { error: "note must be a string" };
  const note = typeof b.note === "string" ? b.note : "";
  if (note.length > MAX_NOTE) return { error: `note must be at most ${MAX_NOTE} characters` };
  const text = note.trim();
  if (NO_NOTE.includes(command) && text !== "") return { error: `${command} takes no note` };
  if (NEEDS_TEXT.includes(command) && text === "") return { error: `${command} needs text: ${command === "reject" ? "your reason" : "your feedback"}` };
  return text === "" ? { command } : { command, note: text };
}

/**
 * POST /api/v1/items/:id/commands after the Host check (server.ts). `rawId` is the path's id, still encoded.
 * Writes at most one app_command_requests row, and only after every check passed.
 */
export async function commandsPost(d: UiDeps, rawId: string, req: CommandsRequest): Promise<CommandsResult> {
  const own = `http://${(req.host ?? "").trim().toLowerCase()}`;
  if (req.origin === undefined || req.origin.trim().toLowerCase() !== own) return err(403, "Origin must be this page's own origin.");
  if (mediaType(req.contentType) !== "application/json") return err(415, "Content-Type must be application/json.");
  const c = d.commands;
  const off = err(503, COMMANDS_OFF);
  if (!c) return off;
  if (!csrfMatches(c.token, req.csrfToken)) return staleCsrf();
  if (c.actor === null) return off;
  if (req.bodyTooLarge || Buffer.byteLength(req.body ?? "", "utf8") > MAX_COMMAND_BODY) return err(413, "The body is too large.");
  let body: unknown;
  try {
    body = JSON.parse(req.body ?? "");
  } catch {
    return err(400, "The body must be JSON.");
  }
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // The body's own error comes first, as before: a bad body is a 400 whatever the path's id.
    const parsed = parseCommand(body);
    return "error" in parsed ? err(400, parsed.error) : err(404, "No such work item.");
  }
  return itemCommandSend(d, id, body);
}

/**
 * One item command request after the route's guards (Origin, Content-Type, token, body size): the body checked by
 * parseCommand, the item looked up, then one app_command_requests row and, for Approve and Merge, applyNow's owner
 * check and transition. commandsPost and the chat's chat.command capability (design 04-chat-commands) both end here,
 * so a button in the chat sends exactly what the item page and a typed command send.
 */
export async function itemCommandSend(d: UiDeps, id: string, body: unknown): Promise<CommandsResult> {
  const c = d.commands;
  if (!c || c.actor === null) return err(503, COMMANDS_OFF);
  const parsed = parseCommand(body);
  if ("error" in parsed) return err(400, parsed.error);
  const item = await d.store.getWorkItem(id as WorkItemId);
  if (!item) return err(404, "No such work item.");
  const key = `app:${randomUUID()}`;
  const args: Record<string, unknown> = {
    work_item_id: item.id, ...("note" in parsed && parsed.note !== undefined ? { note: parsed.note } : {}), ...("proposal" in parsed ? { proposal: parsed.proposal } : {}),
  };
  const { request } = await d.store.recordAppCommandRequest({ key, actor: c.actor, command: parsed.command, args });
  const value = { request_id: request.key, seq: request.seq, command: request.command, work_item_id: item.id };
  return { status: 202, value: { ...value, ...(await applyNow(d, request, item)) } };
}

/** The commands the request path applies while the request is handled; every other one waits for the controller. */
const APPLIED_NOW: readonly string[] = ["approve", MERGE_COMMAND];

/**
 * Approve and Merge applied now (core requestTransition, design 09-dashboard-app): `outcome` (applied, already_done,
 * refused or queued for the controller), the item's `state` after it (stage, blocked_on, blocked_reason, its phase in
 * the owner's words and the row's label) and the refusal in the controller's words, through the Withholder. Nothing
 * for any other command, or with no owner check wired (UiCommands.allowed): the controller applies the request then.
 */
async function applyNow(d: UiDeps, r: AppCommandRequest, item: WorkItem): Promise<Record<string, unknown>> {
  const c = d.commands;
  if (!c?.allowed || !APPLIED_NOW.includes(r.command) || (r.command === "approve" && (await overCapApprove(d, item)))) return {};
  const done = (r.command === "approve" ? await noFilesApprove(d, c.allowed, r, item) : null) ?? await requestTransition({
    store: d.store, scanner: d.scanner, allowed: c.allowed, answers: { split: splitAnswers, detail: answersDetail }, changeName: c.changeName ?? String, forge: c.forge, localMerge: c.localMerge,
  }, r, item);
  const it = done.item;
  const refusal = done.outcome === "refused" ? (await new Withholder(d.scanner).plain(done.refusal, { channel: "ui" })).text : null;
  const label = done.label ?? (mergeQueued(it) ? ROW_LABELS.merging : it.stage === "CLOSED" && it.merge_sha ? ROW_LABELS.merged : null);
  return {
    outcome: done.outcome,
    state: { stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason, phase: phaseLabel(commandPhase(it)), label },
    refusal,
  };
}

/**
 * An Approve over the item's size caps (design 04-split-specs, 2026-11-24): at too_large, or a spec at its size
 * checkpoint against the caps the controller reads (storedProjectCaps). Left to the controller, which refuses it
 * without a note in the thread or stores the one-time cap with its `size_cap_approved` record.
 */
async function overCapApprove(d: UiDeps, item: WorkItem): Promise<boolean> {
  const it = (await d.store.getWorkItem(item.id)) ?? item, runs = await d.store.listRuns(it.id);
  return overCap(it, runs, await d.store.listStateChanges(it.id), latestSpec(runs), await projectCaps(d, it.project)) !== null;
}

/** A project's size caps as the controller reads them (storedProjectCaps): the over-cap checks of the request path and the item API. */
export async function projectCaps(d: UiDeps, project: string): Promise<SplitLimits> {
  const s = d.settings;
  const key = s ? ((await s.resolveProject())?.key ?? null) : null, owner = s ? `${s.repo.owner}/${s.repo.name}` : "";
  return storedProjectCaps(d.store, s?.base ?? NO_SETTINGS_FILE, owner, key, project);
}

/** The settings base with no config file: the built-in caps, then the stored overrides. */
const NO_SETTINGS_FILE = { file: {}, layers: { defaults: {}, projects: {} } };

/**
 * An Approve of a spec that changes no file in this repo (design 04-spec-gate-commands, 2026-11-20): refused with the
 * controller's reply (core noFilesRefusal) once the owner check passed, the request marked handled so the controller
 * posts nothing; null for any other approve, which requestTransition answers (a failed owner check too).
 */
async function noFilesApprove(
  d: UiDeps, allowed: NonNullable<UiCommands["allowed"]>, r: AppCommandRequest, item: WorkItem,
): Promise<{ outcome: "refused"; item: WorkItem; label: null; refusal: string } | null> {
  const it = (await d.store.getWorkItem(item.id)) ?? item;
  const reason = noFilesRefusal(it, await d.store.listRuns(it.id));
  if (reason === null || !(await allowed("approve_spec")).allow) return null;
  const refusal = refusalText("/approve", reason);
  await d.store.markAppCommandRequest(r.seq, refusal);
  return { outcome: "refused", item: it, label: null, refusal };
}

/** GET /api/v1/session: the per-process token, whether commands are on, and who they act as; null (a 404) when not wired. */
export function readSession(d: UiDeps, now: Date): Record<string, unknown> | null {
  if (!d.commands) return null;
  return { as_of: now.toISOString(), csrf_token: d.commands.token, commands_enabled: d.commands.actor !== null, actor: d.commands.actor, actor_source: d.commands.source };
}

/** The actions the page asks about for its actor: approve_spec for the item commands, approve_merge for Merge. */
export type PageAction = "approve_spec" | "approve_merge";

/**
 * The page actor's grant of one action: allowed, or refused with the controller's reply (refusalReply). `restart`:
 * the server offers Restart app (UiCommands.restart), carried here because the item API hands itemCommands the grant.
 */
export type ActorGrant = ({ allow: true } | { allow: false; reason: string }) & {
  restart?: boolean;
  /** The item's state changes, for the rows' `repeated_stop` (stopCount) and an Approve's one-time cap (overCapRow); carried here for the same reason. Absent: not read. */
  changes?: (id: WorkItemId) => Promise<readonly StateChange[]>;
};

/**
 * Whether the page's actor holds `action`, as the controller checks it for an app command (design §9): the owner check
 * on the project (UiCommands.allowed, no forge call). In solo use the first identity becomes the local owner there. Asked at most once per call of the result, so a
 * request asks once however many items or commands it lists. When it cannot be asked here (commands off, or no auth
 * wired), approve_spec is allowed (the controller still checks every command it applies) and approve_merge is not
 * (Merge stays disabled).
 */
export function actorGrant(d: UiDeps, action: PageAction): () => Promise<ActorGrant> {
  let asked: Promise<ActorGrant> | null = null;
  const carried = { ...(d.commands?.restart === true ? { restart: true } : {}), changes: (id: WorkItemId) => d.store.listStateChanges(id) };
  const ask = async (): Promise<ActorGrant> => {
    const c = d.commands;
    if (c?.actor == null || !c.allowed) return action === "approve_spec" ? { allow: true, ...carried } : { allow: false, reason: NOT_MERGER, ...carried };
    const decision = await c.allowed(action);
    return decision.allow ? { allow: true, ...carried } : { allow: false, reason: refusalReply(decision.reason), ...carried };
  };
  return () => (asked ??= ask());
}

/** One entry of the item API's `commands`: a command that applies now, and whether the viewer may send it. */
export interface ItemCommandRow {
  name: CommandName | typeof RESTART_COMMAND;
  usage: string;
  description: string;
  allowed: boolean;
  /** Why the viewer may not send it, in the controller's refusal words (through the Withholder); null when allowed. */
  reason: string | null;
  /**
   * A permission ask's paths (approve, retry or resolve only): the paths the run's needs_human names outside the
   * allowed paths, which the decision's button sends as `+paths`; or, on resolve only, the files of an out_of_scope
   * resolve failure's `/resolve +paths` reply (`out_of_scope` true). Absent when the item holds no such ask.
   */
  paths?: string[];
  /** The paths are an out_of_scope resolve failure's (scopePaths): the page's button is Allow and resolve, behind a confirm dialog. Absent otherwise. */
  out_of_scope?: true;
  /** The item stopped the same way REPEATED_STOP times or more (stopCount): the page's main action is Revise or Reject, not Retry. Absent otherwise. */
  repeated_stop?: true;
  /**
   * Approve only, on an item over its size caps (overCap, design 04-split-specs): the size, the caps in force and the
   * proposed one-time cap the controller's refusal names (overCapNoteRequired), so the page asks for the note first. Absent otherwise.
   */
  over_cap?: OverCapSizes;
}

/** The identical stops from which an item's main action is Revise or Reject (design 09-dashboard-item-commands, 2026-11-20). */
export const REPEATED_STOP = 3;

/** How many state changes set the item's current blocked_reason, the current stop included (0 when it has none). */
export function stopCount(it: Pick<WorkItem, "blocked_reason">, changes: readonly StateChange[]): number {
  if (it.blocked_reason === null) return 0;
  return changes.filter((c) => c.changes.blocked_reason?.to === it.blocked_reason).length;
}

/** What the `restart` row says it does. */
const RESTART_DESCRIPTION = "Run repo.restart_command in the repo's base checkout, so the running app serves the merged code; its result is posted in the thread";
/** The commands that take `+paths` (design §4, issue #280). */
const PATHS_COMMANDS: readonly string[] = ["approve", "retry", "resolve"];

/** The reply an out_of_scope resolve failure's detail starts with (resolveScopeDetail, src/worker/support.ts); its group is the `+paths` line. */
const RESOLVE_REPLY = /^Reply `\/resolve (\+paths [^`]+)` to allow them/;

/**
 * The paths of the `/resolve +paths` reply an out_of_scope resolve failure's `detail` names, read with the CLI's parser
 * (parseCommandPaths), so a path the CLI would refuse names none; none when the detail names no such reply.
 */
export function resolveScopePaths(detail: string): string[] {
  const reply = RESOLVE_REPLY.exec(detail)?.[1];
  const parsed = reply ? parseCommandPaths(reply, "/resolve") : null;
  return parsed && "paths" in parsed ? parsed.paths : [];
}

/** At merge_conflict, the files of the newest resolve run's out_of_scope reply (resolveScopePaths); none for any other item. */
function scopePaths(it: WorkItem, runs: readonly Run[]): string[] {
  if (phaseOf(it) !== "merge_conflict") return [];
  const o = [...runs].reverse().find((r) => r.kind === "resolve")?.outcome;
  return o?.status === "failed" && o.error_code === "out_of_scope" ? resolveScopePaths(o.detail) : [];
}

/**
 * The paths an item asks to allow (design 09-dashboard-item-commands) and the commands that send them: at
 * agent_needs_human, the latest ask's (needs_human of the newest succeeded run that has one, as src/ui/need.ts reads
 * it) `paths`, on PATHS_COMMANDS; at merge_conflict, an out_of_scope resolve failure's reply (scopePaths), on resolve
 * only. Each path no allowed path covers yet, once (through `text`, the Withholder: a path the scan changes is left out).
 */
async function askedPaths(it: WorkItem, runs: readonly Run[], text: (v: string) => Promise<string | null>): Promise<{ paths: string[]; on: readonly string[]; scope: boolean }> {
  const scope = scopePaths(it, runs);
  const asks = phaseOf(it) !== "agent_needs_human" ? [] : [...runs].reverse().flatMap((r) => {
    if (r.outcome?.status !== "succeeded") return [];
    const ask = parseNeedsHuman(r.outcome.data.needs_human);
    return ask.ok && ask.value ? [ask.value] : [];
  });
  const named = [...new Set(scope.length > 0 ? scope : (asks[0]?.paths ?? []))].filter((p) => !isCovered(p, it.allowed_paths));
  const shown: string[] = [];
  for (const p of named) if ((await text(p)) === p) shown.push(p);
  return { paths: shown, on: scope.length > 0 ? ["resolve"] : PATHS_COMMANDS, scope: scope.length > 0 };
}

/**
 * The item API's `commands`: what the page may send in the item's state, from the comment footer's table, each with
 * whether the viewer's grant allows it and, when not, the reason the controller would refuse it with (through `text`,
 * the Withholder: it names a user ID). Every command but `merge` (its own button) needs approve_spec, as the
 * controller checks it; `/verdict`'s record_verdict comes with the same role. Not `/help`: it answers a comment and the
 * page cannot send it (APP_COMMANDS), so a button for it could only be refused. A permission ask's paths go on the
 * commands that take `+paths`, an out_of_scope resolve failure's on resolve (askedPaths). A merged item gets `restart` (the Restart app button) when the server
 * offers it (`grant.restart`), with the same grant as the item commands. With the project's `caps` (projectCaps), an
 * Approve over the item's caps carries `over_cap` (overCapRow); without them, or not over, the row is as it was.
 */
export async function itemCommands(
  it: WorkItem, runs: readonly Run[], grant: ActorGrant, text: (v: string) => Promise<string | null>, caps: SplitLimits | null = null,
): Promise<ItemCommandRow[]> {
  const reason = grant.allow ? null : await text(grant.reason);
  const asked = await askedPaths(it, runs, text);
  const cmds = commandsFor(itemCommandState(it, runs)).filter((c) => APP_COMMANDS.includes(c.name));
  // Its state changes say how often the item stopped with its current blocked_reason, and hold its one-time cap (none read when neither is asked).
  const changes = (it.blocked_reason !== null || caps) && grant.changes ? await grant.changes(it.id) : [];
  const stops = it.blocked_reason !== null ? stopCount(it, changes) : 0;
  const rows: ItemCommandRow[] = cmds.map((c) => ({
    name: c.name, usage: c.usage, description: c.description, allowed: grant.allow, reason,
    ...(asked.paths.length > 0 && asked.on.includes(c.name) ? { paths: asked.paths, ...(asked.scope ? { out_of_scope: true as const } : {}) } : {}),
    ...(stops >= REPEATED_STOP ? { repeated_stop: true as const } : {}),
  }));
  const over = caps && rows.some((r) => r.name === "approve") ? overCapRow(it, runs, changes, caps) : null;
  if (over) for (const r of rows) if (r.name === "approve") r.over_cap = over;
  if (grant.restart === true && mergedIntoBase(it)) rows.push({ name: RESTART_COMMAND, usage: RESTART_COMMAND, description: RESTART_DESCRIPTION, allowed: grant.allow, reason });
  return rows;
}

/** The over-cap figures of an Approve on `it` (overCap): its size, the caps in force and the one-time cap; null when not over or no size was recorded. */
function overCapRow(it: WorkItem, runs: readonly Run[], changes: readonly StateChange[], caps: SplitLimits): OverCapSizes | null {
  const over = overCap(it, runs, changes, latestSpec(runs), caps);
  return over && "at" in over ? { sizes: over.sizes, caps: over.caps, one_time_cap: over.one_time_cap } : null;
}

/** The phases whose Needs-you commands read the item's runs: the run that asked decides the commands, a failed resolve run's reply the paths, or the size an Approve is over its caps by. */
const RUNS_READ: readonly string[] = ["agent_needs_human", "too_large", "spec_pending", "max_revisions", "merge_conflict"];

/**
 * A Needs-you row's `commands` (design §9): the item API's entries for the commands that change the item's state, from
 * the command rules, but not `budget` (its tokens are typed on the item page or the issue), then `verdict` where it
 * applies (an item with a PR, or a local item: issue #513), sent from its own text form; with the viewer's `allowed`
 * and `reason` from `grant`, asked once per request. The item's runs and its project's `caps` are read only in RUNS_READ,
 * where the run that asked decides which commands apply, or an Approve may be over the caps (`over_cap`).
 */
export async function needsYouCommands(
  d: UiDeps, it: WorkItem, grant: () => Promise<ActorGrant>, text: (v: string) => Promise<string | null>, caps: (project: string) => Promise<SplitLimits>,
) {
  const read = RUNS_READ.includes(phaseOf(it));
  const runs = read ? await d.store.listRuns(it.id) : [];
  const all = await itemCommands(it, runs, await grant(), text, read ? await caps(it.project) : null);
  return all.filter((c) => c.name === "verdict" || (c.name !== "budget" && c.name !== RESTART_COMMAND && commandSpec(c.name).changes_state));
}

/**
 * The item API's `spec` (issue #526): the In short and the decisions of a spec waiting for approval (or at the
 * revision limit), from the latest applied triage run's stored output; null for any other item. Every text passes
 * `text` (the Withholder). Store reads only: the caller passes the item's runs.
 */
export async function waitingSpec(it: WorkItem, runs: readonly Run[], text: (v: string | null) => Promise<string | null>) {
  const phase = phaseOf(it);
  if (phase !== "spec_pending" && phase !== "max_revisions") return null;
  const spec = latestSpec(runs);
  if (!spec) return null;
  const decisions = [];
  for (const d of spec.decision_items ?? []) {
    const options = [];
    for (const o of d.options ?? []) options.push((await text(o))!);
    // Each option's changes (design 09-dashboard-item-commands, 2026-11-21), with the extra paths the item's
    // allowed_paths do not cover: the approve dialog warns about those before anything is sent.
    const option_changes = [];
    for (const c of d.option_changes ?? []) {
      const done_when = [];
      for (const l of c.done_when) done_when.push((await text(l))!);
      option_changes.push({
        option: (await text(c.option))!, extra_paths: c.extra_paths, done_when, uncovered_paths: c.extra_paths.filter((p) => !isCovered(p, it.allowed_paths)),
      });
    }
    decisions.push({
      question: (await text(d.text))!, options, default: await text(d.default), reason: await text(d.reason ?? null), owner_only: d.owner_only, option_changes,
      ...(d.layout ? { layout: true } : {}),
    });
  }
  return { in_short: await text(spec.in_short), decisions };
}

/**
 * The item API's `proposals`: each stored proposal a reply in the item's thread names by its marker
 * (parseProposalMarker), oldest first, with its pending commands as typed lines (through `text`, the Withholder); a
 * proposal with none pending is left out. Store reads only: the thread and listCommandProposals.
 */
export async function itemProposals(d: UiDeps, id: WorkItemId, text: (v: string) => Promise<string | null>) {
  const ids = new Set<string>();
  for (const m of await d.store.listItemMessages(id)) {
    const marker = parseProposalMarker(m.body);
    if (marker) ids.add(marker.id);
  }
  const out = [];
  for (const proposal of ids) {
    const pending = (await d.store.listCommandProposals(proposal)).filter((r) => r.status === "pending");
    if (pending.length === 0) continue;
    const commands = [];
    for (const r of pending) commands.push({ index: r.idx, work_item_id: r.work_item_id, line: (await text(typed(r))) ?? "" });
    out.push({ id: proposal, created_at: pending[0]!.created_at, commands });
  }
  return out;
}

/** The item API's `replies`: the item's app requests; the refusal and command pass `text`, the note never leaves. */
export async function itemReplies(d: UiDeps, id: WorkItemId, text: (v: string | null) => Promise<string | null>) {
  const out = [];
  for (const r of await d.store.listAppCommandRequestsForItem(id, REPLIES_LIMIT)) {
    out.push({ seq: r.seq, command: await text(r.command), created_at: r.created_at, handled_at: r.handled_at, refusal: await text(r.refusal) });
  }
  return out;
}

/** The item API's `merge` (design §9, the Merge button): enabled, or disabled with the reason in plain words. */
export type MergeReadiness = { enabled: true; reason: null } | { enabled: false; reason: string };

/** The reason of an item that is not waiting for a merge: the app shows no Merge button for it. */
export const NOT_WAITING = "not waiting for a merge";

/** What mergeReadiness reads of the item's merge check (the item API's `merge_check`). */
export interface MergeCheckState {
  state: "mergeable" | "checking" | "conflicts";
  conflicts: readonly unknown[];
}

/** The Merge button's reason when the page's user may not merge. */
const NOT_MERGER = "not allowed to merge (approve_merge)";

const off = (reason: string): MergeReadiness => ({ enabled: false, reason });

/**
 * The item API's `merge`, from stored state only (no forge call): enabled for an item waiting for its merge that
 * the page's user may merge. A local item with no PR merges through the local merge, any item with a PR through
 * its PR on the forge (design 05-sources). The merge check applies to a factory PR, the one item it runs for. The
 * controller checks everything again when it applies the request; GitHub checks the head at merge time. `pending`:
 * the item's pending command (list.ts pendingOf), the rule the ranking reads too.
 */
export async function mergeReadiness(d: UiDeps, it: WorkItem, check: MergeCheckState | null, allowed: () => Promise<ActorGrant>, pending: Pending | null = null): Promise<MergeReadiness> {
  // Merge taken by the controller (design 09-dashboard-item-commands): the merge queue checks a local item's merged result.
  if (mergeQueued(it)) return off(ROW_LABELS.checking);
  if (commandPhase(it) !== "merge_pending") return off(NOT_WAITING);
  // A Merge stored and not handled yet: the controller takes it on a later pass, so until then it reads its place in line.
  if (pending?.command === "merge") return off(mergeQueuedLabel(pending.position));
  // The controller's route: a local item with no PR takes the local merge, an item with a PR its PR's merge.
  const local = mergeRoute(it) === "local";
  if (!local && it.change_ref === null) return off("no PR to merge");
  if (!local && d.commands?.forge === false) return off("no forge selected");
  if (local && d.commands?.localMerge === false) return off("no sandbox that can merge");
  if (!local && it.head_branch === null && check) {
    if (check.state === "checking") return off("merge check running");
    const n = check.conflicts.length;
    if (check.state === "conflicts") return off(`${n} conflicting ${n === 1 ? "file" : "files"}`);
  }
  if (d.commands?.actor == null) return off("commands are off");
  if (!(await allowed()).allow) return off(NOT_MERGER);
  return { enabled: true, reason: null };
}
