// The app under /app/ (design §9): static files from a built web/dist, its own CSP, the SPA fallback, no file
// outside web/dist (encoded .. included), the request guards, and a 503 while the app is not built. A temp
// directory stands in for web/dist; respond() is the server's whole request handling without a socket.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ItemDetail, type ItemRow, type MergeCheckView, API, mergeBlocked, mergeCheckLabel } from "../web/src/api.js";
// TS6142: tsconfig.test.json has no JSX, so these .tsx views stay untyped here; web/tsconfig.json checks them.
// @ts-expect-error -- see above
import { ItemsTable } from "../web/src/views/common.js";
// @ts-expect-error -- see above
import { ItemPage } from "../web/src/views/pages.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { APP_CSP, DEFAULT_APP_DIR, contentType } from "../src/ui/app.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond, wire } from "../src/ui/server.js";
import { newStore } from "./helpers/store.js";

const INDEX = `<!doctype html><html><head><script type="module" src="/app/assets/index-abc.js"></script><link rel="stylesheet" href="/app/assets/index-abc.css"></head><body><div id="root"></div></body></html>`;
const OUTSIDE = "outside-web-dist: must never be served";

/** A temp dir with dist/ (the built app) and, beside it, a file the server must never serve. */
function builtApp(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "sf-app-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('app');");
  writeFileSync(join(dist, "assets", "index-abc.css"), "body{color:#111}");
  writeFileSync(join(dist, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dist, "assets", "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]));
  writeFileSync(join(dist, "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(dist, ".env"), OUTSIDE);
  writeFileSync(join(root, "secret.txt"), OUTSIDE);
  symlinkSync(join(root, "secret.txt"), join(dist, "assets", "link.txt"));
  return { root, dist };
}

async function deps(appDir: string): Promise<UiDeps> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  return {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 60_000,
    prUrl: (p, n) => `https://github.com/${p}/pull/${n}`,
    health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], clock),
    appDir,
  };
}

function get(d: UiDeps, path: string, opts: { method?: string; host?: string } = {}): Promise<UiResponse> {
  return respond(d, { method: opts.method ?? "GET", url: path, host: opts.host ?? "127.0.0.1:4310" });
}

const text = (r: UiResponse) => wire(r, false).body.toString("utf8");

