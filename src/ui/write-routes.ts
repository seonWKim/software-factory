// The dashboard's POST guard chain (design §9) and route lookup. The routes themselves are in three area files,
// grouped by the CSRF token they check: write-routes-settings.ts (settings token), write-routes-owner.ts (pauses
// token: the owner's writes) and write-routes-work.ts (commands token). Every route passes these guards after
// server.ts's Host check, in this order: Origin equal to the Host's own http origin, Content-Type application/json,
// the route's CSRF token in x-csrf-token, the body size, then the route. The owner, rules and evals routes then check
// the owner (approve_spec or ownerOf), the pack approvals route approve_tool, and the work routes the commands actor.
// The item commands route (commands.ts) runs its own guards in the same order. A new write route adds one entry to
// its area file (and its name to POST_ONLY), not to this file's lookup or to server.ts. A POST capability of the API
// registry (src/api/registry.ts, design 09-api-registry) needs no entry: the one registry entry, last, takes every
// declared POST path behind the same guards, with the pauses token.

import { type ApiResult, apiError } from "./api.js";
import { commandsPathId, commandsPost, staleCsrf } from "./commands.js";
import { csrfMatches } from "./settings-api.js";
import { type WriteRoute, pausesToken } from "./write-route-types.js";
import { SETTINGS_WRITE_ROUTES } from "./write-routes-settings.js";
import { OWNER_WRITE_ROUTES } from "./write-routes-owner.js";
import { WORK_WRITE_ROUTES } from "./write-routes-work.js";
import { registryOf } from "../api/index.js";
import { registryWrite, registryWrites } from "../api/registry.js";
import { Withholder } from "./withhold.js";
import type { ServerDeps, UiRequest } from "./server.js";

/** The 405 text for a POST to any path no write route takes. */
export const POST_ONLY =
  "Only the settings, item commands, pause resume, alarm dismiss, standing, improve run, pack approvals, plugins import, rule verdict, rule edit, pushback dismiss, schedule (draft and improve too), proposal verdict, task, project file, calendar, local calendar event, model credential, data ask, migrate, supervisor, attachments, evals write, evals run, Re-check and API registry capability routes take a POST.";

/** The API registry's POST capabilities: the owner's writes, so the pauses token. */
const REGISTRY_WRITES: WriteRoute = {
  matches: (d, p) => d.pauses !== undefined && registryWrites(registryOf(d), p),
  token: pausesToken,
  run: (d, p, b) => registryWrite(registryOf(d), d, p, b, new Withholder(d.scanner)),
};

/**
 * First match wins. A query string is ignored: `path` is the raw URL's path. The areas' paths do not overlap; the
 * registry's entry is last, so a declared path never takes an existing route's.
 */
const WRITE_ROUTES: readonly WriteRoute[] = [...SETTINGS_WRITE_ROUTES, ...OWNER_WRITE_ROUTES, ...WORK_WRITE_ROUTES, REGISTRY_WRITES];

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

/** The retired routine routes (design 08-schedules): a POST under this prefix is a 404, as their reads are, not the 405. */
const RETIRED_ROUTINES = "/api/v1/routines/";

/** Any POST: the write route's or the item commands' answer, or null when no route takes it (the caller's 405). */
export async function post(d: ServerDeps, req: UiRequest): Promise<ApiResult | null> {
  const route = writeRoute(d, req);
  if (route !== null) return writePost(d, req, route);
  const commandsId = commandsWrite(req);
  if (commandsId !== null) return commandsPost(d, commandsId, req);
  return pathOf(req.url).startsWith(RETIRED_ROUTINES) ? apiError(404, "The routine routes are retired: use /api/v1/schedules.") : null;
}
