// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PausesView } from "../web/src/api.js";
import { localDateTime } from "../web/src/lib/format.js";

// tsconfig.test.json checks this file without JSX, so the pages are built with createElement and their .tsx
// module is loaded by a specifier the node check skips (as tests/ui-settings-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/pages.js";
const TASKS_MODULE = "../web/src/views/tasks.js";
const { HealthPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { HealthPage: FunctionComponent };
const { TasksPage } = (await import(/* @vite-ignore */ TASKS_MODULE)) as { TasksPage: FunctionComponent };

// Claim pauses (issue #291, design §5 Restarts and §9). On Health's Claim pauses tab: each pause in effect with when it
// ends and a "Resume now" button that posts to /api/v1/pauses/resume with the CSRF token; a refusal shows next to that
// button. On Tasks (design 09-dashboard-tasks): one Check row in Needs you per pause, by its plain name, with a relative
// time (local time on hover) and the same Resume now; no Claim pauses section and no CLI command.

const TOKEN = "tok_pause";
const ENDS = "2099-01-01T00:00:00.000Z";
const AT = "2026-11-19T16:20:54.200Z";
const PROBE = "2026-11-19T16:21:54.200Z";
let view: PausesView;
let actions: unknown[];
let posts: { url: string; init: RequestInit }[] = [];
let answer: { status: number; body: unknown };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pauseAction = (name: string, text: string, until: string) => ({ code: "claim_pause", text, command: `Resume now in Needs you on Tasks, or factory resume ${name}`, until, pause: name });

beforeEach(() => {
  posts = [];
  view = { pauses: [{ name: "rate_limit", ends_at: ENDS }, { name: "forge_auth", ends_at: ENDS }], csrf_token: TOKEN };
  actions = [pauseAction("model_stall", "Model not answering", PROBE), pauseAction("rate_limit", "Usage or rate limit", ENDS)];
  answer = { status: 200, body: { name: "rate_limit", ended: true, pauses: [] } };
  vi.useFakeTimers({ now: Date.parse(AT), toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      const name = JSON.parse(String(init.body)).name;
      if (answer.status === 200) {
        view = { ...view, pauses: view.pauses.filter((p) => p.name !== name) };
        actions = actions.filter((a) => (a as { pause: string }).pause !== name);
      }
      return json(answer.status, answer.body);
    }
    const path = url.split("?")[0];
    if (path === "/api/v1/pauses") return json(200, view);
    if (path === "/api/v1/health") return json(200, { checked_at: ENDS, checks: [] });
    if (path === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
    if (path === "/api/v1/overview") return json(200, { as_of: AT, stages: {}, needs_you: actions.length, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: actions, factory: { state: "running", rev: "0ff810f1234", target_rev: "0ff810f1234", child_pid: 1, since: AT, workers: 1, workers_source: "default", error: null, pending: [] } });
    if (path === "/api/v1/items") return json(200, { as_of: AT, total: 0, items: [], facets: { allStates: 0, state: {} }, counts: { open: 0, running: 0 } });
    if (path === "/api/v1/tasks") return json(200, { today_date: "2026-11-19", today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "tok", can_build: true, active_projects: [] });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(page: FunctionComponent, path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(page)));
}

describe("Health page claim pauses", () => {
  const show = () => {
    mount(HealthPage, "/app/health?tab=pauses");
    return screen.findByRole("list", { name: "Claim pauses" });
  };

  it("lists each active pause with its name, when it ends and a Resume now button", async () => {
    const list = await show();
    const items = [...list.querySelectorAll<HTMLElement>("li[data-pause]")];
    expect(items.map((li) => li.getAttribute("data-pause"))).toEqual(["rate_limit", "forge_auth"]);
    for (const li of items) {
      expect(li.textContent).toContain(ENDS);
      expect(within(li).getByRole("button", { name: "Resume now" })).toBeTruthy();
    }
  });

  it("Resume now posts the pause name with the CSRF token, and the pause leaves the list", async () => {
    const list = await show();
    const li = list.querySelector<HTMLElement>('li[data-pause="rate_limit"]')!;
    fireEvent.click(within(li).getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(list.querySelector('li[data-pause="rate_limit"]')).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/pauses/resume");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ name: "rate_limit" });
    expect(list.querySelector('li[data-pause="forge_auth"]')).not.toBeNull();
  });

  it("an error from the endpoint shows next to that button", async () => {
    answer = { status: 403, body: { error: "Resuming needs write permission (approve_spec): no_role." } };
    const list = await show();
    const li = list.querySelector<HTMLElement>('li[data-pause="forge_auth"]')!;
    fireEvent.click(within(li).getByRole("button", { name: "Resume now" }));
    const alert = await within(li).findByRole("alert");
    expect(alert.textContent).toContain("approve_spec");
    expect(within(list.querySelector<HTMLElement>('li[data-pause="rate_limit"]')!).queryByRole("alert")).toBeNull();
  });
});

describe("Tasks page claim pauses", () => {
  const show = async () => {
    mount(TasksPage, "/app/tasks");
    const check = await screen.findByRole("list", { name: "Check" });
    await waitFor(() => expect(within(check).getAllByRole("button", { name: "Resume now" })).toHaveLength(2));
    return check;
  };

  it("shows each pause once, as a Check row in Needs you: its plain name, a relative time with the local time on hover, and Resume now", async () => {
    const check = await show();
    const rows = [...check.querySelectorAll<HTMLElement>('li[data-check="claim_pause"]')];
    expect(rows.map((r) => r.getAttribute("data-pause"))).toEqual(["model_stall", "rate_limit"]);
    const stall = rows[0]!;
    expect(stall.textContent).toContain("Model not answering");
    const time = stall.querySelector("time")!;
    expect(time.textContent).toBe("next check in 1m");
    expect(time.getAttribute("title")).toBe(localDateTime(PROBE));
    expect(within(stall).getByRole("button", { name: "Resume now" })).toBeTruthy();
    // The button is the action: no CLI command, and no Claim pauses section or banner sentence besides.
    expect(stall.querySelector("code")).toBeNull();
    expect(screen.queryByRole("list", { name: "Claim pauses" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Claim pause|model_stall|factory resume|Paused:/);
    expect(document.body.textContent!.split("Model not answering")).toHaveLength(2);
  });

  it("Resume now posts the pause name with the CSRF token, then the row leaves Needs you", async () => {
    const check = await show();
    fireEvent.click(within(check.querySelector<HTMLElement>('li[data-pause="model_stall"]')!).getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(document.querySelector('li[data-pause="model_stall"]')).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/pauses/resume");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ name: "model_stall" });
    expect(document.querySelector('li[data-pause="rate_limit"]')).not.toBeNull();
  });

  it("a refusal shows beside that row's button", async () => {
    answer = { status: 403, body: { error: "Resuming needs write permission (approve_spec): no_role." } };
    const check = await show();
    const stall = check.querySelector<HTMLElement>('li[data-pause="model_stall"]')!;
    fireEvent.click(within(stall).getByRole("button", { name: "Resume now" }));
    expect((await within(stall).findByRole("alert")).textContent).toContain("approve_spec");
    expect(within(check.querySelector<HTMLElement>('li[data-pause="rate_limit"]')!).queryByRole("alert")).toBeNull();
  });

  it("with no pause in effect shows no pause row and no Claim pauses list", async () => {
    view = { pauses: [], csrf_token: TOKEN };
    actions = [];
    mount(TasksPage, "/app/tasks");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith("/api/v1/overview"))).toBe(true));
    expect(document.querySelector('li[data-check="claim_pause"]')).toBeNull();
    expect(screen.queryByRole("list", { name: "Claim pauses" })).toBeNull();
  });
});
