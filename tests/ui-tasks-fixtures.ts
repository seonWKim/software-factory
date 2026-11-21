// Shared builders, fetch stub and state for the Tasks page tests (tests/ui-tasks-*.test.tsx). Tests read and write the
// state as s.current, s.posts and so on, because an ES import cannot be reassigned. This file holds no test, so vitest's
// include glob does not pick it up.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { expect, vi } from "vitest";
import type { ItemRow, TaskRow, TasksView } from "../web/src/api.js";

// tsconfig.test.json checks the tests without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/tasks.js";
export const { TasksPage, dayLabel } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { TasksPage: FunctionComponent; dayLabel: (date: string) => string };

export const TOKEN = "tok_tasks";
export const SLOW = { timeout: 5_000 };

export const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null, ...over,
});
export const view = (over: Partial<TasksView> = {}): TasksView => ({
  today_date: "2026-11-12",
  today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
  // The server's upcoming starts at today; the page shows the days after it.
  upcoming: [
    { date: "2026-11-12", tasks: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
    { date: "2026-11-13", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] },
  ],
  projects: [{ list: "home", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }, { list: null, tasks: [row("tk_built", { work_item_id: "wi_1" }), row("tk_inbox")] }],
  csrf_token: TOKEN,
  can_build: true,
  ...over,
});
export const item = (id: string, over: Partial<ItemRow> = {}): ItemRow => ({
  id, source: { type: "local", id: `local:${id}` }, title: `Work ${id}`, item_phase: "needs_you", reason_code: "person", stage: "REVIEW", tier: null, kind: null,
  blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null, since: "2026-11-12T00:00:00.000Z",
  updated_at: "2026-11-12T00:00:00.000Z", version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, commands: [], ...over,
} as ItemRow);
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = { status: number; body: unknown };
/** The state the fetch stub answers from; a test sets its fields (s.current = view(...)). */
export const s: {
  current: TasksView;
  /** GET /api/v1/tasks?project=<slug>'s answer by slug (the project switcher); an unlisted slug answers 404. */
  filtered: Record<string, TasksView>;
  items: ItemRow[];
  posts: { url: string; init: RequestInit }[];
  answer: Answer;
  /** The item commands POSTs' answers in order (the last repeats); empty: `answer`. */
  commandAnswers: Answer[];
  /** The csrf_token of each GET /api/v1/session, in order (the last repeats). */
  sessionTokens: string[];
  sessionReads: number;
} = { current: view(), filtered: {}, items: [], posts: [], answer: { status: 200, body: {} }, commandAnswers: [], sessionTokens: [], sessionReads: 0 };

/** beforeEach: fresh state and the fetch stub. */
export function reset() {
  s.current = view();
  s.filtered = {};
  history.replaceState(null, "", "/app/tasks");
  s.items = [];
  s.posts = [];
  s.answer = { status: 200, body: { task_id: "tk_now", work_item_id: "wi_9", created: true } };
  s.commandAnswers = [];
  s.sessionTokens = [TOKEN];
  s.sessionReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      s.posts.push({ url, init });
      const commands = s.posts.filter((p) => p.url.endsWith("/commands")).length;
      const a = url.endsWith("/commands") && s.commandAnswers.length > 0 ? s.commandAnswers[Math.min(commands, s.commandAnswers.length) - 1]! : s.answer;
      return json(a.status, a.body);
    }
    if (url === "/api/v1/session") {
      const token = s.sessionTokens[Math.min(s.sessionReads++, s.sessionTokens.length - 1)]!;
      return json(200, { as_of: "2026-11-12T00:00:00.000Z", csrf_token: token, commands_enabled: true, actor: "local:me", actor_source: "environment" });
    }
    if (url === "/api/v1/tasks") return json(200, s.current);
    if (url.startsWith("/api/v1/tasks?project=")) {
      const slug = decodeURIComponent(url.slice("/api/v1/tasks?project=".length));
      return s.filtered[slug] ? json(200, s.filtered[slug]) : json(404, { error: `no project "${slug}"` });
    }
    if (url === "/api/v1/items") return json(200, { as_of: "2026-11-12T00:00:00.000Z", total: s.items.length, items: s.items, facets: {}, counts: { open: 0, running: 1 } });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
    if (url === "/api/v1/overview") return json(200, { as_of: "2026-11-12T00:00:00.000Z", stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: [] });
    return json(404, { error: "Not found." });
  }));
}

/** afterEach: unmount and drop the stub. */
export function teardown() {
  cleanup();
  vi.unstubAllGlobals();
}

/** The page once its tasks show (for a view with no overdue group). */
export async function show2() {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
  await waitFor(() => expect(document.querySelector("[data-task]")).not.toBeNull(), SLOW);
}

export async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
  await screen.findByRole("list", { name: "Overdue" }, SLOW);
}

export const card = (id: string) => document.querySelector<HTMLElement>(`[data-task="${id}"]`)!;

/** Opens a row's "⋯" menu (every row action is in it, owner feedback 2026-11-20) and returns its items' labels. */
export function menuItems(row: HTMLElement): string[] {
  const more = row.querySelector<HTMLButtonElement>("[data-row-menu] [aria-haspopup=menu]")!;
  if (more.getAttribute("aria-expanded") !== "true") fireEvent.click(more);
  return [...row.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")].map((b) => b.textContent!);
}
/** Opens a row's "⋯" menu and chooses the item named `name`; returns that item. */
export function chooseMenu(row: HTMLElement, name: string): HTMLButtonElement {
  menuItems(row);
  const item = [...row.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")].find((b) => b.textContent === name);
  if (!item) throw new Error(`no menu item ${name} in ${row.getAttribute("data-task") ?? row.getAttribute("data-key")}`);
  fireEvent.click(item);
  return item;
}
