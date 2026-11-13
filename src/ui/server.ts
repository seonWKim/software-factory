// `factory ui`: the status page over FactoryStore (design §9, architecture §1).
// node:http only, bound to 127.0.0.1 with no host option. GET and HEAD only, on every path (/api/health too),
// except the write routes: POST /api/v1/settings (design §8, issue #236), POST /api/v1/items/:id/commands
// (design §9, issue #227; commands.ts), POST /api/v1/pauses/resume (design §5 Restarts, issue #291), POST
// /api/v1/standing (design 05-standing-approvals, issue #300; standing-api.ts), POST /api/v1/improve/run (design §7, issue #508; improve-api.ts) and
// POST /api/v1/packs/approvals (design 11-packs, issue #589; packs-api.ts), POST /api/v1/rules/verdict (design §9,
// issue #571; rules-api.ts) and the task routes (design 02-tasks; tasks-api.ts TASK_WRITES: POST /api/v1/tasks, the quick-add box,
// /api/v1/tasks/build, Build this, and /api/v1/tasks/edit, /done, /delete and /sub, the Tasks page's row actions) and the
// calendar routes (design 08-settings; calendar-api.ts: POST /api/v1/calendar/connect and /disconnect) and the Data page's Ask
// (design 09-dashboard-app; data-ask.ts: POST /api/v1/data/ask), each guarded in this order: Host, then an Origin equal to the Host's own http origin, then Content-Type
// application/json, then the per-process CSRF token in x-csrf-token; the resume, standing and improve routes then
// check the owner (approve_spec), the rules, calendar and Ask routes the owner, the pack approvals route approve_tool, the task routes
// the commands actor. A POST to any
// other path answers 405 as JSON; every other method answers 405 in its area's format. The Host header must name
// 127.0.0.1 or localhost, so a page on another origin cannot read this one through DNS rebinding. The CSP
// allows only the page's own inline style and script (by hash; on /classic also the Run now script when shown), same-origin fetches and same-origin GET forms.
// Three areas, the same guards for each: the HTML pages (/, /items/<id>, /api/health), the JSON API under
// /api/v1 (api.ts, GET /api/v1/notices in notices-api.ts, GET /api/v1/rules and /api/v1/rules/entry in rules-api.ts, GET
// /api/v1/tasks and /api/v1/tasks/done (the Done tab) in tasks-api.ts and GET
// /api/v1/calendar in calendar-api.ts; errors as JSON) and the app under /app (app.ts; its own
// CSP, errors as text).

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkItemId } from "../core/types.js";
import { type ApiDeps, api, apiError, isApiPath } from "./api.js";
import { DEFAULT_APP_DIR, appText, isAppPath, serveApp } from "./app.js";
import { MAX_COMMAND_BODY, commandsPathId, commandsPost } from "./commands.js";
import { CSRF_HEADER, SETTINGS_PATH, csrfMatches, writeSettings } from "./settings-api.js";
import { RESUME_PATH, resumePause } from "./pause-api.js";
import { STANDING_PATH, writeStanding } from "./standing-api.js";
import { PACK_APPROVALS_PATH, writePackApproval } from "./packs-api.js";
import { TASKS_PATH, TASK_DONE_PATH, TASK_WRITES, readDoneTasks, readTasks } from "./tasks-api.js";
import { RULES_PATH, RULE_ENTRY_PATH, RULE_VERDICT_PATH, readRuleEntry, readRules, writeRuleVerdict } from "./rules-api.js";
import { IMPROVE_RUN_PATH, type ImproveRunDeps, improveRunWired, runImproveNow } from "./improve-api.js";
import { NOTICES_PATH, readNotices } from "./notices-api.js";
import { CALENDAR_CONNECT_PATH, CALENDAR_DISCONNECT_PATH, CALENDAR_PATH, readCalendarStatus, writeCalendar } from "./calendar-api.js";
import { DATA_ASK_PATH, askData } from "./data-ask.js";
import { RUN_NOW_SCRIPT, RUN_NOW_SCRIPT_HASH } from "./health.js";
import { parseFilters } from "./filters.js";
import { SCRIPT_HASH, STYLE_HASH, esc, page } from "./html.js";
import { type UiDeps, renderIndex, renderItem } from "./pages.js";

