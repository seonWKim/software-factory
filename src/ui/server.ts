// `factory ui`: the dashboard's server over FactoryStore (design §9, architecture §1).
// node:http only, bound to 127.0.0.1 with no host option. GET and HEAD only, on every path (/api/health too),
// except the write routes: POST /api/v1/settings (design §8, issue #236), POST /api/v1/items/:id/commands
// (design §9, issue #227; commands.ts), POST /api/v1/pauses/resume (design §5 Restarts, issue #291), POST
// /api/v1/agents/stop (design 05-restart-pauses, Stop all agents; pause-api.ts), POST
// /api/v1/standing (design 05-standing-approvals, issue #300; standing-api.ts), POST /api/v1/improve/run (design §7, issue #508; improve-api.ts) and
// POST /api/v1/packs/approvals (design 11-packs, issue #589; packs-api.ts), POST /api/v1/rules/verdict (design §9,
// issue #571; rules-api.ts), /api/v1/rules/edit and /api/v1/rules/pushbacks/dismiss (design 09-dashboard-rules, RULE_WRITES) and the task routes (design 02-tasks; tasks-api.ts TASK_WRITES: POST /api/v1/tasks, the quick-add box,
// /api/v1/tasks/build, Build this, /api/v1/tasks/edit, /done, /delete and /sub, the Tasks page's row actions, and
// projects-api.ts's /api/v1/tasks/project, /api/v1/projects and /api/v1/projects/delete, its project dialog and menu) and the project file routes (design 02-tasks,
// project files; project-files.ts PROJECT_FILE_ROUTES: POST /api/v1/projects/folder, /api/v1/projects/files/tree, /read and /write,
// the Files tab; its reads are POSTs too, so they pass every guard) and the
// calendar routes (design 08-settings; calendar-api.ts: POST /api/v1/calendar/connect and /disconnect) and the Data page's Ask
// (design 09-dashboard-app; data-ask.ts: POST /api/v1/data/ask) and the Plugins page's import (design 11-plugin-import;
// plugins-import-api.ts: POST /api/v1/plugins/import) and Migrate now, Start and Restart now (design 08-self-update; migrate-api.ts:
// POST /api/v1/migrate and POST /api/v1/supervisor) and the Proposals page's verdict (design 09-dashboard-proposals; improve-api.ts: POST /api/v1/proposals/verdict)
// and the Add model credential dialog (design 09-status-page; model-credential.ts:
// POST /api/v1/model-credential), each guarded in this order: Host, then an Origin equal to the Host's own http origin, then Content-Type
// application/json, then the per-process CSRF token in x-csrf-token; the resume, stop, standing, improve, proposal verdict, migrate and supervisor routes then
// check the owner (approve_spec), the rules, calendar, model credential and Ask routes the owner, the pack approvals route approve_tool, the task routes
// the commands actor (the project file routes only to set the folder and to save), the plugins import the page's factory user. GET /api/v1/plugins/import (it reads the user's own
// Claude Code and Codex configs) also needs the CSRF token after the Host check. A POST to any
// other path answers 405 as JSON; every other method answers 405 in its area's format. The Host header must name
// 127.0.0.1 or localhost, so a page on another origin cannot read this one through DNS rebinding. Outside /app the
// CSP allows only the error page's own inline style (by hash) and no script.
// Three areas, the same guards for each: the rest (/ redirects to the app, /api/health, the HTML error pages), the JSON API under
// /api/v1 (api.ts, GET /api/v1/notices in notices-api.ts, GET /api/v1/rules and /api/v1/rules/entry in rules-api.ts, GET
// /api/v1/tasks (`?project=<slug>`: the project switcher) and GET /api/v1/tasks/preview (the quick-add preview) in tasks-api.ts, GET /api/v1/plugins (the Plugins page) in plugins-api.ts and GET
// /api/v1/calendar in calendar-api.ts, GET /api/v1/proposals in improve-api.ts, GET /api/v1/supervisor (what Migrate now, Start and Restart now may do) in migrate-api.ts, GET /api/v1/calendar/events (the Calendar page's range read) in
// calendar-events-api.ts, GET /api/v1/model-credential (the dialog's secret names) in model-credential.ts; errors as JSON) and the app under /app (app.ts; its own
// CSP, errors as text).

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ApiDeps, api, apiError, isApiPath } from "./api.js";
import { DEFAULT_APP_DIR, appText, isAppPath, serveApp } from "./app.js";
import { MAX_COMMAND_BODY, commandsPathId, commandsPost, staleCsrf } from "./commands.js";
import { CSRF_HEADER, SETTINGS_PATH, csrfMatches, writeSettings } from "./settings-api.js";
import { RESUME_PATH, STOP_PATH, resumePause, stopAllAgents } from "./pause-api.js";
import { STANDING_PATH, writeStanding } from "./standing-api.js";
import { PACK_APPROVALS_PATH, writePackApproval } from "./packs-api.js";
import { TASKS_PATH, TASK_PREVIEW_PATH, TASK_WRITES, readTaskPreview, readTasks } from "./tasks-api.js";
import { MAX_FILE_BODY, PROJECT_FILE_ROUTES, PROJECT_FILE_WRITE_PATH } from "./project-files.js";
import { RULES_PATH, RULE_ENTRY_PATH, RULE_WRITES, ownerOf, readRuleEntry, readRules } from "./rules-api.js";
import { IMPROVE_RUN_PATH, type ImproveRunDeps, PROPOSALS_PATH, PROPOSAL_VERDICT_PATH, improveRunWired, readProposals, runImproveNow, writeProposalVerdict } from "./improve-api.js";
import { NOTICES_PATH, readNotices } from "./notices-api.js";
import { Activity } from "./background-refresh.js";
import { PLUGINS_PATH, readPlugins, startPluginsSnapshot } from "./plugins-api.js";
import { PLUGINS_IMPORT_PATH, readPluginsImport, writePluginsImport } from "./plugins-import-api.js";
import { CALENDAR_CONNECT_PATH, CALENDAR_DISCONNECT_PATH, CALENDAR_PATH, readCalendarStatus, writeCalendar } from "./calendar-api.js";
import { CALENDAR_EVENTS_PATH, readCalendarEvents } from "./calendar-events-api.js";
import { DATA_ASK_PATH, askData } from "./data-ask.js";
import { MODEL_CREDENTIAL_PATH, readModelCredential, writeModelCredential } from "./model-credential.js";
import { MIGRATE_PATH, type MigrateDeps, SUPERVISOR_PATH, postMigrate, postSupervisor, readSupervisor } from "./migrate-api.js";
import { APP_HOME, STYLE_HASH, errorPage } from "./html.js";