describe("ui app: serving web/dist", () => {
  it("/app, /app/ and any client route return index.html", async () => {
    const d = await deps(builtApp().dist);
    for (const path of ["/app", "/app/", "/app/items", "/app/items/wi_123", "/app/workers/", "/app/a/b/c?x=1", "/app/index.html", "/app/settings.page"]) {
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"], path).toBe("text/html; charset=utf-8");
      expect(r.headers["cache-control"], path).toBe("no-store");
      expect(text(r), path).toBe(INDEX);
    }
  });

  it("files under /app/assets/ come back with their content type", async () => {
    const d = await deps(builtApp().dist);
    const cases: [string, string, string | Buffer][] = [
      ["/app/assets/index-abc.js", "text/javascript; charset=utf-8", "console.log('app');"],
      ["/app/assets/index-abc.css", "text/css; charset=utf-8", "body{color:#111}"],
      ["/app/assets/logo.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
      ["/app/assets/font.woff2", "font/woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff])],
      ["/app/favicon.ico", "image/x-icon", Buffer.from([0, 0, 1, 0])],
    ];
    for (const [path, type, body] of cases) {
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"], path).toBe(type);
      expect(wire(r, false).body.equals(Buffer.from(body)), path).toBe(true);
    }
    expect((await get(d, "/app/assets/index-abc.js")).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(contentType("x.unknown")).toBe("application/octet-stream");
  });

  it("a missing asset is 404, not index.html", async () => {
    const d = await deps(builtApp().dist);
    const r = await get(d, "/app/assets/nope.js");
    expect(r.status).toBe(404);
    expect(text(r)).not.toContain("<div id=\"root\">");
  });

  it("nothing outside web/dist is served, encoded .. and symlinks included, and dotfiles are not served", async () => {
    const d = await deps(builtApp().dist);
    const paths = [
      "/app/..%2fsecret.txt",
      "/app/assets/..%2f..%2fsecret.txt",
      "/app/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/app/%2e%2e/secret.txt",
      "/app/assets/%2e%2e/%2e%2e/secret.txt",
      "/app/..%5csecret.txt",
      "/app/assets/..%5c..%5csecret.txt",
      "/app/%2fetc%2fpasswd",
      "/app/assets/%00",
      "/app/assets/link.txt",
      "/app/.env",
      "/app/%E0%A4%A",
      "/app/../secret.txt",
      "/app/assets/../../secret.txt",
    ];
    for (const path of paths) {
      const r = await get(d, path);
      expect(r.status, path).toBe(404);
      expect(text(r), path).not.toContain(OUTSIDE);
    }
  });

  it("HEAD gives the same status and headers as GET with no body", async () => {
    const d = await deps(builtApp().dist);
    for (const path of ["/app/", "/app/assets/index-abc.js", "/app/assets/nope.js"]) {
      const g = wire(await get(d, path), false);
      const h = wire(await get(d, path, { method: "HEAD" }), true);
      expect([h.status, h.headers], path).toEqual([g.status, g.headers]);
      expect(h.body.length).toBe(0);
    }
  });
});

describe("ui app: CSP and guards", () => {
  it("every /app response carries the app's CSP: 'self' only, no unsafe-inline, no hash", async () => {
    expect(APP_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(APP_CSP).not.toMatch(/unsafe-inline|sha256-|unsafe-eval|https?:/);
    const d = await deps(builtApp().dist);
    for (const path of ["/app/", "/app/x", "/app/assets/index-abc.js", "/app/assets/nope.js", "/app/..%2fx"]) {
      const r = await get(d, path);
      expect(r.headers["content-security-policy"], path).toBe(APP_CSP);
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
    }
  });

  it("the HTML page keeps its hash-based CSP", async () => {
    const d = await deps(builtApp().dist);
    const csp = (await get(d, "/classic")).headers["content-security-policy"]!;
    expect(csp).toMatch(/^default-src 'none'; script-src 'sha256-[^']+'; style-src 'sha256-[^']+'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$/);
  });

  it("methods other than GET and HEAD get 405 with allow: GET, HEAD on /app and /api/v1", async () => {
    const d = await deps(builtApp().dist);
    for (const path of ["/app", "/app/", "/app/assets/index-abc.js", "/api/v1/overview", "/api/v1/nope"]) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
        const r = await get(d, path, { method });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe("GET, HEAD");
      }
    }
  });

  it("a Host other than 127.0.0.1 or localhost gets 403 on /app and /api/v1", async () => {
    const d = await deps(builtApp().dist);
    for (const path of ["/app/", "/app/assets/index-abc.js", "/api/v1/overview"]) {
      for (const host of ["evil.example", "evil.example:4310", "127.0.0.2", "localhost.evil", "[::1]:4310"]) {
        const r = await get(d, path, { host });
        expect(r.status, `${host} ${path}`).toBe(403);
        expect(text(r)).not.toContain("console.log");
      }
      expect((await get(d, path, { host: "localhost" })).status).toBe(200);
    }
  });
});

describe("ui app: not built", () => {
  it("without web/dist, /app/ is 503 'run npm run build' and / still works", async () => {
    const d = await deps(join(mkdtempSync(join(tmpdir(), "sf-app-")), "missing"));
    for (const path of ["/app", "/app/", "/app/items", "/app/assets/index-abc.js"]) {
      const r = await get(d, path);
      expect(r.status, path).toBe(503);
      expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(text(r)).toContain("run npm run build");
    }
    expect((await get(d, "/classic")).status).toBe(200);
    expect((await get(d, "/api/v1/overview")).status).toBe(200);
  });

  it("a web/dist without index.html is not built either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-app-"));
    mkdirSync(join(dir, "assets"));
    const d = await deps(dir);
    expect((await get(d, "/app/")).status).toBe(503);
  });

  it("by default the app is web/dist of this checkout", () => {
    expect(DEFAULT_APP_DIR.replace(/\\/g, "/")).toMatch(/\/web\/dist\/?$/);
    expect(DEFAULT_APP_DIR).not.toMatch(/\/src\/web\//);
  });
});