export type { UiDeps } from "./pages.js";
export type { PauseDeps } from "./pause-api.js";
export type { ApiDeps } from "./api.js";

export const BIND = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ALLOW = "GET, HEAD";

/** The HTML pages' CSP with these script hashes: the page's own script, plus Run now's on a page that shows it. */
function csp(scripts: readonly string[]): string {
  return (
    `default-src 'none'; script-src ${scripts.map((h) => `'${h}'`).join(" ")}; style-src '${STYLE_HASH}'; connect-src 'self'; ` +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": csp([SCRIPT_HASH]),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface UiRequest {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  /** A write route's headers and body; read only for the write routes (POST /api/v1/settings, /api/v1/items/:id/commands, /api/v1/tasks, ...). */
  origin?: string | undefined;
  contentType?: string | undefined;
  csrfToken?: string | undefined;
  body?: string | undefined;
  /** The body was longer than the route's limit (MAX_BODY, or MAX_COMMAND_BODY for commands) and was not read. */
  bodyTooLarge?: boolean;
}

/** The largest body the write route reads. A set or reset is a few hundred bytes. */
export const MAX_BODY = 64 * 1024;

export interface UiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** A file's bytes (the app's static files); when set, sent instead of `body`. */
  bytes?: Buffer;
}

/** True when `host` (a Host header) names 127.0.0.1 or localhost, with or without a port. */
export function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(host.trim().toLowerCase());
  return m !== null && ALLOWED_HOSTS.has(m[1]!);
}

/** The server-rendered status page, kept beside the app until the app covers everything it shows. */
export const CLASSIC_PATH = "/classic";
/** Where `/` sends the browser. */
export const APP_HOME = "/app/";

function html(status: number, body: string, extra: Record<string, string> = {}): UiResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra }, body };
}

function json(status: number, value: unknown): UiResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }, body: `${JSON.stringify(value)}\n` };
}

function error(status: number, message: string, extra: Record<string, string> = {}): UiResponse {
  return html(status, page(`${status}`, `<h1>${esc(status)}</h1><p>${esc(message)}</p>`), extra);
}