export type { UiDeps } from "./deps.js";
export type { PauseDeps } from "./pause-api.js";
export type { ApiDeps } from "./api.js";

/** What the server answers from: the API's dependencies and, when wired, Migrate now, Start and Restart now. */
export type ServerDeps = ApiDeps & MigrateDeps;

export const BIND = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ALLOW = "GET, HEAD";

const SECURITY_HEADERS: Record<string, string> = {
  // No script-src: default-src 'none' allows none.
  "content-security-policy": `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
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
  /** x-csrf-token: read for the write routes and for GET /api/v1/plugins/import. */
  csrfToken?: string | undefined;
  body?: string | undefined;
  /** The body was longer than the route's limit (MAX_BODY, MAX_COMMAND_BODY for commands, MAX_FILE_BODY for a file save) and was not read. */
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

function html(status: number, body: string, extra: Record<string, string> = {}): UiResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra }, body };
}

function json(status: number, value: unknown): UiResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }, body: `${JSON.stringify(value)}\n` };
}

function error(status: number, message: string, extra: Record<string, string> = {}): UiResponse {
  return html(status, errorPage(status, message), extra);
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

type WriteRoute = "settings" | "resume" | "stop" | "standing" | "improve" | "packs" | "import" | "rules" | "proposals" | "tasks" | "files" | "calendar" | "model_credential" | "ask" | "migrate" | "supervisor";

/**
 * The write route a request is for: POST to exactly /api/v1/settings when settings are wired, to exactly
 * /api/v1/pauses/resume, /api/v1/agents/stop, /api/v1/standing, /api/v1/plugins/import or /api/v1/proposals/verdict when the pause routes (their factory user) are, or to exactly /api/v1/improve/run when both the pause routes and
 * settings (its project) are, or to exactly one of the task routes (TASK_WRITES) when the commands route (its actor and token) is, or
 * to exactly /api/v1/calendar/connect or /disconnect when the settings carry the Calendar section, or to exactly /api/v1/model-credential
 * when they carry the Add model credential dialog, or to exactly /api/v1/data/ask when they carry
 * the Ask, or to exactly /api/v1/migrate or /api/v1/supervisor when both the pause routes and Migrate now's parts are (a query string
 * is ignored). Null for every other request.
 */
function writeRoute(d: ServerDeps, req: UiRequest): WriteRoute | null {
  if (req.method !== "POST") return null;
  const path = pathOf(req.url);
  if (path === SETTINGS_PATH && d.settings !== undefined) return "settings";
  if (path === RESUME_PATH && d.pauses !== undefined) return "resume";
  if (path === STOP_PATH && d.pauses !== undefined) return "stop";
  if (path === STANDING_PATH && d.pauses !== undefined) return "standing";
  if (path === IMPROVE_RUN_PATH && improveRunWired(d)) return "improve";
  if (path === PACK_APPROVALS_PATH && d.pauses?.auth !== undefined) return "packs";
  if (path === PLUGINS_IMPORT_PATH && d.pauses !== undefined) return "import";
  if (Object.hasOwn(RULE_WRITES, path) && d.pauses !== undefined) return "rules";
  if (path === PROPOSAL_VERDICT_PATH && d.pauses !== undefined) return "proposals";
  if (Object.hasOwn(TASK_WRITES, path) && d.commands !== undefined) return "tasks";
  if (Object.hasOwn(PROJECT_FILE_ROUTES, path) && d.commands !== undefined) return "files";
  if ((path === CALENDAR_CONNECT_PATH || path === CALENDAR_DISCONNECT_PATH) && d.settings?.calendar !== undefined) return "calendar";
  if (path === MODEL_CREDENTIAL_PATH && d.settings?.modelCredential !== undefined) return "model_credential";
  if (path === DATA_ASK_PATH && d.settings?.ask !== undefined) return "ask";
  if (path === MIGRATE_PATH && d.pauses !== undefined && d.migrate !== undefined) return "migrate";
  if (path === SUPERVISOR_PATH && d.pauses !== undefined && d.migrate !== undefined) return "supervisor";
  return null;
}

/** A missing or stale x-csrf-token: the coded 403 (stale_csrf) the page retries once with a fresh token. */
const staleToken = (): UiResponse => {
  const r = staleCsrf();
  return json(r.status, r.value);
};

/** The Content-Type's media type, lowercased, without parameters. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * A write route after the Host check: Origin, then Content-Type, then the CSRF token, then the body, then the
 * route itself (the resume, standing, improve, proposal verdict, migrate and supervisor routes check the owner before they write, the Ask before its model
 * call). Every refusal comes before any store write.
 */
async function writePost(d: ServerDeps, req: UiRequest, route: WriteRoute): Promise<UiResponse> {
  const token =
    route === "settings" || route === "calendar" || route === "model_credential" || route === "ask" ? d.settings!.csrfToken
    : route === "tasks" || route === "files" ? d.commands!.token
    : d.pauses!.csrfToken;
  const own = `http://${(req.host ?? "").trim().toLowerCase()}`;
  if (req.origin === undefined || req.origin.trim().toLowerCase() !== own) {
    return json(403, apiError(403, "Origin must be this page's own origin.").value);
  }
  if (mediaType(req.contentType) !== "application/json") return json(415, apiError(415, "Content-Type must be application/json.").value);
  if (!csrfMatches(token, req.csrfToken)) {
    return staleToken();
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
    : route === "stop" ? await stopAllAgents(d, d.pauses!)
    : route === "improve" ? await runImproveNow(d as ImproveRunDeps)
    : route === "packs" ? await writePackApproval(d, d.pauses!, body)
    : route === "import" ? await writePluginsImport(d, d.pauses!, body)
    : route === "rules" ? await RULE_WRITES[pathOf(req.url)]!(d, d.pauses!, body)
    : route === "proposals" ? await writeProposalVerdict(d, d.pauses!, body)
    : route === "tasks" ? await TASK_WRITES[pathOf(req.url)]!(d, body)
    : route === "files" ? await PROJECT_FILE_ROUTES[pathOf(req.url)]!.run(d, body)
    : route === "calendar" ? await writeCalendar(d, pathOf(req.url), body)
    : route === "model_credential" ? await writeModelCredential(d, d.pauses ? (does) => ownerOf(d, d.pauses!, does) : null, body)
    : route === "ask" ? await askData(d, d.settings!.ask!, body)
    : route === "migrate" ? await postMigrate(d.migrate!, d.pauses!, body)
    : route === "supervisor" ? await postSupervisor(d.migrate!, d.pauses!, body)
    : await writeStanding(d, d.pauses!, body);
  return json(r.status, r.value);
}

/** The commands path's raw item id for a POST to it, else null. */
function commandsWrite(req: Pick<UiRequest, "method" | "url">): string | null {
  return req.method === "POST" ? commandsPathId(req.url) : null;
}

/** The whole request handling, without the socket. Writes only through the write routes. */
export async function respond(d: ServerDeps, req: UiRequest): Promise<UiResponse> {
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
  if (req.method === "POST") return areaError("api", 405, "Only the settings, item commands, pause resume, standing, improve run, pack approvals, plugins import, rule verdict, rule edit, pushback dismiss, proposal verdict, task, project file, calendar, model credential, data ask, migrate and supervisor routes take a POST.", { allow: ALLOW });
  if (req.method !== "GET" && req.method !== "HEAD") return areaError(area, 405, "This page is read-only.", { allow: ALLOW });

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return areaError(area, 400, "Bad request.");
  }

  // Decided on the parsed path too: "/app/../x" parses to "/x", which is not the app.
  if (isApiPath(url.pathname)) {
    // The import's read lists files of the user's home folder: the page's CSRF token too, before any read.
    if (url.pathname === PLUGINS_IMPORT_PATH) {
      if (d.pauses === undefined) return json(404, apiError(404, "Not found.").value);
      if (!csrfMatches(d.pauses.csrfToken, req.csrfToken)) return staleToken();
      const r = await readPluginsImport(d);
      return json(r.status, r.value);
    }
    // The Rules page's read (issue #571), the Tasks page's (#607) and the Plugins page's are served here beside the notices, so api.ts stays within its size budget.
    const r = url.pathname === NOTICES_PATH ? await readNotices(d)
      : url.pathname === RULES_PATH ? await readRules(d)
      : url.pathname === RULE_ENTRY_PATH ? await readRuleEntry(d, url.searchParams.get("id"))
      : url.pathname === PROPOSALS_PATH ? await readProposals(d)
      : url.pathname === TASKS_PATH ? await readTasks(d, url.searchParams.get("project"))
      : url.pathname === TASK_PREVIEW_PATH ? await readTaskPreview(d, url.searchParams.get("words"))
      : url.pathname === PLUGINS_PATH ? await readPlugins(d)
      : url.pathname === CALENDAR_PATH ? await readCalendarStatus(d)
      : url.pathname === MODEL_CREDENTIAL_PATH ? readModelCredential(d)
      : url.pathname === SUPERVISOR_PATH && d.migrate !== undefined && d.pauses !== undefined ? await readSupervisor(d.migrate, d.pauses)
      : url.pathname === CALENDAR_EVENTS_PATH ? await readCalendarEvents(d, url.searchParams.get("from"), url.searchParams.get("to"))
      : await api(d, url);
    return json(r.status, r.value);
  }
  if (isAppPath(url.pathname)) return serveApp(d.appDir ?? DEFAULT_APP_DIR, url.pathname);

  // The app is the only UI (design 09-dashboard-app); every other HTML path is the 404 page.
  if (url.pathname === "/") return html(302, "", { location: APP_HOME });
  if (url.pathname === "/api/health") return json(200, await d.health.report(d.scanner));
  return error(404, "Not found.");
}

