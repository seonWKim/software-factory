// HTML building for the status page. Every dynamic value goes through `esc` (text and attributes alike);
// links go through `href`, which accepts only http(s) URLs and site-relative paths. The page carries one
// constant inline <style> and one constant inline <script>; the CSP allows exactly those by hash.

import { createHash } from "node:crypto";

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
:root{--bg:#fff;--fg:#1f2328;--muted:#57606a;--line:#d0d7de;--head:#f6f8fa;--link:#0550ae;--bar:#ffffffee;
--ok-bg:#dafbe1;--ok-fg:#0a3622;--warn-bg:#fff8c5;--warn-fg:#4d2d00;--bad-bg:#ffebe9;--bad-fg:#67060c;
--info-bg:#ddf4ff;--info-fg:#0a3069;--idle-bg:#eaeef2;--idle-fg:#24292f;
--sp1:.25rem;--sp2:.5rem;--sp3:1rem;--radius:6px}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--head:#151b23;--link:#4493f8;--bar:#0d1117ee;
--ok-bg:#12351f;--ok-fg:#aff5b4;--warn-bg:#3a2e05;--warn-fg:#f8e3a1;--bad-bg:#42161a;--bad-fg:#ffdcd7;
--info-bg:#0c2d4f;--info-fg:#cae8ff;--idle-bg:#262c36;--idle-fg:#d1d7e0}}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{font:14px/1.45 system-ui,sans-serif;margin:0;color:var(--fg);background:var(--bg);font-variant-numeric:tabular-nums}
a{color:var(--link)}
main{padding:var(--sp3);max-width:100%}
h1{font-size:1.4em;margin:var(--sp2) 0}h2{font-size:1.15em;margin:1.4em 0 var(--sp2)}h3{font-size:1em;margin:.8em 0 .3em}
header.top{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;gap:var(--sp2) var(--sp3);align-items:center;
padding:var(--sp2) var(--sp3);background:var(--bar);border-bottom:1px solid var(--line)}
header.top .home{font-weight:600;text-decoration:none;color:var(--fg)}
header.top .updated{color:var(--muted)}
button,input,select{font:inherit;color:inherit}
button,input[type=submit]{background:var(--head);border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp1) var(--sp2);cursor:pointer}
input[type=search],select{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp1) var(--sp2);max-width:100%}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;margin:var(--sp1) 0}
th,td{border:1px solid var(--line);padding:var(--sp1) var(--sp2);text-align:left;vertical-align:top}
th{background:var(--head)}
tr.stale td{background:var(--bad-bg);color:var(--bad-fg)}
.muted{color:var(--muted)}nav a{margin-right:.6em}
.strip{display:flex;flex-wrap:wrap;gap:var(--sp3)}
.strip table{margin:0}
form.filters{display:flex;flex-wrap:wrap;gap:var(--sp2) var(--sp3);align-items:end}
form.filters label{display:flex;flex-direction:column;gap:2px;color:var(--muted)}
form.filters label.check{flex-direction:row;align-items:center;gap:var(--sp1);color:var(--fg)}
.title{display:block;max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;border-radius:var(--radius);padding:0 var(--sp1);margin:0 2px 2px 0;white-space:nowrap;background:var(--idle-bg);color:var(--idle-fg)}
.l-ready_to_merge{background:var(--ok-bg);color:var(--ok-fg)}
.l-needs_approval,.l-needs_human{background:var(--warn-bg);color:var(--warn-fg)}
.l-stuck{background:var(--bad-bg);color:var(--bad-fg)}
.l-running,.l-queued{background:var(--info-bg);color:var(--info-fg)}
tr.changed{animation:flash 180ms ease-out}
@keyframes flash{from{opacity:.35}to{opacity:1}}
@media (prefers-reduced-motion:reduce){tr.changed{animation:none}}
`;

/**
 * Refreshes the page in place every 5 s while the tab is visible: fetches the same URL, and replaces only the
 * <main> sections whose HTML changed, keeping scroll, open details, form values and focus. Pauses while hidden.
 */
const SCRIPT = `(function(){
var PERIOD=5000,last=Date.now(),timer=null,busy=false;
var ago=document.getElementById("ago"),btn=document.getElementById("refresh");
function tick(){if(ago)ago.textContent=Math.max(0,Math.floor((Date.now()-last)/1000))+"s";}
function sigs(root){var m={};root.querySelectorAll("tr[data-key]").forEach(function(r){m[r.getAttribute("data-key")]=r.getAttribute("data-sig");});return m;}
function swap(doc){
var y=window.scrollY,act=document.activeElement,actId=act&&(act.id||act.name),sel=null;
if(act&&typeof act.selectionStart==="number"){try{sel=[act.selectionStart,act.selectionEnd];}catch(e){}}
var open=[];document.querySelectorAll("details[id][open]").forEach(function(d){open.push(d.id);});
var vals={};document.querySelectorAll("main input[name],main select[name]").forEach(function(c){vals[c.name]=c.type==="checkbox"?c.checked:c.value;});
var before=sigs(document);
doc.querySelectorAll("main > section[id]").forEach(function(s){
var cur=document.getElementById(s.id);
if(cur&&cur.innerHTML!==s.innerHTML){cur.innerHTML=s.innerHTML;}
});
var after=sigs(document);
document.querySelectorAll("tr[data-key]").forEach(function(r){var k=r.getAttribute("data-key");if(k in before&&before[k]!==after[k])r.classList.add("changed");});
open.forEach(function(id){var d=document.getElementById(id);if(d)d.open=true;});
document.querySelectorAll("main input[name],main select[name]").forEach(function(c){if(c.name in vals){if(c.type==="checkbox")c.checked=vals[c.name];else c.value=vals[c.name];}});
if(actId){var n=document.getElementById(actId)||document.querySelector("main [name='"+actId+"']");if(n&&n!==document.activeElement){n.focus({preventScroll:true});if(sel&&typeof n.setSelectionRange==="function"){try{n.setSelectionRange(sel[0],sel[1]);}catch(e){}}}}
if(doc.title)document.title=doc.title;
window.scrollTo(0,y);
}
function refresh(){
if(busy||document.hidden)return;busy=true;
fetch(location.href,{cache:"no-store",credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.text();})
.then(function(t){swap(new DOMParser().parseFromString(t,"text/html"));last=Date.now();tick();})
.catch(function(){}).then(function(){busy=false;});
}
function start(){stop();timer=setInterval(refresh,PERIOD);}
function stop(){if(timer!==null){clearInterval(timer);timer=null;}}
document.addEventListener("visibilitychange",function(){if(document.hidden){stop();}else{refresh();start();}});
if(btn){btn.hidden=false;btn.addEventListener("click",refresh);}
setInterval(tick,1000);
if(!document.hidden)start();
})();`;

function sha256(text: string): string {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/** CSP sources for the page's one inline style and one inline script. */
export const STYLE_HASH = sha256(STYLE);
export const SCRIPT_HASH = sha256(SCRIPT);

/**
 * A full page: a sticky top bar (updated N s ago, refresh button, noscript Refresh link), the body in <main>,
 * the inline CSS and the refresh script. `self` is the site path of this page (the noscript link).
 */
export function page(title: string, body: string, self = "/"): string {
  const href = self.startsWith("/") && !self.startsWith("//") ? self : "/";
  const bar =
    `<header class="top"><a class="home" href="/">software-factory</a>` +
    `<span class="updated">updated <span id="ago">0s</span> ago</span>` +
    `<button type="button" id="refresh" aria-label="Refresh now" title="Refresh now" hidden>&#8635;</button>` +
    `<noscript><a href="${esc(href)}">Refresh</a></noscript></header>`;
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body>${bar}<main>${body}</main><script>${SCRIPT}</script></body></html>\n`
  );
}

export interface Row {
  cells: string[];
  cls?: string | null;
  /** Extra attributes, already escaped by the caller: ` data-key="…"`. */
  attrs?: string;
}

/** A table with escaped-by-caller cells, inside a box that scrolls sideways on narrow screens. */
export function table(headers: string[], rows: Row[], empty = "none"): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  const head = `<thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>`;
  const body = rows
    .map((r) => `<tr${r.cls ? ` class="${esc(r.cls)}"` : ""}${r.attrs ?? ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="scroll"><table>${head}<tbody>${body}</tbody></table></div>`;
}

/** Two-column key/value table with row headers. Values are escaped by the caller. */
export function facts(rows: [string, string][]): string {
  return `<div class="scroll"><table><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table></div>`;
}
