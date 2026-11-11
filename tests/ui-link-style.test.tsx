// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { LINK_CLASS } from "../web/src/components/ui/link-style.js";
import { ItemsTable } from "../web/src/views/common.js";

// The shared link style (issue #270): every link in the views renders LINK_CLASS, except the sidebar.

const AT = "2026-11-07T00:00:00.000Z";
const row = (n: number, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title: `Title ${n}`, level: "needs_approval",
  badges: [], stage: "READY", tier: 2, kind: null, blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 },
  issue: { number: n, url: `https://github.com/o/r/issues/${n}` }, ...extra,
});
const withPr = row(1, { change_ref: "9", change_url: "https://github.com/o/r/pull/9" });
const overview = {
  as_of: AT, stages: {}, needs_you: 1, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 },
  plugins: { issues: "github" },
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": overview,
  "/api/v1/items": { as_of: AT, total: 1, items: [withPr], facets: { allStates: 1, state: { needs: 1, needs_approval: 1 } } },
  "/api/v1/items/wi_1": {
    as_of: AT, item: { ...withPr, loop_count: 0, restart_count: 0, token_cost: 0, created_at: AT }, timeline: [], runs: [],
  },
  "/api/v1/runs": { as_of: AT, runs: [] },
  "/api/v1/queue": { as_of: AT, queue: [] },
  "/api/v1/data/tables": { as_of: AT, tables: [{ name: "work_items", rows: 1, columns: ["id"], hidden: [] }] },
  "/api/v1/data/tables/work_items": {
    as_of: AT, table: "work_items", columns: ["id"], hidden: [], order_by: ["id"], filter: null, total: 1, page: 1, limit: 50, run_items: {},
    rows: [{ id: "wi_1" }],
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountAt(path: string, ready: string) {
  history.replaceState(null, "", `/app/${path}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findAllByText(ready);
  return out;
}
/** The links outside the sidebar navigation. */
function contentLinks(root: HTMLElement): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => !a.closest("nav") && a.dataset.testid !== "needs-you");
}
function expectShared(links: HTMLAnchorElement[]) {
  expect(links.length).toBeGreaterThan(0);
  for (const a of links) expect(a.className.split(/\s+/), a.outerHTML).toEqual(expect.arrayContaining(LINK_CLASS.split(" ")));
}

describe("shared link style", () => {
  it("is applied to every link on the Floor, Work items, an item page and Data", async () => {
    for (const [path, ready] of [["", "Title 1"], ["items", "Title 1"], ["items/wi_1", "Title 1"], ["data", "work_items"]] as const) {
      const { container } = await mountAt(path, ready);
      if (path === "data") { fireEvent.click((await screen.findAllByText("work_items"))[0]!); await screen.findAllByText("wi_1"); }
      expectShared(contentLinks(container));
      cleanup();
    }
  });

  it("keeps font-medium on titles and tabular-nums on the source link", async () => {
    const { container } = await mountAt("items", "Title 1");
    const title = screen.getAllByText("Title 1").map((e) => e.closest("a")).find(Boolean)!;
    expect(title.className).toContain("font-medium");
    cleanup();
    const page = await mountAt("items/wi_1", "Title 1");
    const source = contentLinks(page.container).find((a) => a.getAttribute("href") === "https://github.com/o/r/issues/1")!;
    expect(source.className).toContain("tabular-nums");
    expect(source.className).not.toContain("text-text-3");
  });

  it("leaves the sidebar links on their own classes", async () => {
    const { container } = await mountAt("items", "Title 1");
    const side = container.querySelector("nav")!;
    for (const a of side.querySelectorAll("a")) expect(a.className).not.toContain(LINK_CLASS);
  });

  it("renders a change_ref with no change_url, and the placeholder, as plain text", () => {
    const rows = [row(2, { issue: null, change_ref: "5", change_url: null })];
    const { container } = render(<ItemsTable items={rows} now={Date.parse(AT)} label="Needs you" empty="none" plugins={{ issues: "github" }} />);
    const cells = [...container.querySelectorAll("td")];
    const last = cells.slice(-2);
    expect(last.map((c) => c.textContent)).toEqual(["–", "#5"]);
    for (const c of last) expect(c.querySelector("a")).toBeNull();
    expect(last.map((c) => c.innerHTML).join()).not.toContain("accent");
  });

});

describe("no per-call-site link colour", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
  it("has no text-accent class in web/src/views", () => {
    for (const f of walk("web/src/views")) expect(readFileSync(f, "utf8"), f).not.toMatch(/text-accent/);
  });
  it("has the style in link-style.ts alone, as a token class", () => {
    expect(LINK_CLASS).toContain("text-accent");
  });
});

describe("contrast", () => {
  const css = readFileSync("web/src/tokens.css", "utf8");
  const token = (block: string, name: string) => new RegExp(`${block} \\{[^}]*--${name}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`).exec(css)!.slice(1).map(Number) as [number, number, number];
  // oklch to linear sRGB (Ottosson), then WCAG relative luminance.
  const lum = ([l, c, h]: [number, number, number]) => {
    const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180), L = l / 100;
    const [l_, m_, s_] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((x) => x ** 3);
    const [r, g, bl] = [
      4.0767416621 * l_! - 3.3077115913 * m_! + 0.2309699292 * s_!,
      -1.2684380046 * l_! + 2.6097574011 * m_! - 0.3413193965 * s_!,
      -0.0041960863 * l_! - 0.7034186147 * m_! + 1.707614701 * s_!,
    ].map((x) => Math.min(1, Math.max(0, x)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  it("is at least 4.5:1 in light and dark", () => {
    for (const block of [":root", "\\.dark"]) {
      for (const ground of ["surface", "bg"]) expect(ratio(token(block, "accent"), token(block, ground)), `${block} ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
