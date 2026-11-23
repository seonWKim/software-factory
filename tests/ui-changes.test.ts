// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The item page's Changes tab and the Merge check card's Re-check (design 09-dashboard-item), against a stubbed API:
// no server, no git. A ready item with a branch lists its changed files with their counts; choosing one shows its diff
// on the page; a withheld diff shows the marker and a long one a Truncated note. An item with no branch has no tab.
// Re-check shows only for a check older than the base and posts to its route with the CSRF token.

const AT = "2026-11-20T00:00:00.000Z";
const TOKEN = "tok_changes";
const why = { code: "human", reason_code: "person", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null };
const check = (recheck: boolean) => ({ state: "mergeable", conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40), checked_at: AT, recheck });
const detail = (id: string, extra: object) => ({
  as_of: AT,
  item: {
    id, source: { type: "local", id: `local-${id}`, link: `local:${id}` }, title: `Item ${id}`, stage: "REVIEW", close_reason: null, blocked_on: "human",
    blocked_reason: "merge_pending", tier: 1, loop_count: 0, restart_count: 0, token_cost: 0, change_ref: null, change_url: null, phases: [], version: 4,
    created_at: AT, updated_at: AT, item_phase: "ready_to_merge", reason_code: "person", why, merge: { enabled: true, reason: null }, ...extra,
  },
  timeline: [],
  runs: [],
});
const FILES = [
  { path: "src/a.ts", added: 3, removed: 1 },
  { path: "src/leak.ts", added: 1, removed: 0 },
  { path: "img/logo.png", added: null, removed: null },
];
const DIFFS: Record<string, object> = {
  "src/a.ts": { path: "src/a.ts", diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+new\n+more", withheld: false, truncated: true },
  "src/leak.ts": { path: "src/leak.ts", diff: "[withheld: github_token]", withheld: true, truncated: false },
};

let posts: { url: string; init: RequestInit }[] = [];
let items: Record<string, object> = {};

beforeEach(() => {
  posts = [];
  items = {
    "/api/v1/items/wi_ready": detail("wi_ready", { merge_check: check(true), has_changes: true }),
    "/api/v1/items/wi_fresh": detail("wi_fresh", { merge_check: check(false), has_changes: true }),
    "/api/v1/items/wi_nobranch": detail("wi_nobranch", { merge_check: null, has_changes: false, blocked_reason: "spec_pending", item_phase: "needs_approval" }),
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, init });
      return ok({ work_item_id: "wi_ready", cleared: true });
    }
    const [path, query] = url.split("?");
    if (path === "/api/v1/session") return ok({ as_of: AT, csrf_token: TOKEN, commands_enabled: true, actor: "local:me", actor_source: "environment" });
    if (path === "/api/v1/overview") return ok({ as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } });
    if (path === "/api/v1/items/wi_ready/changes") {
      const file = query ? DIFFS[new URLSearchParams(query).get("path")!] : undefined;
      return ok({ as_of: AT, head_sha: "a".repeat(40), base_sha: "b".repeat(40), files: FILES, ...(file ? { file } : {}) });
    }
    if (items[path!]) return ok(items[path!]);
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(App)));
}

describe("item page: Changes tab", () => {
  it("lists each changed file with its added and removed counts, and shows a chosen file's diff on the page", async () => {
    mount("/app/items/wi_ready");
    const tabs = await screen.findByRole("tablist", { name: "Item views" });
    // The tabs sit in the page toolbar right under the item's header (patterns.md, Page layout).
    expect(tabs.closest("[data-page-toolbar]")?.previousElementSibling?.querySelector("h1")).not.toBeNull();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Changes" }));
    expect(location.search).toBe("?tab=changes");
    const list = await screen.findByRole("list", { name: "Changed files" });
    const rows = [...list.querySelectorAll("li")];
    expect(rows.map((r) => r.dataset.file)).toEqual(["src/a.ts", "src/leak.ts", "img/logo.png"]);
    expect(rows.every((r) => r.hasAttribute("data-list-row"))).toBe(true);
    expect(rows[0]!.querySelector("[data-added]")!.textContent).toBe("+3");
    expect(rows[0]!.querySelector("[data-removed]")!.textContent).toBe("−1");
    expect(rows[2]!.textContent).toContain("binary");
    fireEvent.click(within(rows[0]!).getByRole("button"));
    const diff = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-diff]");
      if (!el) throw new Error("no diff yet");
      return el;
    });
    expect(diff.textContent).toContain("+new");
    expect(document.querySelector("[data-truncated]")!.textContent).toMatch(/^Truncated/);
    // The page stayed: same path, the item's Changes tab.
    expect(location.pathname).toBe("/app/items/wi_ready");
  });

  it("a withheld diff shows the withheld marker in place of its text, and its row stays", async () => {
    mount("/app/items/wi_ready?tab=changes");
    const list = await screen.findByRole("list", { name: "Changed files" });
    fireEvent.click(within(list.querySelector('[data-file="src/leak.ts"]')!).getByRole("button"));
    await waitFor(() => expect(document.querySelector("[data-diff][data-withheld]")?.textContent).toBe("[withheld: github_token]"));
    expect(list.querySelector('[data-file="src/leak.ts"]')).not.toBeNull();
  });

  it("an item with no branch shows no Changes tab", async () => {
    mount("/app/items/wi_nobranch?tab=changes");
    await screen.findByRole("heading", { name: "Item wi_nobranch" });
    expect(screen.queryByRole("tablist", { name: "Item views" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
  });
});

describe("item page: Re-check", () => {
  it("shows Re-check on a check older than the base and posts to its route with the CSRF token", async () => {
    mount("/app/items/wi_ready");
    const card = await screen.findByRole("region", { name: "Merge check" });
    const button = within(card).getByRole("button", { name: "Re-check" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/items/wi_ready/merge-check/recheck");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("shows no Re-check on a check newer than the base", async () => {
    mount("/app/items/wi_fresh");
    const card = await screen.findByRole("region", { name: "Merge check" });
    expect(within(card).queryByRole("button", { name: "Re-check" })).toBeNull();
  });
});
