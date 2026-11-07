// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { HealthMonitor } from "../src/ui/health.js";
import { api } from "../src/ui/api.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { UserId, WorkItemPatch } from "../src/core/types.js";
import { cleanScanner, issueRef } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The Merge button (design §9, issue #246): only on ready-to-merge rows and items the API gives a `merge` view;
// its confirmation shows the title, tier, files and lines changed and the PR link; after confirming, the row shows
// "merging", then leaves Needs you once merged, or shows the refusal next to the button.

const AT = "2026-11-07T00:00:00.000Z";
const src = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
const MERGE = { pr_number: 42, pr_url: "https://github.com/o/r/pull/42", title: "Add the merge button", tier: 2, files: 3, lines: 120, replies: [] };
const CHECK = { state: "mergeable", conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40), checked_at: AT };
const row = (id: string, n: number, level: string, extra: object = {}) => ({
  id, source: src(n), title: `Item ${n}`, level, badges: [], stage: "REVIEW", tier: 2, kind: null, blocked_on: "human", blocked_reason: "merge_pending",
  close_reason: null, run_status: null, pr_number: 42, pr_url: "https://github.com/o/r/pull/42", issue: null, since: AT, updated_at: AT, version: 3,
  dependents: 0, conflicts: { automatic: 0, person: 0 }, merge_check: null, merge: null, ...extra,
});
const detail = (merge: object | null) => ({
  as_of: AT,
  item: {
    id: "wi_ready", source: src(1), title: "Add the merge button", stage: "REVIEW", close_reason: null, blocked_on: "human", blocked_reason: "merge_pending",
    tier: 2, loop_count: 0, restart_count: 0, token_cost: 0, pr_number: 42, pr_url: MERGE.pr_url, version: 3, created_at: AT, updated_at: AT, merge_check: CHECK,
  },
  timeline: [], runs: [], commands: [], replies: [], merge,
});

let items: { id: string; merge: object | null }[];
let mergeRequests: object[];
let posts: { url: string; body: unknown }[];
let details: Record<string, unknown>;

beforeEach(() => {
  history.replaceState(null, "", "/app/");
  posts = [];
  mergeRequests = [];
  items = [
    row("wi_ready", 1, "ready_to_merge", { merge_check: CHECK, merge: MERGE }),
    row("wi_spec", 2, "needs_approval", { stage: "READY", blocked_reason: "spec_pending", pr_number: null }),
  ];
  details = { "/api/v1/items/wi_ready": detail(MERGE), "/api/v1/items/wi_other": { ...detail(null), item: { ...detail(null).item, id: "wi_other" } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (init?.method === "POST") {
      posts.push({ url: path, body: JSON.parse(String(init.body)) });
      mergeRequests = [{ seq: 9, command: "merge", created_at: AT, handled_at: null, refusal: null }];
      return json({ request_id: "app:x", seq: 9, command: "merge", work_item_id: "wi_ready" }, 202);
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, plugins: { issues: "github", prs: "github" } },
      // The merge requests sent so far, as the server lists them on the row.
      "/api/v1/items": { as_of: AT, total: items.length, items: items.map((i) => (i.merge ? { ...i, merge: { ...i.merge, replies: mergeRequests } } : i)), facets: {} },
      "/api/v1/runs": { runs: [] },
      "/api/v1/queue": { queue: [] },
      "/api/v1/pauses": { as_of: AT, pauses: [], csrf_token: null },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true },
      ...details,
    };
    const body = bodies[path];
    return body === undefined ? json({ error: "Not found." }, 404) : json(body, 200);
  }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return client;
}

const needsYou = () => screen.findByRole("table", { name: "Needs you" });
const rowOf = (table: HTMLElement, id: string) => table.querySelector(`[data-key="${id}"]`) as HTMLElement | null;

