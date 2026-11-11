// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { VIEW_KEY } from "../web/src/views/tree.js";

// Readable names on every page (design 09-dashboard-app): items show their titles, the owner "you", workers
// "worker N"; a raw item ID (wi_…), a forge actor (github:<number>) or a host:pid string shows only inside a details
// or copy element. The Data page is exempt (decision 2): its cells are the raw table. Breadcrumbs and item links
// point to /app/items/<id>, never to a local: or other non-web address.

const AT = "2026-11-12T00:00:00.000Z";
const HOST = "mac-mini";
const LOCAL = "local-30331a68-38a4-4a4e-83ed-30c3d0b7a040";
const RAW = new RegExp(`\\bwi_[0-9a-z]+|\\bgithub:\\d+|${HOST}:\\d+`);

const gh = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
const local = { type: "local", id: LOCAL, link: `local:${LOCAL}` };
const why = (code: string, text: string) => ({ code, text, next_actor: "human", refs: [], ref_url: null });
const row = (id: string, source: object, level: string, title: string, extra: object = {}) => ({
  id, source, title, level, badges: [], stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null,
  run_status: null, change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
const ITEMS = [
  row("wi_spec1", gh(1), "needs_approval", "Spec waiting", {
    stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", need: { reason: "spec ready", anchor: null }, why: why("human", "Waiting for a person to approve the spec"),
    commands: ["approve", "reject", "revise"].map((name) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null })),
  }),
  row("wi_run2", gh(2), "running", "Being built", {
    why: why("running", "Running implement"), run: { kind: "implement", status: "running", attempt: 1, worker_id: `${HOST}:4242:0`, started_at: AT, position: null },
  }),
  row("wi_local3", local, "queued", "A local task", {
    why: why("queued", "Queued at position 1"), run: { kind: "implement", status: "queued", attempt: 0, worker_id: null, started_at: null, position: 1 },
  }),
];
const ITEM_DETAIL = {
  as_of: AT,
  item: {
    ...ITEMS[2], loop_count: 0, restart_count: 0, token_cost: 0, spec_comment_url: null, parent_id: null, phase: null, phases: [], created_at: AT,
  },
  timeline: [
    { version: 1, at: AT, actor: { kind: "user", id: "github:4711" }, reason: "intake", changes: {}, detail: null },
    { version: 2, at: AT, actor: { kind: "user", id: "local:me" }, reason: "approved", changes: {}, detail: null },
    { version: 3, at: AT, actor: { kind: "system", id: "system" }, reason: "claimed", changes: {}, detail: null },
  ],
  runs: [{ id: "run_x", kind: "implement", status: "failed", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 1, error: { code: "checks_failed", detail: null }, attempts: [{ attempt: 1, worker_id: `${HOST}:4242:1` }] }],
  sleeps: [{ worker_id: `${HOST}:4242:1`, woke_at: AT, gap_ms: 120_000, run_id: "run_x" }],
  thread: [],
  commands: [{ name: "retry", usage: "/retry", description: "retry", allowed: true, reason: null }],
  replies: [],
  spec: null,
};
const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": { as_of: AT, stages: { RUNNING: 3 }, needs_you: 1, running: 1, queued: 1, last_24h: { succeeded: 0, failed: 1, tokens: 0 }, system_actions: [] },
  "/api/v1/items": { as_of: AT, total: ITEMS.length, items: ITEMS, facets: { allStates: ITEMS.length, state: {} } },
  "/api/v1/items/wi_local3": ITEM_DETAIL,
  "/api/v1/runs": { as_of: AT, runs: [{ id: "run_a", status: "running", kind: "implement", work_item_id: "wi_run2", attempt: 1, owner: `${HOST}:4242:0`, heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT }] },
  "/api/v1/queue": { as_of: AT, queue: [{ position: 1, id: "run_b", kind: "implement", work_item_id: "wi_local3", attempt: 0, created_at: AT, not_before: null, why: why("queued", "Queued at position 1") }] },
  "/api/v1/pauses": { pauses: [], csrf_token: null },
  "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
  "/api/v1/workers": {
    as_of: AT, workers: [],
    processes: [{ process_id: `${HOST}:4242`, pid: 4242, host: HOST, slots: 2, max_slots: 4, busy: 1, idle: 1, index_base: 0, started_at: AT, reported_at: AT,
      runs: [{ id: "run_a", kind: "implement", work_item_id: "wi_run2", worker_id: `${HOST}:4242:0`, started_at: AT }] }],
  },
  "/api/v1/health": { checked_at: AT, checks: [{ status: "ok", msg: "store reachable" }], sleeps: [{ worker_id: `${HOST}:4242:2`, woke_at: AT, gap_ms: 90_000, run_id: null }] },
  "/api/v1/unreviewed-merges": { as_of: AT, merges: [{ project: "o/r", change_ref: "9", change_url: null, merge_sha: "abcdef1", merged_by: "github:4711", recorded_at: AT }] },
  "/api/v1/failures": {
    as_of: AT, window: "24h", cap: 500, total: 1, capped: false,
    groups: [{ code: "checks_failed", description: null, count: 1, last_seen: AT, items: 1, runs: [{ id: "run_x", work_item_id: "wi_local3", kind: "implement", attempt: 1, detail: "npm test", worker: `${HOST}:4242:1`, finished_at: AT }] }],
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = RESPONSES[url.split("?")[0]!];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  // Node's own experimental localStorage would otherwise shadow jsdom's.
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountAt(path: string, ready: string) {
  history.replaceState(null, "", `/app/${path}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findAllByText(ready);
  // Let every read of the page land before it is checked.
  await vi.waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeNull());
}

/** The text on the page that names a raw ID outside a details or copy element. */
function rawIds(): string[] {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.querySelector("main")!, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent ?? "";
    if (RAW.test(text) && !n.parentElement!.closest("details, [data-copy]")) out.push(text);
  }
  return out;
}

const PAGES: [string, string][] = [
  ["", "Spec waiting"],
  ["items", "Spec waiting"],
  ["items/wi_local3", "A local task"],
  ["workers", "Being built"],
  ["queue", "A local task"],
  ["health", "store reachable"],
  ["failures", "checks_failed"],
];

describe("raw IDs", () => {
  it.each(PAGES)("/app/%s renders no wi_ ID, github:<number> actor or host:pid outside a details or copy element", async (path, ready) => {
    await mountAt(path, ready);
    if (path === "failures") screen.getByRole("button", { expanded: false }).click();
    if (path === "failures") await screen.findByText("A local task");
    expect(rawIds()).toEqual([]);
  });

  it("the Work items list view too", async () => {
    localStorage.setItem(VIEW_KEY, "list");
    await mountAt("items", "Spec waiting");
    expect(rawIds()).toEqual([]);
  });

  it("the IDs stay one step away: in the item page's IDs details, with a Copy button", async () => {
    await mountAt("items/wi_local3", "A local task");
    const ids = document.querySelector("[data-ids]") as HTMLDetailsElement;
    expect(ids.tagName).toBe("DETAILS");
    expect(ids.textContent).toContain("wi_local3");
    expect(ids.textContent).toContain(LOCAL);
    expect(ids.querySelectorAll("[data-copy] button")).toHaveLength(2);
  });
});

describe("item links", () => {
  it("the breadcrumb and every item link point to /app/items/<id>; no link has a local: or other non-web address", async () => {
    await mountAt("items/wi_local3", "A local task");
    const crumbs = [...screen.getByRole("navigation", { name: "Breadcrumb" }).querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(crumbs).toEqual([["Work items", "/app/items"], ["30331a68", "/app/items/wi_local3"]]);
    for (const path of ["items/wi_local3", "items", ""]) {
      cleanup();
      await mountAt(path, path === "" ? "Spec waiting" : "A local task");
      const hrefs = [...document.querySelectorAll("main a")].map((a) => a.getAttribute("href")!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h, path).toMatch(/^(\/app\/|https?:\/\/)/);
    }
    // In the tree, the local item's short id links to its page.
    const short = screen.queryByText("30331a68");
    if (short) expect(short.closest("a")?.getAttribute("href")).toBe("/app/items/wi_local3");
  });

  it("titles link to the item page", async () => {
    await mountAt("", "Spec waiting");
    expect(screen.getByRole("link", { name: "Spec waiting" }).getAttribute("href")).toBe("/app/items/wi_spec1");
  });
});
