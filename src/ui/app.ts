// The app under /app/ (design §9): static files from web/dist, which `npm run build` writes. Any path that is
// not a file there gets index.html (the app routes on the client), except under assets/, where a missing
// file is a 404. A path that decodes to a "." or ".." segment, a slash, a backslash or a NUL is a 404, and so
// is any file whose real path (symlinks followed) is outside web/dist. No web/dist (or no index.html): 503.
//
// Its own CSP: the built app is files from this origin only, so script-src and style-src are 'self', with no
// 'unsafe-inline' and no hash; the HTML page keeps its hash-based policy (server.ts).

import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiResponse } from "./server.js";

/** web/dist beside src/ (from src/ui under vitest) and beside dist/ (from dist/ui when built). */
export const DEFAULT_APP_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const APP_HEADERS: Record<string, string> = {
  "content-security-policy": APP_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The content type for a file name; unknown extensions are served as bytes (nosniff keeps them inert). */
export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** True for /app and everything under it. */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** A plain-text response with the app's headers (errors, and the 503 when the app is not built). */
export function appText(status: number, text: string, extra: Record<string, string> = {}): UiResponse {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...APP_HEADERS, "cache-control": "no-store", ...extra },
    body: `${text}\n`,
  };
}

function file(name: string, bytes: Buffer, immutable: boolean): UiResponse {
  return {
    status: 200,
    headers: {
      "content-type": contentType(name),
      ...APP_HEADERS,
      // Vite puts a content hash in every name under assets/, so those never change; index.html may.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    },
    body: "",
    bytes,
  };
}

const NOT_FOUND = () => appText(404, "Not found.");

/** The path's segments after /app/, decoded; null when any segment is unsafe or does not decode. */
function segments(pathname: string): string[] | null {
  const rest = pathname === "/app" ? "" : pathname.slice("/app/".length);
  const out: string[] = [];
  for (const raw of rest.split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (s === "." || s === ".." || /[/\\\0]/.test(s)) return null;
    if (s !== "") out.push(s);
  }
  return out;
}

async function realFile(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Answers one GET (or HEAD) under /app from `dir` (web/dist). */
export async function serveApp(dir: string, pathname: string): Promise<UiResponse> {
  const segs = segments(pathname);
  if (segs === null) return NOT_FOUND();

  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return appText(503, "The app is not built: run npm run build");
  }
  const index = await realFile(join(root, "index.html"));
  if (index === null) return appText(503, "The app is not built: run npm run build");
  const inside = (p: string) => p.startsWith(root + sep);

  if (segs.length > 0) {
    const target = resolve(root, ...segs);
    if (!inside(target) || segs.some((s) => s.startsWith("."))) return NOT_FOUND();
    const real = await realFile(target);
    if (real !== null) return inside(real) ? file(real, await readFile(real), segs[0] === "assets") : NOT_FOUND();
    if (segs[0] === "assets") return NOT_FOUND();
  }
  return file(index, await readFile(index), false);
}
