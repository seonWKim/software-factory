// Item commands from the status page (design §9, issue #227): POST /api/v1/items/:id/commands records one app
// command request (FactoryStore.recordAppCommandRequest) with the page's actor (`ui.user_id`, else on loopback the
// CLI identity: compose.ts uiCommandsActor); the controller authorizes and applies
// it on its next tick, or refuses it with a reply (design §4, app requests). This module never applies a command.
//
// Guards, in order, every refusal before any store write: Host (server.ts), then an Origin equal to the Host's own
// http origin (403), Content-Type application/json (415), the per-process token in x-csrf-token (403), a
// an actor (503), a body of at most 16 KB (413), JSON (400), a known command with a valid note (400),
// a known item (404). Success is 202 with the request's ID. GET /api/v1/session hands out the token behind the
// same Host guard. The item API's `commands` (each with the viewer's `allowed` and `reason`), `replies`, `spec` and
// `merge` fields are built here too.
// `merge` (design §9, the Merge button) is an app command beside the item commands, with no note: the local merge
// of `factory merge` for a local item, the PR's merge on the forge for any other.

import { randomUUID } from "node:crypto";
import { COMMAND_TABLE } from "../core/command-table.js";
import { COMMANDS, type CommandName, commandPhase, commandSpec, commandsFor, itemCommandState, latestSpec, roleRefusal } from "../core/commands.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../core/local-merge.js";
import type { Run, UserId, WorkItem, WorkItemId } from "../core/types.js";
import type { AuthDecision } from "../interfaces/auth-provider.js";
import type { UiDeps } from "./pages.js";
import { csrfMatches } from "./settings-api.js";

/** What the commands route needs beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiCommands {
  /** The factory user the page's commands act as; null on a non-loopback server without ui.user_id (POST answers 503). */
  actor: UserId | null;
  /** Where the actor came from: `config` (ui.user_id or cli_user) or `environment` (git user.email, the OS user). */
  source: "config" | "environment" | null;
  /** Random, per process; held only in memory. GET /api/v1/session returns it, POST must send it in x-csrf-token. */
  token: string;
  /**
   * Whether `actor` holds `action` on the project, over the local grants only (no forge call), as the controller
   * checks a command with the configured auth plugin (compose.ts). Absent (a page with no auth wired): see actorGrant.
   */
  allowed?: (action: PageAction) => Promise<AuthDecision>;
  /** The actor's edge passport (Identity, RFC 0015 §8), stored on each request row. Absent: none. */
  passport?: () => Promise<string>;
  /** Whether a forge is selected (`plugins.forge`), for a PR's Merge; set by compose.ts buildUiParts. Absent: not known here; the controller still checks. */
  forge?: boolean;
  /** Whether the controller's sandbox can merge locally, for a local item's Merge; set by compose.ts buildUiParts. Absent: not known here; the controller still checks. */
  localMerge?: boolean;
}

/** The largest commands body read. A command and a 2000-character note fit well inside it. */
export const MAX_COMMAND_BODY = 16 * 1024;
/** The longest note a command takes. */
export const MAX_NOTE = 2000;
/** The replies the item API lists: the newest this many of the item's requests. */
export const REPLIES_LIMIT = 50;
/** A command the page may send: an item command, or the local merge, which has no comment command. */
export type AppCommand = CommandName | typeof MERGE_COMMAND;
const COMMENT_NAMES: readonly string[] = COMMANDS.map((c) => c.name);
/**
 * Commands the page may send: every item command but `/help` and the account command `/link`, then the command
 * table's other item commands (`merge`), so a new item command in the table reaches the page too.
 */
export const APP_COMMANDS: readonly AppCommand[] = [
  ...COMMANDS.map((c) => c.name).filter((n) => n !== "help" && n !== "link"),
  ...COMMAND_TABLE.filter((c) => c.item && !COMMENT_NAMES.includes(c.name)).map((c) => c.name as AppCommand),
];
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

/** The Content-Type's media type, lowercased, without parameters. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/** The body as a command, or why it is not one. */
export function parseCommand(body: unknown): { command: AppCommand; note?: string } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "command" && k !== "note");
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.command !== "string" || !APP_COMMANDS.includes(b.command as AppCommand)) {
    return { error: `command must be one of ${APP_COMMANDS.join(", ")}` };
  }
  const command = b.command as AppCommand;
  if (b.note !== undefined && typeof b.note !== "string") return { error: "note must be a string" };
  const note = typeof b.note === "string" ? b.note : "";
  if (note.length > MAX_NOTE) return { error: `note must be at most ${MAX_NOTE} characters` };
  const text = note.trim();
  if (command === MERGE_COMMAND && text !== "") return { error: "merge takes no note" };
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
  const off = err(503, "Commands are off: this server is not on loopback, so it needs ui.user_id. Settings (/app/settings#page-commands) says what to set.");
  if (!c) return off;
  if (!csrfMatches(c.token, req.csrfToken)) return err(403, "Missing or stale x-csrf-token; reload the page.");
  if (c.actor === null) return off;
  if (req.bodyTooLarge || Buffer.byteLength(req.body ?? "", "utf8") > MAX_COMMAND_BODY) return err(413, "The body is too large.");
  let body: unknown;
  try {
    body = JSON.parse(req.body ?? "");
  } catch {
    return err(400, "The body must be JSON.");
  }
  const parsed = parseCommand(body);
  if ("error" in parsed) return err(400, parsed.error);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return err(404, "No such work item.");
  }
  const item = await d.store.getWorkItem(id as WorkItemId);
  if (!item) return err(404, "No such work item.");
  const key = `app:${randomUUID()}`;
  const args: Record<string, unknown> = { work_item_id: item.id, ...(parsed.note === undefined ? {} : { note: parsed.note }) };
  const passport_id = await c.passport?.();
  const { request } = await d.store.recordAppCommandRequest({ key, actor: c.actor, command: parsed.command, args, ...(passport_id ? { passport_id } : {}) });
  return { status: 202, value: { request_id: request.key, seq: request.seq, command: request.command, work_item_id: item.id } };
}

