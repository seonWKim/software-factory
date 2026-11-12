// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRow, TasksView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-rules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/tasks.js";
const { TasksPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { TasksPage: FunctionComponent };

// The Tasks page (design 02-tasks, issue #607): Inbox, Today (overdue first, in red), Upcoming (by day) and Project
// tabs over GET /api/v1/tasks, which places each task; Build this posts the task's ID once, a built task links to its item.

const TOKEN = "tok_tasks";
const SLOW = { timeout: 5_000 };

const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id, title: id, list: null, priority: null, due_date: null, due_time: null, recurrence: null, work_item_id: null, ...over,
});
const view = (over: Partial<TasksView> = {}): TasksView => ({
  today_date: "2026-11-12",
  inbox: [row("tk_inbox")],
  today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_now", { due_date: "2026-11-12", due_time: "09:00" })] },
  upcoming: [{ date: "2026-11-13", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }],
  projects: [{ list: "home", tasks: [row("tk_soon", { due_date: "2026-11-13", list: "home" })] }, { list: null, tasks: [row("tk_built", { work_item_id: "wi_1" })] }],
  csrf_token: TOKEN,
  can_build: true,
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current: TasksView;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = view();
  posts = [];
  answer = { status: 200, body: { task_id: "tk_now", work_item_id: "wi_9", created: true } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/tasks") return json(200, current);
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(TasksPage)));
  await screen.findByRole("list", { name: "Overdue" }, SLOW);
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-task="${id}"]`)!;
const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("Tasks page", () => {
  it("is a sidebar page at /app/tasks", () => {
    expect(routeFor("/app/tasks").page.label).toBe("Tasks");
    expect(PAGES.map((p) => p.path)).toContain("tasks");
  });

  it("the view picker is one segmented control in one row, Today selected first, the clicked view selected next", async () => {
    await show();
    const group = screen.getByRole("group", { name: "Task view" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Inbox", "Today", "Upcoming", "Project"]);
    expect(group.className.split(" ")).toContain("flex-nowrap");
    expect(group.className.split(" ")).not.toContain("flex-wrap");
    const selected = () => [...group.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent);
    expect(selected()).toEqual(["Today"]);
    tab("Project");
    expect(selected()).toEqual(["Project"]);
  });

  it("Today lists overdue tasks first, in red, then today's", async () => {
    await show();
    const cards = [...document.querySelectorAll<HTMLElement>("[data-task]")].map((e) => e.dataset.task);
    expect(cards).toEqual(["tk_late", "tk_now"]);
    expect(card("tk_late").hasAttribute("data-overdue")).toBe(true);
    expect(card("tk_late").querySelector("p")!.className).toContain("text-pill-bad-fg");
    expect(card("tk_late").textContent).toContain("Overdue");
    expect(card("tk_now").hasAttribute("data-overdue")).toBe(false);
    expect(card("tk_now").querySelector("p")!.className).not.toContain("text-pill-bad-fg");
  });

  it("Inbox, Upcoming and Project show their own tasks; a built task links to its work item instead of Build this", async () => {
    await show();
    tab("Inbox");
    expect(screen.getByRole("list", { name: "Inbox" }).textContent).toContain("tk_inbox");
    tab("Upcoming");
    expect(card("tk_soon").textContent).toContain("#home");
    expect(document.querySelectorAll("[data-task]")).toHaveLength(1);
    tab("Project");
    expect(screen.getByRole("list", { name: "#home" }).textContent).toContain("tk_soon");
    const built = within(screen.getByRole("list", { name: "No list" }));
    expect(built.getByRole("link", { name: "wi_1" }).getAttribute("href")).toBe("/app/items/wi_1");
    expect(built.queryByRole("button", { name: /Build this/ })).toBeNull();
  });

  it("Build this posts the task's ID with the token; a refusal stays beside the button", async () => {
    await show();
    fireEvent.click(within(card("tk_now")).getByRole("button", { name: "Build this: tk_now" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/tasks/build");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ id: "tk_now" });
    answer = { status: 409, body: { error: "no project is stored yet" } };
    fireEvent.click(within(card("tk_late")).getByRole("button", { name: "Build this: tk_late" }));
    expect((await within(card("tk_late")).findByRole("alert", undefined, SLOW)).textContent).toBe("no project is stored yet");
  });

  it("with no commands actor there is no Build this button", async () => {
    current = view({ can_build: false });
    await show();
    expect(screen.queryByRole("button", { name: /Build this/ })).toBeNull();
  });
});
