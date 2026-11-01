// `factory ui`: a read-only status page over FactoryStore (design §9, architecture §1).
// node:http only, bound to 127.0.0.1 with no host option. GET and HEAD only, on every path (/api/health too). The Host header must name
// 127.0.0.1 or localhost, so a page on another origin cannot read this one through DNS rebinding. The CSP
// allows only the page's own inline style and script (by hash), same-origin fetches and same-origin GET forms.
// Three areas, the same guards for each: the HTML pages (/, /items/<id>, /api/health), the JSON API under
// /api/v1 (api.ts; errors as JSON) and the app under /app (app.ts; its own CSP, errors as text).

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkItemId } from "../core/types.js";
import { api, apiError, isApiPath } from "./api.js";
import { DEFAULT_APP_DIR, appText, isAppPath, serveApp } from "./app.js";
import { parseFilters } from "./filters.js";
import { SCRIPT_HASH, STYLE_HASH, esc, page } from "./html.js";
import { type UiDeps, renderIndex, renderItem } from "./pages.js";

export type { UiDeps } from "./pages.js";

const BIND = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ALLOW = "GET, HEAD";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    `default-src 'none'; script-src '${SCRIPT_HASH}'; style-src '${STYLE_HASH}'; connect-src 'self'; ` +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface UiRequest {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
}

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
  return html(status, page(`${status}`, `<h1>${esc(status)}</h1><p>${esc(message)}</p>`), extra);
}

/** Which area a request path belongs to, before the URL is parsed (errors take that area's format). */
function areaOf(rawUrl: string | undefined): "api" | "app" | "page" {
  const path = (rawUrl ?? "/").split(/[?#]/, 1)[0]!;
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

/** The whole request handling, without the socket: reads the store and renders, never writes. */
export async function respond(d: UiDeps, req: UiRequest): Promise<UiResponse> {
  const area = areaOf(req.url);
  if (!allowedHost(req.host)) return areaError(area, 403, "Host must be 127.0.0.1 or localhost.");
  if (req.method !== "GET" && req.method !== "HEAD") return areaError(area, 405, "This page is read-only.", { allow: ALLOW });

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return areaError(area, 400, "Bad request.");
  }

  // Decided on the parsed path too: "/app/../x" parses to "/x", which is not the app.
  if (isApiPath(url.pathname)) {
    const r = await api(d, url);
    return json(r.status, r.value);
  }
  if (isAppPath(url.pathname)) return serveApp(d.appDir ?? DEFAULT_APP_DIR, url.pathname);

  if (url.pathname === "/") {
    const parsed = parseFilters(url.searchParams);
    if (!parsed.ok) return error(400, parsed.error);
    const healthRefresh = url.searchParams.get("health") === "refresh";
    return html(200, await renderIndex(d, parsed.filters, url.pathname + url.search, healthRefresh));
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
export async function startUi(d: UiDeps, port: number): Promise<UiServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    respond(d, { method: req.method, url: req.url, host: req.headers.host }).then(
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