describe("Merge button: where it shows", () => {
  it("shows on the ready-to-merge Floor row only, not on other rows", async () => {
    mount("/app/");
    const table = await needsYou();
    const ready = rowOf(table, "wi_ready")!;
    await waitFor(() => expect(within(ready).getByRole("button", { name: "Merge" })).toBeTruthy());
    expect(within(rowOf(table, "wi_spec")!).queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("shows on the item page of a ready item, and not on an item without a merge view", async () => {
    mount("/app/items/wi_ready");
    expect(await screen.findByRole("button", { name: "Merge" })).toBeTruthy();
    cleanup();
    mount("/app/items/wi_other");
    await screen.findByRole("heading", { name: "Add the merge button" });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });
});

describe("Merge button: confirm, then merging, then gone or refused", () => {
  it("the confirmation shows the title, tier, files and lines changed and the PR link; Cancel sends nothing", async () => {
    mount("/app/");
    const ready = rowOf(await needsYou(), "wi_ready")!;
    const button = await within(ready).findByRole("button", { name: "Merge" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    const dialog = within(ready).getByRole("dialog", { name: "Merge PR #42" });
    expect(dialog.querySelector("[data-merge-title]")!.textContent).toBe("Add the merge button");
    expect(dialog.querySelector("[data-merge-tier]")!.textContent).toBe("2");
    expect(dialog.querySelector("[data-merge-size]")!.textContent).toBe("3 files, 120 lines");
    expect(dialog.querySelector("[data-merge-pr]")!.getAttribute("href")).toBe("https://github.com/o/r/pull/42");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(ready).queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
  });

  it("after confirming, the row shows merging, then leaves Needs you once merged", async () => {
    const client = mount("/app/");
    const ready = rowOf(await needsYou(), "wi_ready")!;
    const button = await within(ready).findByRole("button", { name: "Merge" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    fireEvent.click(within(ready).getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_ready/commands", body: { command: "merge" } }]));
    await waitFor(() => expect(within(rowOf(screen.getByRole("table", { name: "Needs you" }), "wi_ready")!).getByRole("status").textContent).toBe("merging"));
    expect(within(rowOf(screen.getByRole("table", { name: "Needs you" }), "wi_ready")!).getByRole("button", { name: "Merge" }).hasAttribute("disabled")).toBe(true);

    // The controller merged: the item is closed, so it is no longer a Needs-you row.
    items = items.filter((i) => i.id !== "wi_ready");
    await client.invalidateQueries();
    await waitFor(() => expect(rowOf(screen.getByRole("table", { name: "Needs you" }), "wi_ready")).toBeNull());
  });

  it("a refusal shows its reason next to the button", async () => {
    const client = mount("/app/");
    const ready = rowOf(await needsYou(), "wi_ready")!;
    const button = await within(ready).findByRole("button", { name: "Merge" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    fireEvent.click(within(ready).getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const refusal = "`merge` was not applied: commits arrived after the reviewed head; they need a review before the PR can merge.";
    mergeRequests = [{ seq: 9, command: "merge", created_at: AT, handled_at: AT, refusal }];
    await client.invalidateQueries();
    await waitFor(() => expect(within(rowOf(screen.getByRole("table", { name: "Needs you" }), "wi_ready")!).getByRole("alert").textContent).toBe(refusal));
  });

  it("is disabled while the merge check finds conflicts", async () => {
    items = [row("wi_ready", 1, "ready_to_merge", { merge_check: { ...CHECK, state: "conflicts", conflicts: ["a.ts"] }, merge: MERGE })];
    mount("/app/");
    const button = await within(rowOf(await needsYou(), "wi_ready")!).findByRole("button", { name: "Merge" });
    await new Promise((r) => setTimeout(r, 50));
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("item API: the merge view", () => {
  const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, tier: 2, pr_files: ["a.ts", "b.ts"] };

  async function apiWith(merge: boolean | undefined) {
    const { store } = await newStore();
    const clock = new FakeClock(AT);
    const actor = { kind: "system" as const, id: "system:test" };
    const make = async (n: number, patch: WorkItemPatch) => {
      const { item } = await store.createWorkItem({ source: issueRef(n), title: `Item ${n}`, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
      const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "review_passed", patch, detail: { lines_changed: 40, files_changed: 2 } });
      if (!r.ok) throw new Error("setup failed");
      return r.item;
    };
    const ready = await make(1, READY);
    const spec = await make(2, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const commands = merge === undefined ? undefined : { actor: "github:1" as UserId, token: "t", merge };
    const d = {
      store, scanner: cleanScanner, clock, lease_ms: 60_000, prUrl: (label: string, n: number) => `https://${label}/pull/${n}`,
      health: new HealthMonitor(async () => [], clock), ...(commands ? { commands } : {}),
    };
    const get = async (path: string) => (await api(d as never, new URL(`http://127.0.0.1/api/v1${path}`))).value as Record<string, unknown>;
    return { ready, spec, get };
  }

  it("a ready factory PR gets title, tier, size and PR link when merging is on; other items get null", async () => {
    const h = await apiWith(true);
    const body = await h.get(`/items/${h.ready.id}`);
    expect(body.merge).toMatchObject({ pr_number: 42, title: "Item 1", tier: 2, files: 2, lines: 40, replies: [] });
    expect((await h.get(`/items/${h.spec.id}`)).merge).toBeNull();
    const rows = (await h.get("/items")).items as { id: string; merge: unknown }[];
    expect(rows.find((r) => r.id === h.ready.id)!.merge).toMatchObject({ pr_number: 42, lines: 40 });
    expect(rows.find((r) => r.id === h.spec.id)!.merge).toBeNull();
  });

  it("a project with no forge setting gets no merge view, so no button", async () => {
    for (const merge of [false, undefined]) {
      const h = await apiWith(merge);
      expect((await h.get(`/items/${h.ready.id}`)).merge).toBeNull();
      expect(((await h.get("/items")).items as { merge: unknown }[]).every((r) => r.merge === null)).toBe(true);
    }
  });
});