export interface UiServer {
  readonly address: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1:`port` (0 picks a free port). */
export async function startUi(d: ServerDeps, port: number): Promise<UiServer> {
  // The Health and Plugins reads answer from background snapshots, refreshed after each successful write (design 09-health).
  // One Activity: a read of either route keeps both refreshing.
  const activity = new Activity(d.clock);
  d.health.start(activity);
  const plugins = startPluginsSnapshot(d, activity);
  const refreshAll = () => {
    d.health.refresh();
    plugins.refresh();
  };
  const stopRefresh = () => {
    d.health.stop();
    plugins.stop();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
    const base: UiRequest = { method: req.method, url: req.url, host: req.headers.host, csrfToken: one(req.headers[CSRF_HEADER]) };
    const write = writeRoute(d, base) !== null || commandsWrite(base) !== null;
    const path = pathOf(base.url);
    // A project file read is a POST behind the write guards, but writes nothing: no snapshot refresh after it.
    const refreshes = PROJECT_FILE_ROUTES[path]?.write ?? true;
    const max = commandsWrite(base) !== null ? MAX_COMMAND_BODY : path === PROJECT_FILE_WRITE_PATH ? MAX_FILE_BODY : MAX_BODY;
    (write
      ? readBody(req, max).then((b) =>
          respond(d, {
            ...base,
            origin: one(req.headers.origin),
            contentType: one(req.headers["content-type"]),
            ...b,
          }).then((r) => {
            if (r.status < 300 && refreshes) refreshAll();
            return r;
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
  }).catch((err: unknown) => {
    stopRefresh();
    throw err;
  });
  const addr = server.address() as AddressInfo;
  return {
    address: addr.address,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        stopRefresh();
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