/** GET /api/v1/session: the per-process token, whether commands are on, and who they act as; null (a 404) when not wired. */
export function readSession(d: UiDeps, now: Date): Record<string, unknown> | null {
  if (!d.commands) return null;
  return { as_of: now.toISOString(), csrf_token: d.commands.token, commands_enabled: d.commands.actor !== null, actor: d.commands.actor, actor_source: d.commands.source };
}

/** The actions the page asks about for its actor: approve_spec for the item commands, approve_merge for Merge. */
export type PageAction = "approve_spec" | "approve_merge";

/** The page actor's grant of one action: allowed, or refused with the controller's reason (roleRefusal). */
export type ActorGrant = { allow: true } | { allow: false; reason: string };

/**
 * Whether the page's actor holds `action`, as the controller checks it for an app command (design §9): the configured
 * auth plugin over the local grants, on the project (UiCommands.allowed, no forge call). In solo use the first
 * identity becomes the local owner there, so no grant is needed. Asked at most once per call of the result, so a
 * request asks once however many items or commands it lists. When it cannot be asked here (commands off, or no auth
 * wired), approve_spec is allowed (the controller still checks every command it applies) and approve_merge is not
 * (Merge stays disabled).
 */
export function actorGrant(d: UiDeps, action: PageAction): () => Promise<ActorGrant> {
  let asked: Promise<ActorGrant> | null = null;
  const ask = async (): Promise<ActorGrant> => {
    const c = d.commands;
    if (c?.actor == null || !c.allowed) return action === "approve_spec" ? { allow: true } : { allow: false, reason: NOT_MERGER };
    const decision = await c.allowed(action);
    return decision.allow ? { allow: true } : { allow: false, reason: roleRefusal(c.actor, decision.reason) };
  };
  return () => (asked ??= ask());
}

/** One entry of the item API's `commands`: a command that applies now, and whether the viewer may send it. */
export interface ItemCommandRow {
  name: CommandName;
  usage: string;
  description: string;
  allowed: boolean;
  /** Why the viewer may not send it, in the controller's refusal words (through the Withholder); null when allowed. */
  reason: string | null;
}

/**
 * The item API's `commands`: what the page may send in the item's state, from the comment footer's table, each with
 * whether the viewer's grant allows it and, when not, the reason the controller would refuse it with (through `text`,
 * the Withholder: it names a user ID). Every command but `merge` (its own button) needs approve_spec, as the
 * controller checks it; `/verdict`'s record_verdict comes with the same role. Not `/help`: it answers a comment and the
 * page cannot send it (APP_COMMANDS), so a button for it could only be refused.
 */
export async function itemCommands(
  it: WorkItem, runs: readonly Run[], grant: ActorGrant, text: (v: string) => Promise<string | null>,
): Promise<ItemCommandRow[]> {
  const reason = grant.allow ? null : await text(grant.reason);
  return commandsFor(itemCommandState(it, runs))
    .filter((c) => APP_COMMANDS.includes(c.name))
    .map((c) => ({ name: c.name, usage: c.usage, description: c.description, allowed: grant.allow, reason }));
}

/**
 * Whether a Needs-you row gets a button for `name` (design §9): a command that changes the item's state, from the
 * command rules, but not `budget`, whose tokens are typed on the item page or the issue.
 */
export function needsYouCommand(name: CommandName): boolean {
  return name !== "budget" && commandSpec(name).changes_state;
}

/**
 * The item API's `spec` (issue #526): the In short and the decisions of a spec waiting for approval (or at the
 * revision limit), from the latest applied triage run's stored output; null for any other item. Every text passes
 * `text` (the Withholder). Store reads only: the caller passes the item's runs.
 */
export async function waitingSpec(it: WorkItem, runs: readonly Run[], text: (v: string | null) => Promise<string | null>) {
  if (it.stage !== "READY" || (it.blocked_reason !== "spec_pending" && it.blocked_reason !== "max_revisions")) return null;
  const spec = latestSpec(runs);
  if (!spec) return null;
  const decisions = [];
  for (const d of spec.decision_items ?? []) {
    const options = [];
    for (const o of d.options ?? []) options.push((await text(o))!);
    decisions.push({
      question: (await text(d.text))!, options, default: await text(d.default), reason: await text(d.reason ?? null), owner_only: d.owner_only,
    });
  }
  return { in_short: await text(spec.in_short), decisions };
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
 * controller checks everything again when it applies the request; GitHub checks the head at merge time.
 */
export async function mergeReadiness(d: UiDeps, it: WorkItem, check: MergeCheckState | null, allowed: () => Promise<ActorGrant>): Promise<MergeReadiness> {
  if (commandPhase(it) !== "merge_pending") return off(NOT_WAITING);
  // The controller's route: a local item with no PR takes the local merge, an item with a PR its PR's merge.
  const local = it.source.type === LOCAL_SOURCE && it.change_ref === null;
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