/** A raw request URL's path, without its query string or fragment. */
const pathOf = (rawUrl: string | undefined): string => (rawUrl ?? "/").split(/[?#]/, 1)[0]!;

/** Which area a request path belongs to, before the URL is parsed (errors take that area's format). */
function areaOf(rawUrl: string | undefined): "api" | "app" | "page" {
  const path = pathOf(rawUrl);
  if (isApiPath(path)) return "api";
  if (isAppPath(path)) return "app";
  return "page";
}

/** An error in the area's format: JSON for /api/v1, text for /app, the HTML page elsewhere. */
function areaError(area: "api" | "app" | "page", status: number, message: string, extra: Record<string, string> = {}): UiResponse {
  if (area === "api") {
    const r = json(status, apiError(status, message).value);
    return { ...r, headers: { ...r.headers, ...extra } };
  }
  if (area === "app") return appText(status, message, extra);
  return error(status, message, extra);
}

type WriteRoute = "settings" | "resume" | "standing" | "improve" | "packs" | "rules" | "tasks" | "calendar" | "ask";

/**
 * The write route a request is for: POST to exactly /api/v1/settings when settings are wired, to exactly
 * /api/v1/pauses/resume or /api/v1/standing when the pause routes (their owner check) are, or to exactly /api/v1/improve/run when both the pause routes and
 * settings (its project) are, or to exactly one of the task routes (TASK_WRITES) when the commands route (its actor and token) is, or
 * to exactly /api/v1/calendar/connect or /disconnect when the settings carry the Calendar section, or to exactly /api/v1/data/ask when they carry
 * the Ask (a query string is ignored). Null for every other request.
 */
function writeRoute(d: ApiDeps, req: UiRequest): WriteRoute | null {
  if (req.method !== "POST") return null;
  const path = pathOf(req.url);
  if (path === SETTINGS_PATH && d.settings !== undefined) return "settings";
  if (path === RESUME_PATH && d.pauses !== undefined) return "resume";
  if (path === STANDING_PATH && d.pauses !== undefined) return "standing";
  if (path === IMPROVE_RUN_PATH && improveRunWired(d)) return "improve";
  if (path === PACK_APPROVALS_PATH && d.pauses?.auth !== undefined) return "packs";
  if (path === RULE_VERDICT_PATH && d.pauses !== undefined) return "rules";
  if (Object.hasOwn(TASK_WRITES, path) && d.commands !== undefined) return "tasks";
  if ((path === CALENDAR_CONNECT_PATH || path === CALENDAR_DISCONNECT_PATH) && d.settings?.calendar !== undefined) return "calendar";
  if (path === DATA_ASK_PATH && d.settings?.ask !== undefined) return "ask";
  return null;
}

/** The Content-Type's media type, lowercased, without parameters. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * A write route after the Host check: Origin, then Content-Type, then the CSRF token, then the body, then the
 * route itself (the resume, standing and improve routes check the owner before they write, the Ask before its model
 * call). Every refusal comes before any store write.
 */
async function writePost(d: ApiDeps, req: UiRequest, route: WriteRoute): Promise<UiResponse> {
  const token =
    route === "settings" || route === "calendar" || route === "ask" ? d.settings!.csrfToken
    : route === "tasks" ? d.commands!.token
    : d.pauses!.csrfToken;
  const own = `http://${(req.host ?? "").trim().toLowerCase()}`;
  if (req.origin === undefined || req.origin.trim().toLowerCase() !== own) {
    return json(403, apiError(403, "Origin must be this page's own origin.").value);
  }
  if (mediaType(req.contentType) !== "application/json") return json(415, apiError(415, "Content-Type must be application/json.").value);
  if (!csrfMatches(token, req.csrfToken)) {
    return json(403, apiError(403, `Missing or stale ${CSRF_HEADER}; reload the page.`).value);
  }
  if (req.bodyTooLarge) return json(413, apiError(413, "The body is too large.").value);
  let body: unknown;
  try {
    body = JSON.parse(req.body ?? "");
  } catch {
    return json(400, apiError(400, "The body must be JSON.").value);
  }
  const r =
    route === "settings" ? await writeSettings(d, d.settings!, body)
    : route === "resume" ? await resumePause(d, d.pauses!, body)
    : route === "improve" ? await runImproveNow(d as ImproveRunDeps)
    : route === "packs" ? await writePackApproval(d, d.pauses!, body)
    : route === "rules" ? await writeRuleVerdict(d, d.pauses!, body)
    : route === "tasks" ? await TASK_WRITES[pathOf(req.url)]!(d, body)
    : route === "calendar" ? await writeCalendar(d, pathOf(req.url), body)
    : route === "ask" ? await askData(d, d.settings!.ask!, body)
    : await writeStanding(d, d.pauses!, body);
  return json(r.status, r.value);
}

/** The commands path's raw item id for a POST to it, else null. */
function commandsWrite(req: Pick<UiRequest, "method" | "url">): string | null {
  return req.method === "POST" ? commandsPathId(req.url) : null;
}

/** The whole request handling, without the socket. Writes only through the write routes. */
export async function respond(d: ApiDeps, req: UiRequest): Promise<UiResponse> {
  const area = areaOf(req.url);
  if (!allowedHost(req.host)) return areaError(area, 403, "Host must be 127.0.0.1 or localhost.");
  const route = writeRoute(d, req);
  if (route !== null) return writePost(d, req, route);
  const commandsId = commandsWrite(req);
  if (commandsId !== null) {
    const r = await commandsPost(d, commandsId, req);
    return json(r.status, r.value);
  }
  // A POST anywhere else is a JSON 405, whatever the area: a script that posts reads one error format.
  if (req.method === "POST") return areaError("api", 405, "Only the settings, item commands, pause resume, standing, improve run, pack approvals, rule verdict, task, calendar and data ask routes take a POST.", { allow: ALLOW });
  if (req.method !== "GET" && req.method !== "HEAD") return areaError(area, 405, "This page is read-only.", { allow: ALLOW });

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return areaError(area, 400, "Bad request.");
  }

  // Decided on the parsed path too: "/app/../x" parses to "/x", which is not the app.
  if (isApiPath(url.pathname)) {
    // The Rules page's read (issue #571) and the Tasks page's (#607) are served here beside the notices, so api.ts stays within its size budget.
    const r = url.pathname === NOTICES_PATH ? await readNotices(d)
      : url.pathname === RULES_PATH ? await readRules(d)
      : url.pathname === RULE_ENTRY_PATH ? await readRuleEntry(d, url.searchParams.get("id"))
      : url.pathname === TASKS_PATH ? await readTasks(d)
      : url.pathname === TASK_DONE_PATH ? await readDoneTasks(d, url.searchParams.get("before"))
      : url.pathname === CALENDAR_PATH ? await readCalendarStatus(d)
      : await api(d, url);
    return json(r.status, r.value);
  }
  if (isAppPath(url.pathname)) return serveApp(d.appDir ?? DEFAULT_APP_DIR, url.pathname);

  // The app is the default UI (design §9, 2026-11-07); the server-rendered page stays at CLASSIC_PATH.
  if (url.pathname === "/") return html(302, "", { location: APP_HOME });
  if (url.pathname === CLASSIC_PATH) {
    const parsed = parseFilters(url.searchParams);
    if (!parsed.ok) return error(400, parsed.error);
    const healthRefresh = url.searchParams.get("health") === "refresh";
    const body = await renderIndex(d, parsed.filters, url.pathname + url.search, healthRefresh);
    // The Health panel's Run now button brings its own script; only a page that shows it allows it.
    const runNow = body.includes(`<script>${RUN_NOW_SCRIPT}</script>`);
    return html(200, body, runNow ? { "content-security-policy": csp([SCRIPT_HASH, RUN_NOW_SCRIPT_HASH]) } : {});
  }

  if (url.pathname === "/api/health") return json(200, await d.health.report(d.scanner));

  const m = /^\/items\/([^/]+)$/.exec(url.pathname);
  if (m) {
    let id: string;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      return error(404, "Not found.");
    }
    const body = await renderItem(d, id as WorkItemId);
    return body === null ? error(404, "No such work item.") : html(200, body);
  }

  return error(404, "Not found.");
}

