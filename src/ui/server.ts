// `factory ui`: the dashboard's server over FactoryStore (design §9, architecture §1): the request shell only.
// node:http only, bound to 127.0.0.1 with no host option. The Host header must name 127.0.0.1 or localhost, so a
// page on another origin cannot read this one through DNS rebinding; that check comes first for every request.
// GET and HEAD only, on every path (/api/health too), except the POST routes in write-routes.ts, which add their
// guards after the Host check in this order: Origin, Content-Type, CSRF token, body size, then the route. A POST to
// any other path answers 405 as JSON; every other method answers 405 in its area's format. Outside /app the CSP
// allows only the error page's own inline style (by hash) and no script.
// Three areas, the same guards for each: the rest (/ redirects to the app, /api/health, the HTML error pages), the
// JSON API under /api/v1 (read-routes.ts and api.ts; errors as JSON) and the app under /app (app.ts; its own CSP,
// errors as text). A new route edits write-routes.ts or read-routes.ts, not this file.

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ApiDeps, apiError, isApiPath } from "./api.js";
import { DEFAULT_APP_DIR, appText, isAppPath, serveApp } from "./app.js";
import { MAX_COMMAND_BODY } from "./commands.js";
import { CSRF_HEADER } from "./settings-api.js";
import type { MigrateDeps } from "./migrate-api.js";
import type { EvalsWriteDeps } from "./evals-api.js";
import { servePluginsStored } from "./plugins-api.js";
import { APP_HOME, STYLE_HASH, errorPage } from "./html.js";
import { POST_ONLY, commandsWrite, pathOf, post, writeRoute } from "./write-routes.js";
import { MAX_FILE_BODY, PROJECT_FILE_ROUTES, PROJECT_FILE_WRITE_PATH } from "./project-files.js";
import { ATTACH_PATH, MAX_ATTACH_BODY } from "./attachments-api.js";
import { registryOf } from "../api/index.js";
import { registryMaxBody } from "../api/registry.js";
import { readApi } from "./read-routes.js";

export type { UiDeps } from "./deps.js";
export type { PauseDeps } from "./pause-api.js";
export type { ApiDeps } from "./api.js";

/** What the server answers from: the API's dependencies and, when wired, Migrate now, Start and Restart now, and the evals writes. */
export type ServerDeps = ApiDeps & MigrateDeps & EvalsWriteDeps;

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
  /** The body was longer than the route's limit (MAX_BODY, MAX_COMMAND_BODY for commands, MAX_FILE_BODY for a file save, MAX_ATTACH_BODY for an attachment, a capability's declared max_body) and was not read. */
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

/** The whole request handling, without the socket. Writes only through the write routes. */
export async function respond(d: ServerDeps, req: UiRequest): Promise<UiResponse> {
  const area = areaOf(req.url);
  if (!allowedHost(req.host)) return areaError(area, 403, "Host must be 127.0.0.1 or localhost.");
  if (req.method === "POST") {
    const r = await post(d, req);
    // A POST anywhere else is a JSON 405, whatever the area: a script that posts reads one error format.
    return r !== null ? json(r.status, r.value) : areaError("api", 405, POST_ONLY, { allow: ALLOW });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return areaError(area, 405, "This page is read-only.", { allow: ALLOW });

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return areaError(area, 400, "Bad request.");
  }

  // Decided on the parsed path too: "/app/../x" parses to "/x", which is not the app.
  if (isApiPath(url.pathname)) {
    const r = await readApi(d, url, req);
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
  // The Health and Plugins reads answer from their stored results, refreshed in the background when a read finds them
  // older than their interval, and at once after each successful write (design 09-health, 2026-11-19). No timer.
  d.health.serveStored();
  const plugins = servePluginsStored(d);
  const refreshAll = () => {
    d.health.refreshNow();
    plugins.refreshNow();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
    const base: UiRequest = { method: req.method, url: req.url, host: req.headers.host, csrfToken: one(req.headers[CSRF_HEADER]) };
    const write = writeRoute(d, base) !== null || commandsWrite(base) !== null;
    const path = pathOf(base.url);
    // A project file read is a POST behind the write guards, but writes nothing: no snapshot refresh after it.
    const refreshes = PROJECT_FILE_ROUTES[path]?.write ?? true;
    const max = commandsWrite(base) !== null ? MAX_COMMAND_BODY : path === PROJECT_FILE_WRITE_PATH ? MAX_FILE_BODY : path === ATTACH_PATH ? MAX_ATTACH_BODY : registryMaxBody(registryOf(d), path) ?? MAX_BODY;
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
