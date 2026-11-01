// HTML building for the status page. Every dynamic value goes through `esc` (text and attributes alike);
// links go through `href`, which accepts only http(s) URLs and site-relative paths.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escaped for both element text and double-quoted attribute values. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** An `<a>` element, or the plain escaped text when the URL is not http(s) or a site path. */
export function link(url: string | null, text: string): string {
  if (url === null || !isSafeUrl(url)) return esc(text);
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

function isSafeUrl(url: string): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Human duration: "3s", "4m 05s", "2h 03m", "unknown" for null or negative. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

/** Milliseconds from `from` to `to`; null when either is missing or unparsable. */
export function between(from: string | null, to: string | Date | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(from);
  const b = to instanceof Date ? to.getTime() : Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) ? null : b - a;
}

const STYLE = `
body{font:14px/1.4 system-ui,sans-serif;margin:1.5em;color:#222}
h1{font-size:1.4em}h2{font-size:1.15em;margin-top:1.6em}h3{font-size:1em;margin:.8em 0 .3em}
table{border-collapse:collapse;margin:.3em 0}th,td{border:1px solid #ccc;padding:.2em .5em;text-align:left;vertical-align:top}
th{background:#f4f4f4}tr.stale td{background:#fde2e2}.muted{color:#777}nav a{margin-right:.6em}
`;

/** A full page: meta refresh every 5 s, inline CSS only, no JavaScript. */
export function page(title: string, body: string): string {
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="5">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body>${body}</body></html>\n`
  );
}

/** A table with escaped-by-caller cells. `rowClass` per row, or null. */
export function table(headers: string[], rows: { cells: string[]; cls?: string | null }[], empty = "none"): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) => `<tr${r.cls ? ` class="${esc(r.cls)}"` : ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}