export interface UiServer {
  readonly address: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1:`port` (0 picks a free port). */
export async function startUi(d: ApiDeps, port: number): Promise<UiServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const base: UiRequest = { method: req.method, url: req.url, host: req.headers.host };
    const write = writeRoute(d, base) !== null || commandsWrite(base) !== null;
    const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
    (write
      ? readBody(req, commandsWrite(base) !== null ? MAX_COMMAND_BODY : MAX_BODY).then((b) =>
          respond(d, {
            ...base,
            origin: one(req.headers.origin),
            contentType: one(req.headers["content-type"]),
            csrfToken: one(req.headers[CSRF_HEADER]),
            ...b,
          }),
        )
      : respond(d, base)
    ).then(
      (r) => send(res, req.method === "HEAD", r),
      (err: unknown) => {
        console.error(`ui: request failed: ${err instanceof Error ? err.message : String(err)}`);
        send(res, req.method === "HEAD", areaError(areaOf(req.url), 500, "The store could not be read."));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, BIND, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    address: addr.address,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** The request body, up to `max` bytes; past that the rest is drained and `bodyTooLarge` is set. */
function readBody(req: IncomingMessage, max: number): Promise<{ body: string; bodyTooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) tooLarge = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve({ body: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), bodyTooLarge: tooLarge }));
    req.on("error", reject);
  });
}

/** What goes on the wire: the headers with content-length, and no body for HEAD (same length as GET). */
export function wire(r: UiResponse, head: boolean): { status: number; headers: Record<string, string>; body: Buffer } {
  const body = r.bytes ?? Buffer.from(r.body, "utf8");
  return { status: r.status, headers: { ...r.headers, "content-length": String(body.length) }, body: head ? Buffer.alloc(0) : body };
}

function send(res: ServerResponse, head: boolean, r: UiResponse): void {
  const w = wire(r, head);
  res.writeHead(w.status, w.headers);
  res.end(head ? undefined : w.body);
}