// The ready-to-merge row label and the item page's merge check detail (design §5 Merge check, issue #248),
// rendered to static markup in the node environment.
describe("ui app: merge check labels", () => {
  const AT = "2026-11-07T00:00:00.000Z";
  const BASE = "b".repeat(40);
  const check = (state: MergeCheckView["state"], conflicts: string[] = []): MergeCheckView =>
    ({ state, conflicts, head_sha: state === "checking" ? null : "a".repeat(40), base_sha: state === "checking" ? null : BASE, checked_at: state === "checking" ? null : AT });
  const row = (id: string, merge_check: MergeCheckView | null): ItemRow => ({
    id, source: { type: "github_issue", id: `o/r#${id}`, link: "https://example.invalid/1" }, title: `Item ${id}`, level: "ready_to_merge", badges: [],
    stage: "REVIEW", tier: 2, kind: null, blocked_on: "human", blocked_reason: "merge_pending", close_reason: null, run_status: null, pr_number: 1,
    pr_url: null, issue: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, merge_check,
  });

  it("the row shows Mergeable, Conflicts: N files with the names on hover, or Checking… next to its state", () => {
    const html = renderToStaticMarkup(createElement(ItemsTable, {
      items: [row("1", check("mergeable")), row("2", check("conflicts", ["src/a.ts", "docs/b.md"])), row("3", check("checking")), row("4", null)],
      now: Date.parse(AT), label: "Needs you", empty: "none",
    }));
    const cell = (id: string) => html.slice(html.indexOf(`data-key="${id}"`), html.indexOf("</tr>", html.indexOf(`data-key="${id}"`)));
    expect(cell("1")).toContain("Mergeable");
    expect(cell("2")).toContain("Conflicts: 2 files");
    expect(cell("2")).toContain('title="src/a.ts\ndocs/b.md"');
    expect(cell("3")).toContain("Checking…");
    expect(cell("4")).not.toContain("data-merge-check");
    expect(cell("1").indexOf("Ready to merge")).toBeLessThan(cell("1").indexOf("Mergeable"));
  });

  it("labels count files and the Merge button is disabled while conflicts or checking", () => {
    expect(mergeCheckLabel(check("conflicts", ["x"]))).toBe("Conflicts: 1 file");
    expect(mergeBlocked(check("conflicts", ["x"]))).toBe(true);
    expect(mergeBlocked(check("checking"))).toBe(true);
    expect(mergeBlocked(check("mergeable"))).toBe(false);
    expect(mergeBlocked(null)).toBe(false);
  });

  it("the item page shows the conflicting files, the base sha it was checked against and when", () => {
    const detail: ItemDetail = {
      as_of: AT,
      item: {
        id: "wi_1", source: { type: "github_issue", id: "o/r#1", link: "https://example.invalid/1" }, title: "Item", stage: "REVIEW", close_reason: null,
        blocked_on: "human", blocked_reason: "merge_pending", tier: 2, loop_count: 0, restart_count: 0, token_cost: 0, pr_number: 1, pr_url: null,
        version: 1, created_at: AT, updated_at: AT, merge_check: check("conflicts", ["src/a.ts", "docs/b.md"]),
      },
      timeline: [],
      runs: [],
    };
    const client = new QueryClient();
    client.setQueryData([API.item("wi_1")], detail);
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ItemPage, { id: "wi_1" })));
    expect(html).toContain("Merge check");
    expect(html).toContain("Conflicts: 2 files");
    expect(html).toContain("<li>src/a.ts</li>");
    expect(html).toContain("<li>docs/b.md</li>");
    expect(html).toContain(BASE.slice(0, 12));
    expect(html).toContain(`title="${BASE}"`);
    expect(html).toMatch(/checked \S+ ago/);
  });
});

// The item page's command buttons (design §9, issue #228), rendered to static markup in the node environment.
describe("ui app: item commands markup", () => {
  it("the item page has a button per command, in order, and the note box for revise and reject", () => {
    const AT = "2026-11-07T00:00:00.000Z";
    const names = ["approve", "revise", "reject"];
    const detail: ItemDetail = {
      as_of: AT,
      item: {
        id: "wi_1", source: { type: "local", id: "wi_1", link: "https://example.invalid/1" }, title: "Item", stage: "READY", close_reason: null,
        blocked_on: "human", blocked_reason: "spec_approval", tier: 2, loop_count: 0, restart_count: 0, token_cost: 0, pr_number: null, pr_url: null,
        version: 1, created_at: AT, updated_at: AT, merge_check: null,
      },
      timeline: [],
      runs: [],
      commands: names.map((name) => ({ name, usage: `/${name}`, description: name })),
      replies: [],
    };
    const client = new QueryClient();
    client.setQueryData([API.item("wi_1")], detail);
    client.setQueryData([API.session], { as_of: AT, csrf_token: "t", commands_enabled: true });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ItemPage, { id: "wi_1" })));
    const buttons = [...html.matchAll(/<li data-command="([^"]+)"[^>]*><button[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
    expect(buttons).toEqual(names.map((n) => [n, n]));
    expect(html).toMatch(/<textarea aria-label="Note"/);
    // Blank box: revise and reject start disabled, approve does not.
    const tag = (n: string) => html.match(new RegExp(`<li data-command="${n}"[^>]*><button[^>]*>`))![0];
    expect(tag("revise")).toContain(" disabled=\"\"");
    expect(tag("reject")).toContain(" disabled=\"\"");
    expect(tag("approve")).not.toContain(" disabled=\"\"");
  });
});
