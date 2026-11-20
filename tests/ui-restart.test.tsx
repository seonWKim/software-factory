// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The Restart app button (design 09-dashboard-item-commands): on a merged item's page when the item API lists a
// `restart` command (repo.restart_command set), it sends `restart` with no note, as `factory restart` does; the
// controller's reply shows beside it. No such row: no button. Nothing here starts a process: fetch is a fake.

const AT = "2026-11-19T00:00:00.000Z";
const ID = "wi_7a2f";
const row = (name: string, extra: object = {}) => ({ name, usage: name, description: name, allowed: true, reason: null, ...extra });
const merged = {
  id: ID, source: { type: "local", id: "local-1", link: "local:local-1" }, title: "Add TransferActor",
  stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null, tier: 2, loop_count: 0, restart_count: 0, token_cost: 0,
  change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 9, created_at: AT, updated_at: AT,
  merge: { enabled: false, reason: "not waiting for a merge" },
  why: { code: "done", reason_code: "merged", params: {}, alarms: [], holder_id: null, next_actor: "none", refs: [], ref_url: null },
};
const detail = (extra: object = {}) => ({
  as_of: AT, item: merged, timeline: [], runs: [], commands: [row("restart")], replies: [], spec: null, ...extra,
});

let body: Record<string, unknown>;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  body = detail();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ request_id: "app:1", seq: 1, command: "restart", work_item_id: ID }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const bodies: Record<string, unknown> = {
      [`/api/v1/items/${ID}`]: body,
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
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

async function restartButton() {
  const button = (await screen.findByRole("button", { name: "Restart app" })) as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("item page: Restart app", () => {
  it("a merged item with a run command shows Restart app; pressing it sends `restart` with no note", async () => {
    mount();
    const button = await restartButton();
    expect(button.dataset.action).toBe("restart");
    expect(button.closest("[data-command]")?.getAttribute("data-command")).toBe("restart");
    fireEvent.click(button);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: `/api/v1/items/${ID}/commands`, body: { command: "restart" } });
  });

  it("the controller's reply shows beside it: queued once handled, or its refusal", async () => {
    body = detail({ replies: [{ seq: 4, command: "restart", created_at: AT, handled_at: AT, refusal: null }] });
    const first = mount();
    await restartButton();
    expect(await screen.findByText("Restart queued; its result is posted in the thread")).not.toBeNull();
    first.unmount();
    body = detail({ replies: [{ seq: 5, command: "restart", created_at: AT, handled_at: AT, refusal: "`restart` was not applied: the item is not merged into the base." }] });
    mount();
    await restartButton();
    expect(await screen.findByText(/the item is not merged into the base/)).not.toBeNull();
  });

  it("a viewer who may not send it sees it disabled with the reason", async () => {
    body = detail({ commands: [row("restart", { allowed: false, reason: "only the owner may send this command" })] });
    mount();
    const button = (await screen.findByRole("button", { name: "Restart app" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await screen.findByText(/only the owner may send this command/)).not.toBeNull();
  });

  it("no `restart` row (no run command, or not merged): no button", async () => {
    body = detail({ commands: [] });
    mount();
    await screen.findByRole("heading", { name: "Add TransferActor" });
    expect(screen.queryByRole("button", { name: "Restart app" })).toBeNull();
  });
});
