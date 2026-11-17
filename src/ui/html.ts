// The error page shell (404 and the other HTML errors outside /api/v1 and /app): a status, one message and a
// link to the app. Every dynamic value goes through `esc`. The page carries one constant inline <style> and no
// script; the CSP allows exactly that style by hash.

import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

/** Escaped for both element text and double-quoted attribute values. */
function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** Where the error page's home link goes: the app. */
export const APP_HOME = "/app/";

// System colours only, so the page follows the browser's light or dark scheme.
const STYLE = `
html{color-scheme:light dark}
body{font:14px/1.45 system-ui,sans-serif;margin:0;background:Canvas;color:CanvasText}
header{padding:.5rem 1rem;border-bottom:1px solid GrayText}
header a{font-weight:600;text-decoration:none;color:inherit}
main{padding:1rem}
h1{font-size:1.4em;margin:.5rem 0}
`;

/** The CSP source for the error page's one inline style. */
export const STYLE_HASH = `sha256-${createHash("sha256").update(STYLE, "utf8").digest("base64")}`;

/** The error page for `status`: its number as the heading, `message` below, and a home link to the app. */
export function errorPage(status: number, message: string): string {
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(status)}</title><style>${STYLE}</style></head>` +
    `<body><header><a href="${APP_HOME}">software-factory</a></header>` +
    `<main><h1>${esc(status)}</h1><p>${esc(message)}</p></main></body></html>\n`
  );
}
