// Item commands from the status page (design §9, issue #227): POST /api/v1/items/:id/commands records one app
// command request (FactoryStore.recordAppCommandRequest) with `ui.user_id` as the actor; the controller applies
// it on its next tick, or refuses it with a reply (design §4, app requests). This module never applies a command.
//
// Guards, in order, every refusal before any store write: Host (server.ts), then an Origin equal to the Host's own
// http origin (403), Content-Type application/json (415), the per-process token in x-csrf-token (403), a
// configured ui.user_id (503), a body of at most 16 KB (413), JSON (400), a known command with a valid note (400),
// a known item (404). Success is 202 with the request's ID. GET /api/v1/session hands out the token behind the
// same Host guard. The item API's `commands`, `replies` and `can_merge` fields are built here too.
// `merge` (design §9, the Merge button) is an app command beside the item commands: the local merge of
// `factory merge`, with no note, shown only for a local item waiting for its merge.

import { randomUUID } from "node:crypto";
import { COMMANDS, type CommandName, commandPhase, commandState, commandsFor } from "../core/commands.js";
import { LOCAL_SOURCE, MERGE_COMMAND } from "../core/local-merge.js";
import { AGENT_NEEDS_HUMAN, blockingRunKind } from "../core/policy.js";
import type { Run, UserId, WorkItem, WorkItemId } from "../core/types.js";
import type { UiDeps } from "./pages.js";
import { csrfMatches } from "./settings-api.js";

/** What the commands route needs beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiCommands {
  /** `ui.user_id`: the factory user the page's commands act as; null when not configured (POST answers 503). */
  actor: UserId | null;
  /** Random, per process; held only in memory. GET /api/v1/session returns it, POST must send it in x-csrf-token. */
  token: string;
  /**
   * Whether `actor` is allowed approve_merge on the project, over the local grants only (no forge call). Absent
   * (a page with no auth wired) means false: no Merge button.
   */
  mergeAllowed?: () => Promise<boolean>;
}

/** The largest commands body read. A command and a 2000-character note fit well inside it. */
export const MAX_COMMAND_BODY = 16 * 1024;
/** The longest note a command takes. */
export const MAX_NOTE = 2000;
/** The replies the item API lists: the newest this many of the item's requests. */
export const REPLIES_LIMIT = 50;
/** A command the page may send: an item command, or the local merge, which has no comment command. */
export type AppCommand = CommandName | typeof MERGE_COMMAND;
/** Commands the page may send: every item command but `/help` and the account command `/link`, then `merge`. */
export const APP_COMMANDS: readonly AppCommand[] = [
  ...COMMANDS.map((c) => c.name).filter((n) => n !== "help" && n !== "link"),
  MERGE_COMMAND,
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
  const off = err(503, "Commands are off: set ui.user_id in factory.config.json and restart `factory ui`.");
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
  const { request } = await d.store.recordAppCommandRequest({ key, actor: c.actor, command: parsed.command, args });
  return { status: 202, value: { request_id: request.key, seq: request.seq, command: request.command, work_item_id: item.id } };
}

/** GET /api/v1/session: the per-process token and whether commands are on; null (a 404) when not wired. */
export function readSession(d: UiDeps, now: Date): Record<string, unknown> | null {
  if (!d.commands) return null;
  return { as_of: now.toISOString(), csrf_token: d.commands.token, commands_enabled: d.commands.actor !== null };
}

/** The item API's `commands`: what applies in the item's state, from the comment footer's table, `/help` last. */
export function itemCommands(it: WorkItem, runs: readonly Run[]) {
  const askedBy = it.blocked_reason === AGENT_NEEDS_HUMAN ? blockingRunKind(it.blocked_reason, runs) : undefined;
  return commandsFor(commandState(it, askedBy)).map((c) => ({ name: c.name, usage: c.usage, description: c.description }));
}

/** The item API's `replies`: the item's app requests; the refusal and command pass `text`, the note never leaves. */
export async function itemReplies(d: UiDeps, id: WorkItemId, text: (v: string | null) => Promise<string | null>) {
  const out = [];
  for (const r of await d.store.listAppCommandRequestsForItem(id, REPLIES_LIMIT)) {
    out.push({ seq: r.seq, command: await text(r.command), created_at: r.created_at, handled_at: r.handled_at, refusal: await text(r.refusal) });
  }
  return out;
}

/**
 * The item API's `can_merge`: a local item waiting for its merge with no PR, and the page's user allowed
 * approve_merge. The controller checks both again when it applies the request.
 */
export async function canMerge(d: UiDeps, it: WorkItem): Promise<boolean> {
  if (commandPhase(it) !== "merge_pending" || it.source.type !== LOCAL_SOURCE || it.change_ref !== null) return false;
  return d.commands?.actor != null && (await d.commands.mergeAllowed?.()) === true;
}
