// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Run next button (design 05-coordination, 2026-11-22): on the item page of an item with a queued run, a secondary
// button in the row with the "…" menu; it sends `run-next` with no note, as `factory run-next` does, and the
// controller's reply shows beside it. No queued run: no button. Nothing here reaches a server: fetch is a fake.

const AT = "2026-11-22T00:00:00.000Z";
const ID = "wi_7a2f";
const queuedItem = {
  id: ID, source: { type: "local", id: "local-1", link: "local:local-1" }, title: "Add TransferActor",
  stage: "RUNNING", close_reason: null, blocked_on: "none", blocked_reason: null, tier: 2, loop_count: 0, restart_count: 0, token_cost: 0,
  change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3, created_at: AT, updated_at: AT,
  merge: { enabled: false, reason: "not waiting for a merge" },
  why: { code: "queued", reason_code: "queued_at", params: { position: 7 }, alarms: [], holder_id: null, next_actor: "factory", refs: [], ref_url: null },
};
const run = (status: string) => ({ id: "run_1", kind: "implement", status, attempt: 0, started_at: null, finished_at: null, created_at: AT, tokens: null, error: null, attempts: [] });
const detail = (extra: object = {}) => ({ as_of: AT, item: queuedItem, timeline: [], runs: [run("queued")], commands: [], replies: [], spec: null, ...extra });

let body: Record<string, unknown>;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  body = detail();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ request_id: "app:1", seq: 1, command: "run-next", work_item_id: ID }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const bodies: Record<string, unknown> = {
      [`/api/v1/items/${ID}`]: body,
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 1, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
    };
    const out = bodies[path];
    if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  history.replaceState(null, "", `/app/items/${ID}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

describe("item page: Run next", () => {
  it("an item with a queued run shows Run next, a secondary button; pressing it sends `run-next` with no note", async () => {
    mount();
    const button = (await screen.findByRole("button", { name: "Run next" })) as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.dataset.action).toBe("run-next");
    expect(button.closest("[data-item-menu]")).not.toBeNull();
    fireEvent.click(button);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: `/api/v1/items/${ID}/commands`, body: { command: "run-next" } });
  });

  it("the controller's reply shows beside it: moved once handled, or its refusal", async () => {
    body = detail({ replies: [{ seq: 4, command: "run-next", created_at: AT, handled_at: AT, refusal: null }] });
    const first = mount();
    expect(await screen.findByText("Moved to the front of the queue")).toBeTruthy();
    first.unmount();
    body = detail({ replies: [{ seq: 5, command: "run-next", created_at: AT, handled_at: AT, refusal: "`run-next` was not applied: the item has no queued run, so nothing changed." }] });
    mount();
    expect(await screen.findByText(/the item has no queued run, so nothing changed/)).toBeTruthy();
  });

  it("an item with no queued run has no Run next", async () => {
    body = detail({ runs: [run("running")] });
    mount();
    await screen.findByText("Add TransferActor");
    expect(screen.queryByRole("button", { name: "Run next" })).toBeNull();
  });
});
