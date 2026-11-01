// `factory ui`: a read-only status page over FactoryStore (design §9, architecture §1).
// node:http only, bound to 127.0.0.1 with no host option. GET and HEAD only. The Host header must name
// 127.0.0.1 or localhost, so a page on another origin cannot read this one through DNS rebinding. The CSP
// allows only the page's own inline style and script (by hash), same-origin fetches and same-origin GET forms.

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkItemId } from "../core/types.js";
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

function error(status: number, message: string, extra: Record<string, string> = {}): UiResponse {
  return html(status, page(`${status}`, `<h1>${esc(status)}</h1><p>${esc(message)}</p>`), extra);
}

/** The whole request handling, without the socket: reads the store and renders, never writes. */
export async function respond(d: UiDeps, req: UiRequest): Promise<UiResponse> {
  if (!allowedHost(req.host)) return error(403, "Host must be 127.0.0.1 or localhost.");
  if (req.method !== "GET" && req.method !== "HEAD") return error(405, "This page is read-only.", { allow: ALLOW });

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return error(400, "Bad request.");
  }

  if (url.pathname === "/") {
    const parsed = parseFilters(url.searchParams);
    if (!parsed.ok) return error(400, parsed.error);
    return html(200, await renderIndex(d, parsed.filters, url.pathname + url.search));
  }

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
        send(res, req.method === "HEAD", error(500, "The store could not be read."));
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

function send(res: ServerResponse, head: boolean, r: UiResponse): void {
  const body = Buffer.from(r.body, "utf8");
  res.writeHead(r.status, { ...r.headers, "content-length": String(body.length) });
  res.end(head ? undefined : body);
}
