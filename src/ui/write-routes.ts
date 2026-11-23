// The dashboard's POST route table (design §9): each write route's path match, CSRF token and handler, and the
// guards every one passes after server.ts's Host check, in this order: Origin equal to the Host's own http origin,
// Content-Type application/json, the per-process CSRF token in x-csrf-token, the body size, then the route. The
// resume, stop, standing, improve, proposal verdict, migrate and supervisor routes then check the owner
// (approve_spec), the rules, calendar, model credential and Ask routes the owner, the pack approvals route
// approve_tool, the task and attachments routes the commands actor (the project file routes, project-files.ts PROJECT_FILE_ROUTES, only to
// set the folder and to save; their reads are POSTs too, so they pass every guard), the plugins import the page's factory user. The item commands
// route (commands.ts) runs its own guards in the same order. A new write route adds one entry to WRITE_ROUTES (and
// its name to POST_ONLY), not a line in server.ts.

import { type ApiResult, apiError } from "./api.js";
import { commandsPathId, commandsPost, staleCsrf } from "./commands.js";
import { SETTINGS_PATH, csrfMatches, writeSettings } from "./settings-api.js";
import { RESUME_PATH, STOP_PATH, resumePause, stopAllAgents } from "./pause-api.js";
import { STANDING_PATH, writeStanding } from "./standing-api.js";
import { PACK_APPROVALS_PATH, writePackApproval } from "./packs-api.js";
import { TASK_WRITES } from "./tasks-api.js";
import { RULE_WRITES, ownerOf } from "./rules-api.js";
import { IMPROVE_RUN_PATH, type ImproveRunDeps, PROPOSAL_VERDICT_PATH, improveRunWired, runImproveNow, writeProposalVerdict } from "./improve-api.js";
import { PLUGINS_IMPORT_PATH, writePluginsImport } from "./plugins-import-api.js";
import { PROJECT_FILE_ROUTES } from "./project-files.js";
import { CALENDAR_CONNECT_PATH, CALENDAR_DISCONNECT_PATH, CALENDAR_SYNC_PATH, writeCalendar, writeCalendarSync } from "./calendar-api.js";
import { DATA_ASK_PATH, askData } from "./data-ask.js";
import { MODEL_CREDENTIAL_PATH, writeModelCredential } from "./model-credential.js";
import { MIGRATE_PATH, SUPERVISOR_PATH, postMigrate, postSupervisor } from "./migrate-api.js";
import { ATTACH_PATH, writeAttachment } from "./attachments-api.js";
import { attach } from "../core/attachments.js";
import type { ServerDeps, UiRequest } from "./server.js";

/** The 405 text for a POST to any path no write route takes. */
export const POST_ONLY =
  "Only the settings, item commands, pause resume, standing, improve run, pack approvals, plugins import, rule verdict, rule edit, pushback dismiss, proposal verdict, task, project file, calendar, model credential, data ask, migrate, supervisor and attachments routes take a POST.";

/** One POST route: when it is wired for `path`, the CSRF token it checks, and its handler (after the guards). */
export interface WriteRoute {
  matches(d: ServerDeps, path: string): boolean;
  token(d: ServerDeps): string;
  run(d: ServerDeps, path: string, body: unknown): ApiResult | Promise<ApiResult>;
}

const settingsToken = (d: ServerDeps): string => d.settings!.csrfToken;
const pausesToken = (d: ServerDeps): string => d.pauses!.csrfToken;

/** First match wins. A query string is ignored: `path` is the raw URL's path. */
const WRITE_ROUTES: readonly WriteRoute[] = [
  { matches: (d, p) => p === SETTINGS_PATH && d.settings !== undefined, token: settingsToken, run: (d, _p, b) => writeSettings(d, d.settings!, b) },
  { matches: (d, p) => p === RESUME_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => resumePause(d, d.pauses!, b) },
  { matches: (d, p) => p === STOP_PATH && d.pauses !== undefined, token: pausesToken, run: (d) => stopAllAgents(d, d.pauses!) },
  { matches: (d, p) => p === STANDING_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writeStanding(d, d.pauses!, b) },
  { matches: (d, p) => p === IMPROVE_RUN_PATH && improveRunWired(d), token: pausesToken, run: (d) => runImproveNow(d as ImproveRunDeps) },
  { matches: (d, p) => p === PACK_APPROVALS_PATH && d.pauses?.auth !== undefined, token: pausesToken, run: (d, _p, b) => writePackApproval(d, d.pauses!, b) },
  { matches: (d, p) => p === PLUGINS_IMPORT_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writePluginsImport(d, d.pauses!, b) },
  { matches: (d, p) => Object.hasOwn(RULE_WRITES, p) && d.pauses !== undefined, token: pausesToken, run: (d, p, b) => RULE_WRITES[p]!(d, d.pauses!, b) },
  { matches: (d, p) => p === PROPOSAL_VERDICT_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writeProposalVerdict(d, d.pauses!, b) },
  { matches: (d, p) => Object.hasOwn(TASK_WRITES, p) && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, p, b) => TASK_WRITES[p]!(d, b) },
  { matches: (d, p) => p === ATTACH_PATH && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, _p, b) => writeAttachment(d, b, attach) },
  { matches: (d, p) => Object.hasOwn(PROJECT_FILE_ROUTES, p) && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, p, b) => PROJECT_FILE_ROUTES[p]!.run(d, b) },
  {
    matches: (d, p) => (p === CALENDAR_CONNECT_PATH || p === CALENDAR_DISCONNECT_PATH || p === CALENDAR_SYNC_PATH) && d.settings?.calendar !== undefined,
    token: settingsToken,
    run: (d, p, b) => (p === CALENDAR_SYNC_PATH ? writeCalendarSync(d, b) : writeCalendar(d, p, b)),
  },
  {
    matches: (d, p) => p === MODEL_CREDENTIAL_PATH && d.settings?.modelCredential !== undefined,
    token: settingsToken,
    run: (d, _p, b) => writeModelCredential(d, d.pauses ? (does) => ownerOf(d, d.pauses!, does) : null, b),
  },
  { matches: (d, p) => p === DATA_ASK_PATH && d.settings?.ask !== undefined, token: settingsToken, run: (d, _p, b) => askData(d, d.settings!.ask!, b) },
  { matches: (d, p) => p === MIGRATE_PATH && d.pauses !== undefined && d.migrate !== undefined, token: pausesToken, run: (d, _p, b) => postMigrate(d.migrate!, d.pauses!, b) },
  { matches: (d, p) => p === SUPERVISOR_PATH && d.pauses !== undefined && d.migrate !== undefined, token: pausesToken, run: (d, _p, b) => postSupervisor(d.migrate!, d.pauses!, b) },
];

/** A raw request URL's path, without its query string or fragment. */
export const pathOf = (rawUrl: string | undefined): string => (rawUrl ?? "/").split(/[?#]/, 1)[0]!;

/** The write route a POST is for, or null for every other request. */
export function writeRoute(d: ServerDeps, req: UiRequest): WriteRoute | null {
  if (req.method !== "POST") return null;
  const path = pathOf(req.url);
  return WRITE_ROUTES.find((r) => r.matches(d, path)) ?? null;
}

/** The commands path's raw item id for a POST to it, else null. */
export function commandsWrite(req: Pick<UiRequest, "method" | "url">): string | null {
  return req.method === "POST" ? commandsPathId(req.url) : null;
}

/** The Content-Type's media type, lowercased, without parameters. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * A write route after the Host check: Origin, then Content-Type, then the CSRF token, then the body, then the
 * route itself. Every refusal comes before any store write. A missing or stale token is the coded 403 (stale_csrf)
 * the page retries once with a fresh token.
 */
async function writePost(d: ServerDeps, req: UiRequest, route: WriteRoute): Promise<ApiResult> {
  const own = `http://${(req.host ?? "").trim().toLowerCase()}`;
  if (req.origin === undefined || req.origin.trim().toLowerCase() !== own) return apiError(403, "Origin must be this page's own origin.");
  if (mediaType(req.contentType) !== "application/json") return apiError(415, "Content-Type must be application/json.");
  if (!csrfMatches(route.token(d), req.csrfToken)) return staleCsrf();
  if (req.bodyTooLarge) return apiError(413, "The body is too large.");
  let body: unknown;
  try {
    body = JSON.parse(req.body ?? "");
  } catch {
    return apiError(400, "The body must be JSON.");
  }
  return route.run(d, pathOf(req.url), body);
}

/** Any POST: the write route's or the item commands' answer, or null when no route takes it (the caller's 405). */
export async function post(d: ServerDeps, req: UiRequest): Promise<ApiResult | null> {
  const route = writeRoute(d, req);
  if (route !== null) return writePost(d, req, route);
  const commandsId = commandsWrite(req);
  return commandsId !== null ? commandsPost(d, commandsId, req) : null;
}
